// services/web-service/src/app.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const Redis = require('ioredis');
const { Kafka } = require('kafkajs');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const { Pool } = require('pg');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

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

// Initialize services
const redis = new Redis(config.redisUrl);
const redisSubscriber = new Redis(config.redisUrl);
const pgPool = new Pool({ connectionString: config.postgresUrl });

// Kafka setup
const kafka = new Kafka({
    clientId: 'web-service',
    brokers: config.kafkaBrokers
});
const kafkaProducer = kafka.producer();
const kafkaConsumer = kafka.consumer({ groupId: 'web-service-group' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session management with Redis
app.use(session({
    store: new RedisStore({ client: redis }),
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 // 24 hours
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

// Routes

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
        await redis.setex(`user:${user.id}`, 3600, JSON.stringify(user));
        
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
    await redis.setex(
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
            const sessionData = await redis.get(`upload:${uploadId}`);
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
                `${config.storageServiceUrl}/v1/chunks/${uploadId}/${chunkIndex}`,
                formData,
                {
                    headers: formData.getHeaders(),
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                }
            );
            
            // Update session
            session.uploadedChunks.push(parseInt(chunkIndex));
            await redis.setex(
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
            await kafkaProducer.send({
                topic: 'upload-events',
                messages: [{
                    value: JSON.stringify({
                        event: 'chunk_uploaded',
                        uploadId,
                        chunkIndex,
                        userId: session.userId,
                        timestamp: new Date().toISOString()
                    })
                }]
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
        const sessionData = await redis.get(`upload:${uploadId}`);
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
            `${config.storageServiceUrl}/v1/uploads/${uploadId}/complete`,
            {
                fileName: session.fileName,
                fileSize: session.fileSize,
                mimeType: session.mimeType,
                userId: session.userId
            }
        );
        
        const fileData = response.data;
        
        // Store in PostgreSQL
        await pgPool.query(
            `INSERT INTO files (id, user_id, file_name, file_size, mime_type, storage_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [fileData.id, session.userId, session.fileName, session.fileSize, 
             session.mimeType, fileData.storageId]
        );
        
        // Clean up Redis session
        await redis.del(`upload:${uploadId}`);
        
        // Send completion notification
        io.to(`user-${session.userId}`).emit('upload-complete', {
            uploadId,
            fileId: fileData.id,
            fileName: session.fileName,
            fileSize: session.fileSize,
            duration: Date.now() - session.startTime
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
        const result = await pgPool.query(
            `SELECT id, file_name, file_size, mime_type, created_at, 
                    last_accessed, access_count, is_shared
             FROM files 
             WHERE user_id = $1 
             ORDER BY created_at DESC`,
            [userId]
        );
        
        res.json({
            files: result.rows,
            count: result.rows.length
        });
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
        // Get file metadata
        const result = await pgPool.query(
            'SELECT * FROM files WHERE id = $1 AND user_id = $2',
            [fileId, userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        const file = result.rows[0];
        
        // Proxy download from storage service
        const response = await axios.get(
            `${config.storageServiceUrl}/v1/objects/${file.storage_id}`,
            { responseType: 'stream' }
        );
        
        // Update access count
        await pgPool.query(
            'UPDATE files SET access_count = access_count + 1, last_accessed = NOW() WHERE id = $1',
            [fileId]
        );
        
        // Set headers
        res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
        res.setHeader('Content-Length', file.file_size);
        res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
        
        // Stream to client
        response.data.pipe(res);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to download file' });
    }
});

// Share file
app.post('/api/share/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const { expiresIn, password } = req.body;
    const userId = req.session.userId;
    
    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    
    try {
        // Verify ownership
        const result = await pgPool.query(
            'SELECT id FROM files WHERE id = $1 AND user_id = $2',
            [fileId, userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        // Generate share token
        const shareToken = require('crypto').randomUUID();
        
        // Store share link
        await pgPool.query(
            `INSERT INTO shared_links (id, file_id, user_id, share_token, password_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [require('crypto').randomUUID(), fileId, userId, shareToken, 
             password ? require('bcrypt').hashSync(password, 10) : null,
             expiresIn ? new Date(Date.now() + expiresIn * 1000) : null]
        );
        
        res.json({
            shareUrl: `${req.protocol}://${req.get('host')}/share/${shareToken}`,
            token: shareToken,
            expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null
        });
        
    } catch (error) {
        console.error('Share error:', error);
        res.status(500).json({ error: 'Failed to create share link' });
    }
});

// Kafka consumer for real-time updates
async function startKafkaConsumer() {
    await kafkaConsumer.connect();
    await kafkaConsumer.subscribe({ topics: ['storage-events', 'upload-events'] });
    
    await kafkaConsumer.run({
        eachMessage: async ({ topic, partition, message }) => {
            const event = JSON.parse(message.value.toString());
            
            // Process events and send real-time updates
            if (event.userId) {
                io.to(`user-${event.userId}`).emit('storage-event', event);
            }
            
            // Store in ClickHouse for analytics
            // ... analytics code ...
        }
    });
}

// Start server
async function start() {
    try {
        await kafkaProducer.connect();
        await startKafkaConsumer();
        
        server.listen(config.port, () => {
            console.log(`Web service running on port ${config.port}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();

module.exports = app;