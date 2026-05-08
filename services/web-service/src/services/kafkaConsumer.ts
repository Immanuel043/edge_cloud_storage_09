import { Consumer, EachMessagePayload } from 'kafkajs';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../config/logger';
import type { KafkaEvent } from '../types/kafka';

let crashRecoveryAttempts = 0;
const MAX_CRASH_RECOVERY_ATTEMPTS = 50;

export async function setupKafkaConsumer(
  consumer: Consumer,
  io: SocketIOServer
): Promise<void> {
  // Auto-restart on consumer crash with backoff. The crash event itself is
  // also logged by wireKafkaInstrumentation; this handler is responsible for
  // the recovery loop, not the diagnostic.
  consumer.on('consumer.crash', async (event) => {
    const error = event.payload.error;

    if (crashRecoveryAttempts >= MAX_CRASH_RECOVERY_ATTEMPTS) {
      logger.error(
        `[kafka] consumer.crash recovery exhausted after ${MAX_CRASH_RECOVERY_ATTEMPTS} attempts; giving up. last error=${error.message}`
      );
      return;
    }

    crashRecoveryAttempts++;
    const delay = Math.min(5000 * crashRecoveryAttempts, 60000);
    logger.warn(
      `[kafka] consumer.crash recovery attempt=${crashRecoveryAttempts}/${MAX_CRASH_RECOVERY_ATTEMPTS} delay=${delay}ms error=${error.message}`
    );

    setTimeout(async () => {
      try {
        await consumer.disconnect();
      } catch {
        // Ignore disconnect errors during recovery
      }
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: ['storage-events', 'upload-events'], fromBeginning: false });
        await consumer.run({
          autoCommitInterval: 5000,
          autoCommitThreshold: 100,
          eachMessage: createMessageHandler(io),
        });
        logger.info(`[kafka] consumer.crash recovery successful after attempt=${crashRecoveryAttempts}`);
        crashRecoveryAttempts = 0; // Reset on success
      } catch (err) {
        logger.error(`[kafka] consumer.crash recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay);
  });

  await consumer.subscribe({ topics: ['storage-events', 'upload-events'], fromBeginning: false });

  await consumer.run({
    autoCommitInterval: 5000,
    autoCommitThreshold: 100,
    eachMessage: createMessageHandler(io),
  });
}

function createMessageHandler(io: SocketIOServer) {
  return async ({ message }: EachMessagePayload): Promise<void> => {
    try {
      const event: KafkaEvent = JSON.parse(message.value?.toString() || '{}');
      if (event.userId) {
        io.to(`user-${event.userId}`).emit('storage-event', event);
      }
    } catch (err) {
      // Never rethrow from eachMessage — log and continue
      logger.error(`[kafka] eachMessage handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
