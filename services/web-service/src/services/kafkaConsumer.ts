import { Consumer, EachMessagePayload } from 'kafkajs';
import { Server as SocketIOServer } from 'socket.io';
import type { KafkaEvent } from '../types/kafka';

export async function setupKafkaConsumer(
  consumer: Consumer,
  io: SocketIOServer
): Promise<void> {
  await consumer.subscribe({ topics: ['storage-events', 'upload-events'] });
  
  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      try {
        const event: KafkaEvent = JSON.parse(message.value?.toString() || '{}');
        if (event.userId) {
          io.to(`user-${event.userId}`).emit('storage-event', event);
        }
      } catch (err) {
        console.error('Error processing Kafka message:', err);
      }
    }
  });
}
