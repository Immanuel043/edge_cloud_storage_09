const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const Redis = require('ioredis');
const { Kafka } = require('kafkajs');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const RedisStore = require('connect-redis').default;

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true
    }
});

// Configuration
const config = {
    port: process.env.PORT || 3001,
    storageServiceUrl: process.env.STORAGE_SERVICE_URL || 'http://localhost:8000',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    postgresUrl: process.env.DATABASE_URL || 'postgresql://user:pass@localhost/edge_cloud',
    kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
};

// Initialize Redis clients
const redisClient = new Redis(config.redisUrl);  // For sessions
const redisCache = new Redis(config.redisUrl);   // For caching
const redisSubscriber = new Redis(config.redisUrl); // For pub/sub

// PostgreSQL
const pgPool = new Pool({ connectionString: config.postgresUrl });

// Kafka setup
const kafka = new Kafka({
    clientId: 'web-service',
    brokers: config.kafkaBrokers,
    retry: {
        initialRetryTime: 100,
        retries: 8
    }
});
let kafkaProducer;
let kafkaConsumer;
let kafkaConnected = false;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session management
app.use(session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET || 'default-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Multer for handling multipart uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 * 1024, // 20GB
        files: 1
    }
});

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('join-room', (userId) => {
        socket.join(`user-${userId}`);
        socket.emit('joined', { room: `user-${userId}` });
    });
    
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

// Utility function for retrying connections
async function retryConnection(fn, serviceName, maxRetries = 10) {
    let retries = 0;
    let delay = 1000; // Start with 1 second
    
    while (retries < maxRetries) {
        try {
            await fn();
            console.log(`✅ ${serviceName} connected successfully`);
            return true;
        } catch (error) {
            retries++;
            console.log(`⏳ Waiting for ${serviceName}... (attempt ${retries}/${maxRetries})`);
            if (retries === maxRetries) {
                throw new Error(`Failed to connect to ${serviceName} after ${maxRetries} attempts: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 10000); // Max 10 seconds
        }
    }
}

// Safe Kafka send function
async function sendToKafka(topic, message) {
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
        console.error('Failed to send to Kafka:', error.message);
    }
}

// Initialize services with retry logic
async function initializeServices() {
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
        await kafkaConsumer.subscribe({ topics: ['storage-events', 'upload-events'] });
        
        await kafkaConsumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                try {
                    const event = JSON.parse(message.value.toString());
                    if (event.userId) {
                        io.to(`user-${event.userId}`).emit('storage-event', event);
                    }
                } catch (err) {
                    console.error('Error processing Kafka message:', err);
                }
            }
        });
        
        kafkaConnected = true;
    }, 'Kafka');
}

// Routes

// Health check
app.get('/health', async (req, res) => {
    const checks = {
        postgres: false,
        redis: false,
        kafka: kafkaConnected
    };
    
    try {
        await pgPool.query('SELECT 1');
        checks.postgres = true;
    } catch (err) {}
    
    try {
        await redisClient.ping();
        checks.redis = true;
    } catch (err) {}
    
    const allHealthy = Object.values(checks).every(v => v);
    
    res.status(allHealthy ? 200 : 503).json({
        status: allHealthy ? 'healthy' : 'degraded',
        services: checks,
        timestamp: new Date().toISOString()
    });
});

// Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Authentication
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const result = await pgPool.query(
            'SELECT id, email, username, user_type FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        // Store session
        req.session.userId = user.id;
        req.session.user = user;
        
        // Cache user data
        await redisCache.setex(`user:${user.id}`, 3600, JSON.stringify(user));
        
        res.json({ 
            success: true, 
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                userType: user.user_type
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ success: true });
    });
});

// Chunked Upload Handler
app.post('/api/upload/init', async (req, res) => {
    const { fileName, fileSize, mimeType } = req.body;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const uploadId = require('crypto').randomUUID();
    const chunkSize = 64 * 1024 * 1024; // 64MB
    const totalChunks = Math.ceil(fileSize / chunkSize);
    
    // Store upload session in Redis
    await redisCache.setex(
        `upload:${uploadId}`,
        3600,
        JSON.stringify({
            userId,
            fileName,
            fileSize,
            mimeType,
            totalChunks,
            uploadedChunks: [],
            startTime: Date.now()
        })
    );
    
    // Send real-time notification
    io.to(`user-${userId}`).emit('upload-started', {
        uploadId,
        fileName,
        fileSize,
        totalChunks
    });
    
    res.json({
        uploadId,
        chunkSize,
        totalChunks
    });
});

// Chunk upload endpoint
app.post('/api/upload/chunk/:uploadId/:chunkIndex', 
    upload.single('chunk'), 
    async (req, res) => {
        const { uploadId, chunkIndex } = req.params;
        const chunk = req.file;
        
        if (!chunk) {
            return res.status(400).json({ error: 'No chunk provided' });
        }
        
        try {
            // Get upload session
            const sessionData = await redisCache.get(`upload:${uploadId}`);
            if (!sessionData) {
                return res.status(404).json({ error: 'Upload session not found' });
            }
            
            const session = JSON.parse(sessionData);
            
            // Forward chunk to storage service
            const formData = new FormData();
            formData.append('file', chunk.buffer, {
                filename: `chunk_${chunkIndex}`,
                contentType: 'application/octet-stream'
            });
            
            const response = await axios.post(
                `${config.storageServiceUrl}/api/v1/upload/chunk/${uploadId}`,
                formData,
                {
                    headers: {
                        ...formData.getHeaders(),
                        'chunk-index': chunkIndex
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                }
            );
            
            // Update session
            session.uploadedChunks.push(parseInt(chunkIndex));
            await redisCache.setex(
                `upload:${uploadId}`,
                3600,
                JSON.stringify(session)
            );
            
            // Calculate progress
            const progress = (session.uploadedChunks.length / session.totalChunks) * 100;
            
            // Send real-time progress update
            io.to(`user-${session.userId}`).emit('upload-progress', {
                uploadId,
                chunkIndex: parseInt(chunkIndex),
                progress,
                chunksUploaded: session.uploadedChunks.length,
                totalChunks: session.totalChunks
            });
            
            // Send to Kafka for analytics
            await sendToKafka('upload-events', {
                event: 'chunk_uploaded',
                uploadId,
                chunkIndex,
                userId: session.userId,
                timestamp: new Date().toISOString()
            });
            
            res.json({
                success: true,
                chunkIndex: parseInt(chunkIndex),
                progress
            });
            
        } catch (error) {
            console.error('Chunk upload error:', error);
            res.status(500).json({ error: 'Failed to upload chunk' });
        }
});

// Complete upload
app.post('/api/upload/complete/:uploadId', async (req, res) => {
    const { uploadId } = req.params;
    
    try {
        const sessionData = await redisCache.get(`upload:${uploadId}`);
        if (!sessionData) {
            return res.status(404).json({ error: 'Upload session not found' });
        }
        
        const session = JSON.parse(sessionData);
        
        // Verify all chunks uploaded
        if (session.uploadedChunks.length !== session.totalChunks) {
            return res.status(400).json({ 
                error: 'Not all chunks uploaded',
                missing: session.totalChunks - session.uploadedChunks.length
            });
        }
        
        // Finalize with storage service
        const response = await axios.post(
            `${config.storageServiceUrl}/api/v1/upload/complete/${uploadId}`,
            {
                fileName: session.fileName,
                fileSize: session.fileSize,
                mimeType: session.mimeType,
                userId: session.userId
            }
        );
        
        const fileData = response.data;
        
        // Clean up Redis session
        await redisCache.del(`upload:${uploadId}`);
        
        // Send completion notification
        io.to(`user-${session.userId}`).emit('upload-complete', {
            uploadId,
            fileId: fileData.file_id,
            fileName: session.fileName,
            fileSize: session.fileSize,
            duration: Date.now() - session.startTime
        });
        
        // Send to Kafka
        await sendToKafka('upload-events', {
            event: 'upload_completed',
            uploadId,
            fileId: fileData.file_id,
            userId: session.userId,
            timestamp: new Date().toISOString()
        });
        
        res.json({
            success: true,
            file: fileData
        });
        
    } catch (error) {
        console.error('Complete upload error:', error);
        res.status(500).json({ error: 'Failed to complete upload' });
    }
});

// File listing
app.get('/api/files', async (req, res) => {
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        // Call storage service to get files
        const response = await axios.get(
            `${config.storageServiceUrl}/api/v1/files`,
            {
                headers: {
                    'X-User-Id': userId
                }
            }
        );
        
        res.json(response.data);
    } catch (error) {
        console.error('List files error:', error);
        res.status(500).json({ error: 'Failed to list files' });
    }
});

// Download file
app.get('/api/download/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        // Proxy download from storage service
        const response = await axios.get(
            `${config.storageServiceUrl}/api/v1/files/${fileId}/download`,
            { 
                responseType: 'stream',
                headers: {
                    'X-User-Id': userId
                }
            }
        );
        
        // Forward headers
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        res.setHeader('Content-Length', response.headers['content-length']);
        res.setHeader('Content-Disposition', response.headers['content-disposition']);
        
        // Stream to client
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download file' });
    }
});

// Delete file
app.delete('/api/files/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        const response = await axios.delete(
            `${config.storageServiceUrl}/api/v1/files/${fileId}`,
            {
                headers: {
                    'X-User-Id': userId
                }
            }
        );
        
        res.json(response.data);
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Share file
app.post('/api/share/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { expiresHours, password, maxDownloads } = req.body;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        const response = await axios.post(
            `${config.storageServiceUrl}/api/v1/files/${fileId}/share`,
            {
                expires_hours: expiresHours,
                password: password,
                max_downloads: maxDownloads
            },
            {
                headers: {
                    'X-User-Id': userId
                }
            }
        );
        
        res.json(response.data);
    } catch (error) {
        console.error('Share error:', error);
        res.status(500).json({ error: 'Failed to create share link' });
    }
});

// Initialize services on module load
async function start() {
    try {
        console.log('🚀 Initializing services...');
        await initializeServices();
        console.log('✅ All services connected successfully');
    } catch (error) {
        console.error('❌ Failed to initialize services:', error.message);
        process.exit(1);
    }
}

// Start initialization
start();

// Graceful shutdown handler
async function gracefulShutdown() {
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

// Export for use in server.js
module.exports = { 
    app, 
    server, 
    io, 
    gracefulShutdown 
};