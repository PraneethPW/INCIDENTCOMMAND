import "./env.js";
import pg from "pg";
import { connectionOptions } from "./connection.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;

export const pool = connectionString
  ? new Pool({
      ...connectionOptions(connectionString),
      max: Math.max(
        1,
        Math.min(20, Number(process.env.DATABASE_POOL_MAX) || 5),
      ),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

pool?.on("error", (error) => {
  // Database providers may retire idle serverless connections. The pool replaces them on the next query.
  console.error("Database idle connection was retired:", error.message);
});

export function requirePool(): pg.Pool {
  if (!pool) {
    const error = new Error(
      "PostgreSQL database is not configured",
    ) as Error & {
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
    const required = await pool.query(
      `SELECT bool_and(to_regclass(name) IS NOT NULL) AS ready FROM unnest(ARRAY['organizations','users','memberships','services','service_checks','incidents','incident_events','ai_analyses','telemetry_events','workspace_invites','runtime_sources','runtime_resources','runtime_connections','runtime_lab_sessions']) AS name`,
    );
    if (!required.rows[0]?.ready) return false;
    await pool.query(
      `SELECT i.runtime_resource_id,i.is_test,r.source_id,s.is_test,rs.origin,c.selector,a.context_hash,w.token_hash FROM incidents i,runtime_resources r,services s,runtime_sources rs,runtime_connections c,ai_analyses a,workspace_invites w LIMIT 0`,
    );
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
