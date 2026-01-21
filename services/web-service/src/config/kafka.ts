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
    retry: {
      initialRetryTime: 100,
      retries: 8
    }
  };

  return new Kafka(kafkaConfig);
}
