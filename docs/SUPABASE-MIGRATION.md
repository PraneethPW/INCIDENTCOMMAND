# Supabase database and data migration

The application uses Supabase-hosted PostgreSQL through its existing Express backend. Authentication, password hashes, organization boundaries, ingest keys, incident history and PostgreSQL LISTEN/NOTIFY remain application-owned. No database password, service-role key, or direct database client belongs in the frontend.

## Runtime configuration

Keep one local file per app: `backend/.env` and `frontend/.env`. No root environment file is needed. Railway supplies the production backend variables.

- `DATABASE_URL`: a complete Postgres URL with the real database password, not the HTTPS project API URL or a password placeholder.
- `DATABASE_LISTEN_URL`: a direct connection or Supabase **Session pooler, port 5432**. The default is `DATABASE_URL`. Transaction pooling on port 6543 cannot preserve LISTEN subscriptions.
- `DATABASE_POOL_MAX=5`: bounded application pool; the listener uses one additional session per replica.
- `DATABASE_SSL_CA`: optional reviewed replacement CA. Supabase hosts use the bundled public Supabase Root 2021 CA by default, with certificate and hostname verification enabled. See `backend/certs/README.md` for provenance and expiry.
- `SESSION_SECRET`: retain the same secret during a database migration so existing sessions can continue when the corresponding user/membership rows are copied.

Copy host and username from **Supabase Dashboard → Connect**, rather than guessing a pooler host from its region. Direct Supabase connections may require IPv6; use the Session pooler when the runtime only supports IPv4. Current Railway settings enable IPv6 egress for the direct connection.

Run `npm run db:setup --prefix backend`, or `node dist/setup-db.js` in the production image. Schema setup is additive, transactional and serialized with an advisory lock. Configure the latter as Railway's pre-deploy command. The backend health check validates required runtime and collaboration tables before declaring readiness.

All application tables have RLS enabled and no public-client policies; privileges are revoked from Supabase's `anon` and `authenticated` roles. The backend connects as the table owner. Its own session authentication and organization-scoped queries remain the authorization boundary. These tables are not a public Supabase client API.

## Historical data migration

Preparing a schema or changing a connection string does **not** transfer data. The source must be readable, or an existing PostgreSQL backup must be restored to a temporary source first. A quota-blocked source cannot be exported by this tool.

Put `MIGRATION_SOURCE_DATABASE_URL` and `MIGRATION_TARGET_DATABASE_URL` in the operator process environment or existing ignored `backend/.env`. Do not paste credentials into commands, source, logs or issue descriptions. Optional `MIGRATION_SOURCE_SSL_CA` and `MIGRATION_TARGET_SSL_CA` support reviewed provider certificates.

```bash
# Inspect only: no schema or record changes.
npm run db:migrate --prefix backend

# Copy and verify, only after the source/destination are confirmed.
npm run db:migrate --prefix backend -- --execute
```

The migrator:

1. Refuses an uninitialized source, additional unmapped source tables, unmapped columns, or a nonempty application destination. It never drops/truncates data or silently merges conflicting records.
2. Holds a consistent source snapshot and share-locks source tables during execution. Arrange a maintenance window: writes are blocked while copying, and producers must use the new backend after cutover.
3. Creates the current target schema in one transaction, copies all application tables in foreign-key order, and preserves IDs, password hashes, memberships, keys, JSON, exact BIGINT values and timestamp microseconds.
4. Compares counts and SHA-256 fingerprints of every copied column in primary-key order, then restores sequences safely. A mismatch rolls back destination changes.
5. Prints only table counts/checksums, never row data or connection strings. The original source remains intact.

Stop source writers for the final cutover and keep a protected backup. After verification, update Railway's `DATABASE_URL` and session-capable listener URL, deploy, and verify sign-in, existing records, telemetry, live events, runtime recovery and AI. Keep the old source offline/read-only until the recovery window ends. Remove temporary migration variables afterward. Do not delete the original database while its history is still unrecovered.

## Current cutover limitation

The destination schema was initialized through the connected Supabase integration. The previous application's historical source was unavailable due to its provider quota. No historical export or data-copy success is claimed. A Supabase deployment can operate with new workspaces while historical recovery remains a separate pending task; the current migrator intentionally refuses to overwrite such a nonempty destination, so that recovery requires an explicitly planned merge or isolated restore.
