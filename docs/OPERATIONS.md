# Operating Incident Command

## Production layout

The Vercel frontend forwards `/api/*` to Railway. Keep frontend requests on this same origin so HTTP-only cookies and the EventSource stream work without depending on third-party cookies. Railway runs the API and scheduled health monitor; PostgreSQL holds organization-scoped records. OpenRouter is called only when an operator requests analysis.

Railway settings:

- Repository root: `/backend`
- Build: `npm ci && npm run build`
- Pre-deploy: `npm run db:setup` after the release schema has been reviewed
- Start: `npm start`
- Healthcheck: `/api/health`
- Node: 22 or newer
- `NODE_ENV=production`
- `FRONTEND_URL=https://incident-command-ai.vercel.app` (comma-separated exact origins if needed)
- `DATABASE_URL`: the pooled PostgreSQL connection string
- `SESSION_SECRET`: at least 32 random characters; retain it across restarts
- `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`: the configured provider and model
- Optional `OPENROUTER_FALLBACK_MODELS`: comma-separated fallback model IDs; at most two total attempts run
- Optional `DATABASE_LISTEN_URL`: a direct, session-capable PostgreSQL connection. For Neon, the application derives it by removing `-pooler` from the hostname.

The direct connection is required for `LISTEN`; notifications are issued through regular pooled queries. Each API replica subscribes to committed database events and forwards them only to the matching organization. Transports reconnect every five minutes to renew session authorization. A reconnect refreshes the current snapshot, and a visible cockpit refreshes every minute to recover from missed frames. The feed is a session activity feed, not a durable event replay; the incident timeline remains the durable record.

## Release and rollback

1. Run backend and frontend builds, lint, and the PostgreSQL integration suite. GitHub Actions performs these checks on pull requests.
2. Confirm the database is reachable and has quota available. `/api/health` returns 503 if it cannot read the schema.
3. Back up the database before a migration. `backend/schema.sql` is idempotent and creates no sample records. Run `npm run db:setup` from the backend directory using the target connection.
4. Merge the reviewed release. Verify both Vercel and Railway deployed the intended commit.
5. Verify registration/sign-in, service connection, a health check, an incident timeline update, and the live stream in a disposable organization. Verify AI separately with an authorized test incident and an available configured model.
6. For an application rollback, redeploy the previous Railway release and Vercel deployment. The added invitation table is additive and can remain in place. Database replacement is separate: switching the connection does not migrate users or operational records from the previous database.

Do not paste credentials into issue descriptions, source files, screenshots, or reports. An ingest key is returned only to operators with write access and never included in live notifications. Key rotation invalidates the previous key immediately.

## Operator workflow

1. Create a workspace or sign in. A new workspace starts empty; its creator is the owner.
2. Connect a service using a public HTTP(S) health URL, expected HTTP status, region, and a 30–3600 second interval. Telemetry-only services can omit the URL.
3. Run **Check now**. One failed check degrades the service; the second declares a critical health incident. A healthy check resolves open incidents created by that health monitor. Redirects are not followed: monitor the final health URL directly.
4. Copy the ingest command from the service card. It uses the current application origin in production. Critical telemetry declares one active telemetry incident per service; subsequent critical signals update its evidence. Warning and informational signals are stored without declaring incidents. A health recovery does not automatically resolve telemetry incidents.
5. Use the incident queue filters, assign a responder, add notes, and move through investigating, identified, monitoring, and resolved. Repeating the same status does not duplicate the timeline event or reset the resolution timestamp.
6. Run analysis when needed. It uses stored incident context, timeline, service checks, and telemetry. Unchanged evidence reuses the saved result. If the provider fails, the last result remains visible with a stale warning. Recommendations are advisory and do not execute production changes.
7. Export an incident as JSON for a handoff or review. Check customer impact and timeline details before sharing it.
8. Use service settings to change endpoints and intervals or pause scheduled monitoring. A paused service can still be checked manually and receive telemetry. Signal history shows the last 30 checks and telemetry events.

## Team access

Owners and admins can create single-use invitation codes that expire after 48 hours. Share the code through an approved channel. A teammate creates an account, opens **Team & access**, and enters the code. The app switches into the invited workspace. Members of multiple workspaces can switch there later.

- Owner: services, incident operations, invitations, and role changes. Owner role cannot be downgraded through the role endpoint.
- Admin: services, incident operations, responder/viewer invitations.
- Responder: health checks, incident operations, analysis, and ingest commands.
- Viewer: read-only workspace access; ingest keys and mutation controls are restricted.

## Capacity and troubleshooting

- Continuous monitoring uses database compute. The original production outage was a database quota exhaustion; replacing a connection does not remove the need for capacity monitoring.
- Scheduled probes use at most three database connections concurrently, leaving connections for interactive requests. Each probe has a network deadline. The scheduler handles batches of 25 due services, so a large backlog can delay checks beyond their nominal interval.
- API rate limits are per process: 30 authentication requests per 15 minutes per client IP, 600 ingest requests per minute per client IP, and 6 analyses per minute per organization. A shared gateway/rate-limit store is needed for a strict cluster-wide budget.
- The incident queue currently shows the newest 100 records, with unresolved records first. The count and local filters describe those loaded records. There is no archived-history pagination in this release.
- Stored checks, telemetry, incidents, and analyses have no automatic deletion policy. Set an explicit retention and backup policy before high-volume ingestion.
- Password reset, SSO, email verification, outbound paging, and automatic remediation execution are outside this release. Invitations are copied codes; the app does not send invitation emails.
- If the stream reconnects repeatedly, check the Vercel API rewrite, Railway logs, direct database connection, and origin configuration. The cockpit's snapshot refresh provides recovery, but a permanently broken live connection still requires investigation.
- If AI is unavailable, check the configured model, provider quota, key, and response support. Free provider availability varies. Automated tests validate the provider contract with a controlled response; they do not prove availability of a live provider.

## Verification

Use an isolated PostgreSQL database whose name contains `incident_test`:

```sh
NODE_ENV=test \
DATABASE_URL=postgresql://postgres:test@localhost:5432/incident_test \
SESSION_SECRET=integration-test-secret-at-least-32-characters \
npm test --prefix backend
```

The suite covers authentication and origin checks, organization isolation, concurrent alert deduplication, incident lifecycle/notes/ownership, key rotation, monitor recovery, rollback, invitations and viewer permissions, public health URL policy, committed SSE notifications, and AI cache/stale-provider behavior. It cleans up only its own generated records. Do not point the test suite at production.
