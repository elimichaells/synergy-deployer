import { Pool, type QueryResultRow } from 'pg'

const connectionString = process.env.DATABASE_URL

export const db = new Pool({
  connectionString,
  host: connectionString ? undefined : process.env.DATABASE_HOST,
  port: connectionString ? undefined : parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: connectionString ? undefined : process.env.DATABASE_NAME,
  user: connectionString ? undefined : process.env.DATABASE_USER,
  password: connectionString ? undefined : process.env.DATABASE_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30_000,
})

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  const client = await db.connect()
  try {
    const result = await client.query<T>(sql, params)
    return result
  } finally {
    client.release()
  }
}
