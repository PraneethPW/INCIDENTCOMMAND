import type pg from "pg";
import { readFileSync } from "node:fs";

// Keep TLS verification identical for queries, migrations and the LISTEN connection.
export function connectionOptions(
  value: string,
  ca = process.env.DATABASE_SSL_CA,
): pg.ClientConfig {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    /YOUR-DATABASE-PASSWORD|\[.*PASSWORD.*\]/i.test(
      decodeURIComponent(url.password),
    )
  )
    throw new Error(
      "Use a complete PostgreSQL connection string with a real database password.",
    );
  if (!ca && /\.supabase\.(co|com)$/.test(url.hostname))
    ca = readFileSync(
      new URL("../certs/supabase-root.crt", import.meta.url),
      "utf8",
    );
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // pg-connection-string's SSL parameters override the supplied ssl object.
  // Remove them so sslmode=require cannot silently weaken certificate verification.
  for (const key of [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ])
    url.searchParams.delete(key);
  return {
    connectionString: url.href,
    ssl: local
      ? false
      : {
          rejectUnauthorized: true,
          ...(ca ? { ca: ca.replaceAll("\\n", "\n") } : {}),
        },
    connectionTimeoutMillis: 10000,
  };
}
export function listenerUrl(value: string) {
  const url = new URL(value);
  if (url.hostname.endsWith(".pooler.supabase.com") && url.port === "6543")
    throw new Error(
      "PostgreSQL LISTEN requires the Supabase session pooler on port 5432. Set DATABASE_LISTEN_URL.",
    );
  return url.href;
}
export function databaseProvider(value?: string) {
  if (!value) return "PostgreSQL";
  const host = new URL(value).hostname;
  return /\.supabase\.(co|com)$/.test(host) ? "Supabase" : "PostgreSQL";
}
