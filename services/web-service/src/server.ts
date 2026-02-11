import { server, gracefulShutdown } from './app';
import logger from './config/logger';

const port = process.env.PORT || 3001;

// Start the server
server.listen(Number(port), '0.0.0.0', () => {
  logger.info(`Web service listening on port ${port}`);
  logger.info(`Health check: http://localhost:${port}/health`);
  logger.info(`Dashboard: http://localhost:${port}`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received');

  server.close(async () => {
    logger.info('HTTP server closed');
    await gracefulShutdown();
    process.exit(0);
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received');

  server.close(async () => {
    logger.info('HTTP server closed');
    await gracefulShutdown();
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error(`Unhandled Rejection: ${reason}`);
  process.exit(1);
});
