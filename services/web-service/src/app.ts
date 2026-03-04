import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import session from 'express-session';
import { Producer, Consumer } from 'kafkajs';
import path from 'path';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import RedisStore from 'connect-redis';
import { createDatabasePool } from './config/database';
import { createRedisClient } from './config/redis';
import { createKafkaClient } from './config/kafka';
import { setupWebSocketHandlers } from './services/webSocketService';
import { setupKafkaConsumer } from './services/kafkaConsumer';
import { createAuthRoutes } from './routes/auth';
import { createFileRoutes } from './routes/files';
import { createUploadRoutes } from './routes/upload';
import { ShareController } from './controllers/shareController';
import { requireAuth } from './middleware/auth';
import type { HealthCheckResponse } from './types/api';

const isProduction = process.env.NODE_ENV === 'production';

// Configuration — require critical env vars in production
const config = {
  port: process.env.PORT || 3001,
  storageServiceUrl: process.env.STORAGE_SERVICE_URL || 'http://localhost:8000',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL || (isProduction ? '' : 'postgresql://user:pass@localhost/edge_cloud'),
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  sessionSecret: process.env.SESSION_SECRET || (isProduction ? '' : 'dev-only-secret-not-for-production'),
};

// Validate required config in production
if (isProduction) {
  if (!config.sessionSecret) {
    console.error('FATAL: SESSION_SECRET environment variable is required in production');
    process.exit(1);
  }
  if (!config.postgresUrl) {
    console.error('FATAL: DATABASE_URL environment variable is required in production');
    process.exit(1);
  }
}

// Initialize Express
const app: Express = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true
  }
});

// Initialize Redis clients
const redisClient = createRedisClient({ url: config.redisUrl });  // For sessions
const redisCache = createRedisClient({ url: config.redisUrl });   // For caching
const redisSubscriber = createRedisClient({ url: config.redisUrl }); // For pub/sub

// PostgreSQL with optimized connection pool
const pgPool = createDatabasePool({
  connectionString: config.postgresUrl,
  max: 50,
  min: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false,
});

// Kafka setup
const kafka = createKafkaClient({
  clientId: 'web-service',
  brokers: config.kafkaBrokers
});

let kafkaProducer: Producer | null = null;
let kafkaConsumer: Consumer | null = null;
let kafkaConnected = false;

// Middleware
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: isProduction ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameSrc: ["'none'"],
    }
  } : false,
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static('public'));

// Session management
const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'session:'
});

const sessionMiddleware = session({
  store: redisStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(sessionMiddleware);

io.engine.use(sessionMiddleware);

// WebSocket connection handling
setupWebSocketHandlers(io);

// Utility function for retrying connections
async function retryConnection(
  fn: () => Promise<void>,
  serviceName: string,
  maxRetries = 10
): Promise<boolean> {
  let retries = 0;
  let delay = 1000; // Start with 1 second

  while (retries < maxRetries) {
    try {
      await fn();
      console.log(`[OK] ${serviceName} connected successfully`);
      return true;
    } catch (error) {
      retries++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`[WAIT] ${serviceName}... (attempt ${retries}/${maxRetries})`);
      if (retries === maxRetries) {
        throw new Error(`Failed to connect to ${serviceName} after ${maxRetries} attempts: ${errorMessage}`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000); // Max 10 seconds
    }
  }
  return false;
}

// Safe Kafka send function (exported for use in other modules)
export async function sendToKafka(topic: string, message: Record<string, unknown>): Promise<void> {
  if (!kafkaConnected || !kafkaProducer) {
    return;
  }

  try {
    await kafkaProducer.send({
      topic,
      messages: [{ value: JSON.stringify(message) }]
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to send to Kafka:', errorMessage);
  }
}

// Initialize services with retry logic
async function initializeServices(): Promise<void> {
  // PostgreSQL
  await retryConnection(async () => {
    const result = await pgPool.query('SELECT 1');
    if (!result) throw new Error('PostgreSQL not ready');
  }, 'PostgreSQL');

  // Redis
  await retryConnection(async () => {
    const pong = await redisClient.ping();
    if (pong !== 'PONG') throw new Error('Redis not responding');
  }, 'Redis');

  // Kafka
  await retryConnection(async () => {
    kafkaProducer = kafka.producer();
    kafkaConsumer = kafka.consumer({
      groupId: 'web-service-group',
      sessionTimeout: 45000,
      heartbeatInterval: 10000,
      rebalanceTimeout: 60000,
      maxBytesPerPartition: 1048576,  // 1MB
      maxWaitTimeInMs: 5000,
      retry: {
        initialRetryTime: 300,
        retries: 15,
        maxRetryTime: 30000,
        factor: 0.2,
        multiplier: 2,
        restartOnFailure: async (error) => {
          console.error('[Kafka] Consumer retry failure, restarting:', error.message);
          return true;
        },
      },
    });

    await kafkaProducer.connect();
    await kafkaConsumer.connect();

    await setupKafkaConsumer(kafkaConsumer, io);

    kafkaConnected = true;
  }, 'Kafka');
}

// Routes

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  const checks = {
    postgres: false,
    redis: false,
    kafka: kafkaConnected
  };

  try {
    await pgPool.query('SELECT 1');
    checks.postgres = true;
  } catch {
    // Service unavailable
  }

  try {
    await redisClient.ping();
    checks.redis = true;
  } catch {
    // Service unavailable
  }

  const allHealthy = Object.values(checks).every(v => v);

  const response: HealthCheckResponse = {
    status: allHealthy ? 'healthy' : 'degraded',
    services: checks,
    timestamp: new Date().toISOString()
  };

  res.status(allHealthy ? 200 : 503).json(response);
});

// Dashboard
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// API Routes
app.use('/api/auth', createAuthRoutes(pgPool, redisCache));
app.use('/api/files', createFileRoutes(config.storageServiceUrl));
app.use('/api/upload', createUploadRoutes(config.storageServiceUrl, redisCache, io, kafkaProducer));

// Share file route (using controller directly) — with auth middleware
const shareController = new ShareController(config.storageServiceUrl);
app.post('/api/share/:fileId', requireAuth, (req, res) => {
  void shareController.shareFile(req as Parameters<typeof shareController.shareFile>[0], res);
});

// SPA catch-all route - serve index.html for all non-API routes
app.get('*', (req: Request, res: Response, next: NextFunction) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize services on module load
async function start(): Promise<void> {
  try {
    console.log('[INFO] Initializing services...');
    await initializeServices();
    console.log('[OK] All services connected successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[FATAL] Failed to initialize services:', errorMessage);
    process.exit(1);
  }
}

// Start initialization
start();

// Graceful shutdown handler
export async function gracefulShutdown(): Promise<void> {
  console.log('[INFO] Shutting down gracefully...');

  // Close Kafka connections
  if (kafkaProducer) {
    await kafkaProducer.disconnect().catch(console.error);
  }
  if (kafkaConsumer) {
    await kafkaConsumer.disconnect().catch(console.error);
  }

  // Close Redis connections
  redisClient.disconnect();
  redisCache.disconnect();
  redisSubscriber.disconnect();

  // Close PostgreSQL pool
  await pgPool.end().catch(console.error);

  console.log('[INFO] Cleanup completed');
}

// Export for use in server.ts
export { app, server, io };
