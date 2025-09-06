// services/web-service/src/server.js
const { server, gracefulShutdown } = require('./app');

const port = process.env.PORT || 3001;

// Start the server
server.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Web service listening on port ${port}`);
    console.log(`📍 Health check: http://localhost:${port}/health`);
    console.log(`🏠 Dashboard: http://localhost:${port}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('SIGTERM signal received');
    
    // Stop accepting new connections
    server.close(async () => {
        console.log('HTTP server closed');
        
        // Cleanup resources
        await gracefulShutdown();
        
        // Exit
        process.exit(0);
    });
    
    // Force exit after 30 seconds
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
});

process.on('SIGINT', async () => {
    console.log('SIGINT signal received');
    
    server.close(async () => {
        console.log('HTTP server closed');
        await gracefulShutdown();
        process.exit(0);
    });
    
    setTimeout(() => {
        console.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});