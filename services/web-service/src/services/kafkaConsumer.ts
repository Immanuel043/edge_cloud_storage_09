import { Consumer, EachMessagePayload } from 'kafkajs';
import { Server as SocketIOServer } from 'socket.io';
import type { KafkaEvent } from '../types/kafka';

let crashRecoveryAttempts = 0;
const MAX_CRASH_RECOVERY_ATTEMPTS = 50;

export async function setupKafkaConsumer(
  consumer: Consumer,
  io: SocketIOServer
): Promise<void> {
  // Auto-restart on consumer crash with backoff
  consumer.on('consumer.crash', async (event) => {
    const error = event.payload.error;
    console.error(`[Kafka] Consumer crashed: ${error.message}`);

    if (crashRecoveryAttempts >= MAX_CRASH_RECOVERY_ATTEMPTS) {
      console.error('[Kafka] Max crash recovery attempts reached, giving up auto-restart');
      return;
    }

    crashRecoveryAttempts++;
    const delay = Math.min(5000 * crashRecoveryAttempts, 60000);
    console.log(`[Kafka] Attempting recovery ${crashRecoveryAttempts}/${MAX_CRASH_RECOVERY_ATTEMPTS} in ${delay}ms...`);

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
        console.log('[Kafka] Consumer recovered successfully');
        crashRecoveryAttempts = 0; // Reset on success
      } catch (err) {
        console.error('[Kafka] Recovery failed:', err instanceof Error ? err.message : err);
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
      console.error('Error processing Kafka message:', err);
    }
  };
}
