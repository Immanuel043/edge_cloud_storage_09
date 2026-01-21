import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import session from 'express-session';
import { Producer, Consumer } from 'kafkajs';
import path from 'path';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const RedisStore = require('connect-redis').default;
import { createDatabasePool } from './config/database';
import { createRedisClient } from './config/redis';
import { createKafkaClient } from './config/kafka';
import { setupWebSocketHandlers } from './services/webSocketService';
import { setupKafkaConsumer } from './services/kafkaConsumer';
import { createAuthRoutes } from './routes/auth';
import { createFileRoutes } from './routes/files';
import { createUploadRoutes } from './routes/upload';
import { ShareController } from './controllers/shareController';
import type { HealthCheckResponse } from './types/api';

// Configuration
const config = {
  port: process.env.PORT || 3001,
  storageServiceUrl: process.env.STORAGE_SERVICE_URL || 'http://localhost:8000',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  postgresUrl: process.env.DATABASE_URL || 'postgresql://user:pass@localhost/edge_cloud',
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
};

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
  contentSecurityPolicy: false, // Disable for development
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session management
const redisStore = new RedisStore({
  client: redisClient,
  prefix: 'session:'
});

app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'default-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

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
      console.log(`✅ ${serviceName} connected successfully`);
      return true;
    } catch (error) {
      retries++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`⏳ Waiting for ${serviceName}... (attempt ${retries}/${maxRetries})`);
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
    console.debug('Kafka not available, skipping message');
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
    kafkaConsumer = kafka.consumer({ groupId: 'web-service-group' });
    
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
  } catch (err) {
    // Ignore error
  }
  
  try {
    await redisClient.ping();
    checks.redis = true;
  } catch (err) {
    // Ignore error
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

// Share file route (using controller directly)
const shareController = new ShareController(config.storageServiceUrl);
app.post('/api/share/:fileId', (req, res) => {
  void shareController.shareFile(req, res);
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

// Initialize services on module load
async function start(): Promise<void> {
  try {
    console.log('🚀 Initializing services...');
    await initializeServices();
    console.log('✅ All services connected successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Failed to initialize services:', errorMessage);
    process.exit(1);
  }
}

// Start initialization
start();

// Graceful shutdown handler
export async function gracefulShutdown(): Promise<void> {
  console.log('🛑 Shutting down gracefully...');
  
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
  
  console.log('👋 Cleanup completed');
}

// Export for use in server.ts
export { app, server, io };
