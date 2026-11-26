import "./env.js";
import pg from "pg";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { connectionOptions } from "./connection.js";

export const applicationTables = [
  "organizations",
  "users",
  "memberships",
  "services",
  "runtime_connections",
  "runtime_lab_sessions",
  "runtime_sources",
  "runtime_resources",
  "service_checks",
  "incidents",
  "incident_events",
  "ai_analyses",
  "telemetry_events",
  "workspace_invites",
] as const;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const table = (name: string) => `public.${quote(name)}`;
async function columns(db: pg.Client, name: string) {
  return (
    await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
      [name],
    )
  ).rows.map((r) => r.column_name);
}
async function fingerprint(
  db: pg.Client,
  name: string,
  cols: string[],
  consume?: (rows: string[]) => Promise<void>,
) {
  const order =
    name === "memberships"
      ? ["organization_id", "user_id"]
      : name === "workspace_invites"
        ? ["token_hash"]
        : ["id"];
  const hash = createHash("sha256");
  let count = 0n;
  await db.query(
    `DECLARE migration_rows NO SCROLL CURSOR FOR SELECT row_to_json(row_data)::text AS payload FROM (SELECT ${cols.map(quote).join(",")} FROM ${table(name)} ORDER BY ${order.map(quote).join(",")}) row_data`,
  );
  try {
    while (true) {
      const rows = (
        await db.query<{ payload: string }>("FETCH 500 FROM migration_rows")
      ).rows.map((r) => r.payload);
      if (!rows.length) break;
      // Keep Postgres JSON text intact: BIGINT, NUMERIC and timestamp microseconds must not pass through JavaScript numbers/Dates.
      for (const row of rows) {
        hash.update(row + "\n");
        count++;
      }
      if (consume) await consume(rows);
    }
  } finally {
    await db.query("CLOSE migration_rows");
  }
  return { rows: count.toString(), sha256: hash.digest("hex") };
}
async function sequence(db: pg.Client, name: string) {
  return (
    await db.query<{ schema: string; name: string; regclass: string }>(
      `SELECT n.nspname AS schema,c.relname AS name,c.oid::regclass::text AS regclass FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_get_serial_sequence($1,'id')::regclass`,
      [`public.${name}`],
    )
  ).rows[0];
}
export async function migrateApplicationData(
  sourceUrl: string,
  targetUrl: string,
  execute = false,
) {
  if (sourceUrl === targetUrl)
    throw new Error("Source and destination must differ");
  const source = new pg.Client(
    connectionOptions(sourceUrl, process.env.MIGRATION_SOURCE_SSL_CA),
  );
  const target = new pg.Client(
    connectionOptions(
      targetUrl,
      process.env.MIGRATION_TARGET_SSL_CA || process.env.DATABASE_SSL_CA,
    ),
  );
  let targetTransaction = false,
    sourceTransaction = false;
  try {
    await source.connect();
    await target.connect();
    const sourceIdentity = (
      await source
        .query("SELECT system_identifier::text FROM pg_control_system()")
        .catch(() => ({ rows: [] }))
    ).rows[0]?.system_identifier;
    const targetIdentity = (
      await target
        .query("SELECT system_identifier::text FROM pg_control_system()")
        .catch(() => ({ rows: [] }))
    ).rows[0]?.system_identifier;
    if (
      sourceIdentity &&
      sourceIdentity === targetIdentity &&
      new URL(sourceUrl).pathname === new URL(targetUrl).pathname
    )
      throw new Error("Refusing a migration into the source database");
    const found = (
      await source.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      )
    ).rows.map((r) => r.table_name);
    const unknown = found.filter(
      (t) => !(applicationTables as readonly string[]).includes(t),
    );
    if (unknown.length)
      throw new Error(
        "Source contains additional tables requiring review: " +
          unknown.join(", "),
      );
    if (!found.includes("organizations") || !found.includes("users"))
      throw new Error("Source is not an initialized Incident Command database");
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    sourceTransaction = true;
    await source.query(
      "SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'",
    );
    if (execute)
      await source.query(
        `LOCK TABLE ${found.map(table).join(",")} IN SHARE MODE`,
      );
    await target.query("BEGIN");
    targetTransaction = true;
    await target.query(
      "SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'",
    );
    await target.query(
      "SELECT pg_advisory_xact_lock(hashtext('incident-command-schema'))",
    );
    if (execute)
      await target.query(
        await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
      );
    const report: Record<
      string,
      {
        source: { rows: string; sha256?: string };
        target?: { rows: string; sha256: string };
      }
    > = {};
    for (const name of applicationTables) {
      const sourceCols = found.includes(name)
        ? await columns(source, name)
        : [];
      const targetCols = await columns(target, name);
      if (
        targetCols.length &&
        Number(
          (
            await target.query(
              `SELECT COUNT(*)::text AS count FROM ${table(name)}`,
            )
          ).rows[0].count,
        ) > 0
      )
        throw new Error(
          `Destination table ${name} is not empty; refusing to overwrite existing data`,
        );
      if (!sourceCols.length) {
        report[name] = { source: { rows: "0" } };
        continue;
      }
      if (!execute) {
        report[name] = {
          source: {
            rows: (
              await source.query(
                `SELECT COUNT(*)::text AS count FROM ${table(name)}`,
              )
            ).rows[0].count,
          },
        };
        continue;
      }
      if (sourceCols.some((c) => !targetCols.includes(c)))
        throw new Error(
          `Unmapped source columns in ${name}; refusing a lossy migration`,
        );
      const names = sourceCols.map(quote).join(",");
      const original = await fingerprint(
        source,
        name,
        sourceCols,
        async (rows) => {
          await target.query(
            `INSERT INTO ${table(name)}(${names}) SELECT ${names} FROM json_populate_recordset(NULL::${table(name)},$1::json)`,
            ["[" + rows.join(",") + "]"],
          );
        },
      );
      const copied = await fingerprint(target, name, sourceCols);
      if (original.rows !== copied.rows || original.sha256 !== copied.sha256)
        throw new Error(
          `Data verification failed for ${name}; destination will be rolled back`,
        );
      report[name] = { source: original, target: copied };
      if (["service_checks", "telemetry_events"].includes(name)) {
        const oldSeq = await sequence(source, name),
          newSeq = await sequence(target, name);
        if (oldSeq && newSeq) {
          const old = (
            await source.query(
              `SELECT last_value::text,is_called FROM ${quote(oldSeq.schema)}.${quote(oldSeq.name)}`,
            )
          ).rows[0];
          await target.query(
            `SELECT setval($1::regclass,GREATEST($2::bigint,COALESCE((SELECT MAX(id) FROM ${table(name)}),1)),$3)`,
            [
              newSeq.regclass,
              old.last_value,
              old.is_called || original.rows !== "0",
            ],
          );
        }
      }
    }
    if (execute) {
      await target.query("SET CONSTRAINTS ALL IMMEDIATE");
      await target.query("COMMIT");
      targetTransaction = false;
    }
    return { executed: execute, verified: execute, tables: report };
  } finally {
    if (targetTransaction) await target.query("ROLLBACK").catch(() => {});
    if (sourceTransaction) await source.query("ROLLBACK").catch(() => {});
    await Promise.allSettled([source.end(), target.end()]);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const source = process.env.MIGRATION_SOURCE_DATABASE_URL,
    target = process.env.MIGRATION_TARGET_DATABASE_URL;
  if (!source || !target)
    throw new Error(
      "Set MIGRATION_SOURCE_DATABASE_URL and MIGRATION_TARGET_DATABASE_URL in the process environment. No root .env is needed.",
    );
  try {
    console.log(
      JSON.stringify(
        await migrateApplicationData(
          source,
          target,
          process.argv.includes("--execute"),
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  }
}
