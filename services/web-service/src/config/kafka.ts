import { Kafka, KafkaConfig, Producer, Consumer } from 'kafkajs';

export interface KafkaServiceConfig {
  clientId: string;
  brokers: string[];
}

export interface KafkaClients {
  kafka: Kafka;
  producer: Producer | null;
  consumer: Consumer | null;
  connected: boolean;
}

export function createKafkaClient(config?: Partial<KafkaServiceConfig>): Kafka {
  const kafkaConfig: KafkaConfig = {
    clientId: config?.clientId || 'web-service',
    brokers: config?.brokers || (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    connectionTimeout: 10000,
    requestTimeout: 60000,
    enforceRequestTimeout: true,
    retry: {
      initialRetryTime: 300,
      retries: 15,
      maxRetryTime: 30000,
      factor: 0.2,
      multiplier: 2,
      restartOnFailure: async (error) => {
        console.error('[Kafka] Client failure, restarting:', error.message);
        return true;
      },
    },
  };

  return new Kafka(kafkaConfig);
}
