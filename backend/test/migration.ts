import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { migrateApplicationData } from "../src/migrate-database.js";
import { connectionOptions, listenerUrl } from "../src/connection.js";

test("connection configuration verifies TLS and rejects placeholder passwords and transaction-mode listeners", () => {
  assert.throws(() =>
    connectionOptions(
      "postgresql://postgres:[YOUR-DATABASE-PASSWORD]@db.example.com/postgres",
    ),
  );
  const secure = connectionOptions(
    "postgresql://user:password@db.example.com/postgres?sslmode=require",
  );
  assert.equal(
    (secure.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized,
    true,
  );
  assert.ok(!secure.connectionString?.includes("sslmode="));
  assert.throws(() =>
    listenerUrl(
      "postgresql://user:password@aws-0-example.pooler.supabase.com:6543/postgres",
    ),
  );
  assert.ok(
    listenerUrl(
      "postgresql://user:password@aws-0-example.pooler.supabase.com:5432/postgres",
    ).includes(":5432"),
  );
});
test("migration preserves legacy data, JSON, microseconds and BIGINT precision and refuses nonempty destinations", async () => {
  if (
    process.env.NODE_ENV !== "test" ||
    !process.env.DATABASE_URL?.includes("incident_test")
  )
    throw Error("Use an isolated incident_test database");
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const suffix = randomBytes(4).toString("hex");
  const names = [
    `incident_test_source_${suffix}`,
    `incident_test_target_${suffix}`,
  ];
  const urls = names.map((n) => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = "/" + n;
    return u.href;
  });
  let source: pg.Client | undefined, target: pg.Client | undefined;
  try {
    for (const n of names) await admin.query(`CREATE DATABASE "${n}"`);
    source = new pg.Client({ connectionString: urls[0] });
    target = new pg.Client({ connectionString: urls[1] });
    await source.connect();
    await target.connect();
    await source.query(
      await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
    );
    await source.query(
      "ALTER TABLE incidents DROP COLUMN runtime_resource_id; DROP TABLE runtime_resources; DROP TABLE runtime_sources;",
    );
    const org = (
      await source.query(
        "INSERT INTO organizations(name,slug) VALUES('Migration test','migration-test') RETURNING id",
      )
    ).rows[0].id;
    const user = (
      await source.query(
        "INSERT INTO users(name,email,password_hash) VALUES('Test','migration@example.test','existing-bcrypt-hash') RETURNING id",
      )
    ).rows[0].id;
    await source.query(
      "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [org, user],
    );
    const svc = (
      await source.query(
        "INSERT INTO services(organization_id,name,slug,ingest_key) VALUES($1,'Test','test','test-only-key') RETURNING id",
        [org],
      )
    ).rows[0].id;
    await source.query(
      `INSERT INTO telemetry_events(id,organization_id,service_id,event_type,message,metadata,received_at) VALUES(9007199254740993,$1,$2,'migration','Exact precision','{"value":9007199254740993,"nested":{"ok":true}}','2026-01-01T00:00:00.123456Z')`,
      [org, svc],
    );
    const dry = await migrateApplicationData(urls[0], urls[1]);
    assert.equal(dry.executed, false);
    assert.equal(dry.tables.users.source.rows, "1");
    assert.equal(
      (
        await target.query(
          "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
        )
      ).rows[0].n,
      0,
    );
    const result = await migrateApplicationData(urls[0], urls[1], true);
    assert.equal(result.verified, true);
    assert.equal(
      result.tables.telemetry_events.source.sha256,
      result.tables.telemetry_events.target!.sha256,
    );
    assert.equal(
      (await target.query("SELECT id::text FROM telemetry_events")).rows[0].id,
      "9007199254740993",
    );
    assert.equal(
      (
        await target.query(
          "SELECT to_char(received_at,'US') AS micros FROM telemetry_events",
        )
      ).rows[0].micros,
      "123456",
    );
    assert.equal(
      (await target.query("SELECT password_hash FROM users")).rows[0]
        .password_hash,
      "existing-bcrypt-hash",
    );
    assert.equal(
      (
        await target.query(
          "SELECT nextval('telemetry_events_id_seq')::text AS next",
        )
      ).rows[0].next,
      "9007199254740994",
    );
    assert.equal(
      (await target.query("SELECT COUNT(*)::int AS n FROM runtime_resources"))
        .rows[0].n,
      0,
    );
    assert.equal(
      (
        await target.query(
          "SELECT bool_and(relrowsecurity) AS secured FROM pg_class WHERE oid='users'::regclass",
        )
      ).rows[0].secured,
      true,
    );
    await assert.rejects(
      () => migrateApplicationData(urls[0], urls[1], true),
      /not empty/,
    );
    assert.equal(
      (await target.query("SELECT COUNT(*)::int AS n FROM users")).rows[0].n,
      1,
    );
  } finally {
    await Promise.allSettled([source?.end(), target?.end()]);
    for (const n of names)
      await admin.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    await admin.end();
  }
});
