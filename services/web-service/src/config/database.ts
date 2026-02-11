import { Pool, PoolConfig } from 'pg';

export interface DatabaseConfig {
  connectionString: string;
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  allowExitOnIdle: boolean;
}

export function createDatabasePool(config?: Partial<DatabaseConfig>): Pool {
  const isProduction = process.env.NODE_ENV === 'production';
  const connString = config?.connectionString || process.env.DATABASE_URL || (isProduction ? '' : 'postgresql://user:pass@localhost/edge_cloud');

  if (isProduction && !connString) {
    throw new Error('FATAL: DATABASE_URL environment variable is required in production');
  }

  const poolConfig: PoolConfig = {
    connectionString: connString,
    max: config?.max ?? 50,
    min: config?.min ?? 10,
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
    allowExitOnIdle: config?.allowExitOnIdle ?? false,
  };

  return new Pool(poolConfig);
}
