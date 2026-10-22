import "./env.js";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(connectionString).hostname,
      )
        ? false
        : { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

pool?.on("error", (error) => {
  // Neon may retire idle serverless connections. The pool replaces them on the next query.
  console.error("Database idle connection was retired:", error.message);
});

export function requirePool(): pg.Pool {
  if (!pool) {
    const error = new Error("Neon database is not configured") as Error & {
      status?: number;
      setup?: string;
    };
    error.status = 503;
    error.setup =
      "Add DATABASE_URL to backend/.env, then run npm run db:setup --prefix backend.";
    throw error;
  }
  return pool;
}

export async function databaseReady(): Promise<boolean> {
  if (!pool) return false;
  try {
    await pool.query("SELECT 1 FROM organizations LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

export async function transaction<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await requirePool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
