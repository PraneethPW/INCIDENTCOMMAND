import pg from 'pg'

const { Pool } = pg
const connectionString = process.env.DATABASE_URL

export const pool = connectionString
  ? new Pool({ connectionString, ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }, max: 10, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 })
  : null

pool?.on('error', (error) => {
  // Neon may retire idle serverless connections. The pool replaces them on the next query.
  console.error('Database idle connection was retired:', error.message)
})

export function requirePool(): pg.Pool {
  if (!pool) {
    const error = new Error('Neon database is not configured') as Error & { status?: number; setup?: string }
    error.status = 503
    error.setup = 'Add DATABASE_URL to backend/.env, then run npm run db:setup --prefix backend.'
    throw error
  }
  return pool
}

export async function databaseReady(): Promise<boolean> {
  if (!pool) return false
  try {
    await pool.query('SELECT 1 FROM organizations LIMIT 1')
    return true
  } catch {
    return false
  }
}
