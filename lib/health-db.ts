import { Pool } from 'pg'

// Isolate alert reads from deployment work and bound connection/query waits.
const connectionString = process.env.DATABASE_URL
const pool = new Pool({
  connectionString,
  host: connectionString ? undefined : process.env.DATABASE_HOST,
  port: connectionString ? undefined : Number(process.env.DATABASE_PORT || 5432),
  database: connectionString ? undefined : process.env.DATABASE_NAME,
  user: connectionString ? undefined : process.env.DATABASE_USER,
  password: connectionString ? undefined : process.env.DATABASE_PASSWORD,
  max: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 10000,
  statement_timeout: 2500,
  query_timeout: 3000,
  application_name: 'manager-health',
})
pool.on('error', () => { /* The next read reports this source as unavailable. */ })
export const query = (sql: string) => pool.query(sql)
