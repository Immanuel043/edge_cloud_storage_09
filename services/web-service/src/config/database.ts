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
  const poolConfig: PoolConfig = {
    connectionString: config?.connectionString || process.env.DATABASE_URL || 'postgresql://user:pass@localhost/edge_cloud',
    max: config?.max ?? 50,
    min: config?.min ?? 10,
    idleTimeoutMillis: config?.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config?.connectionTimeoutMillis ?? 5000,
    allowExitOnIdle: config?.allowExitOnIdle ?? false,
  };

  return new Pool(poolConfig);
}
