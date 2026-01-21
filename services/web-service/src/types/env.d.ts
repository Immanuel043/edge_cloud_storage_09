export interface EnvConfig {
  PORT: string;
  FRONTEND_URL: string;
  STORAGE_SERVICE_URL: string;
  REDIS_URL: string;
  DATABASE_URL: string;
  KAFKA_BROKERS: string;
  SESSION_SECRET: string;
  NODE_ENV: 'development' | 'production' | 'test';
}

declare global {
  namespace NodeJS {
    interface ProcessEnv extends Partial<EnvConfig> {
      PORT?: string;
      FRONTEND_URL?: string;
      STORAGE_SERVICE_URL?: string;
      REDIS_URL?: string;
      DATABASE_URL?: string;
      KAFKA_BROKERS?: string;
      SESSION_SECRET?: string;
      NODE_ENV?: 'development' | 'production' | 'test';
    }
  }
}

export {};
