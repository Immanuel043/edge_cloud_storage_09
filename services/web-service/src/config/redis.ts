import Redis from 'ioredis';

export interface RedisConfig {
  url: string;
}

export function createRedisClient(config?: Partial<RedisConfig>): Redis {
  const redisUrl = config?.url || process.env.REDIS_URL || 'redis://localhost:6379';
  return new Redis(redisUrl);
}
