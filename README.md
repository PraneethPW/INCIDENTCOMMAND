# Incident Command AI

A real-time, multi-user incident operations platform. Live workspaces start empty and use operator records, monitored health endpoints, authenticated telemetry, and connected runtime APIs. An opt-in browser lab creates clearly marked test observations, separate from live metrics.

## 1. Install dependencies

Run these commands from the `INCIDENTCOMMAND` repository root. Node.js 22.12 or newer is required.

```bash
npm run install:all
```

Install dependencies before database setup. This installs the backend's `tsx` command as well as the frontend and root development tools.

## 2. Configure

Create the local environment files on macOS or Linux:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

On Windows PowerShell:

```powershell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

Edit `backend/.env`:

```env
DATABASE_URL=your_supabase_postgresql_connection_string
SESSION_SECRET=a_random_value_of_at_least_32_characters
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openrouter/free
PORT=8787
FRONTEND_URL=http://localhost:5173
```

`OPENROUTER_API_KEY` is optional until an operator runs root-cause analysis. The database and session secret are required. Run `npm run setup:secret` to generate the local session secret.

Use exactly one local environment file per app: `backend/.env` for server-only settings and `frontend/.env` for public frontend settings. No root `.env` is needed. Both local files are ignored by Git; the adjacent `.env.example` files are safe setup templates.

Leave `VITE_API_URL=` blank in `frontend/.env` to use the existing API proxy. Database credentials, session secrets, and AI keys belong only in `backend/.env` or Railway's environment variables. Vercel frontend variables are public build-time settings.

## 3. Initialize Supabase

```bash
npm run db:setup --prefix backend
```

This creates the schema only. It does not insert mock or sample data.

## 4. Run

```bash
npm run dev
```

Open `http://localhost:5173` and follow the product flow:

1. Create an operator account and private organization workspace.
2. Connect a production service with an optional health URL.
3. Use **Check now** or allow scheduled checks to report the service state.
4. Copy the service-specific ingest command into an application or monitoring pipeline.
5. Critical ingest events or repeated health-check failures automatically declare incidents.
6. Connected operators receive organization-scoped updates through Server-Sent Events.
7. Change incident status as response work progresses; every transition is persisted in the timeline.
8. Run AI analysis against the incident's real timeline, health checks, and telemetry.

## Real-time behavior

- Health endpoints are checked on their configured interval, with a 30-second minimum.
- Two consecutive failed checks mark a service down and create an incident.
- Recovery resolves health-monitor incidents and broadcasts the change.
- Critical keyed telemetry creates an incident immediately.
- Incident, service, analysis, and telemetry changes broadcast to all signed-in operators in the same organization.
- All application queries are scoped to the authenticated organization.

## API surface

- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET/POST /api/services`, `POST /api/services/:id/check`
- `GET/POST /api/incidents`, `PATCH /api/incidents/:id/status`
- `POST /api/incidents/:id/analyze`
- `POST /api/ingest/:serviceId` with `x-ingest-key`
- `GET /api/stream` for authenticated live events

## Stack

- Frontend: React, TypeScript, Tailwind CSS, Framer Motion, React Three Fiber, Recharts
- Backend: Express, TypeScript, Supabase PostgreSQL, signed HTTP-only sessions, SSE
- AI: OpenRouter with `openrouter/free` by default

## Operator controls and release verification

The cockpit includes incident search and filters, persisted responder notes and ownership, JSON incident export, service settings and monitoring pause, ingest-key rotation, recent signal history, and role-based workspace invitations and switching. Connection failures expose a retry action, and reconnecting live streams reload current records.

Health checks serialize per service; incident changes and their timelines commit together. Critical telemetry is deduplicated under concurrent requests. PostgreSQL notifications distribute committed updates across API replicas; Supabase uses a session-capable connection for the listener and a bounded connection pool for application traffic.

See [the operations runbook](docs/OPERATIONS.md) for deployment, database replacement, role permissions, verification, and the current capacity and feature limits. Run the integration suite only against an isolated `incident_test` database. GitHub Actions builds both applications, runs the suite with PostgreSQL, and lints the frontend.

## Docker and Kubernetes tracking

Open **Infrastructure**. Choose either workflow directly in the web app:

- **Live connections → Add connection**: connect Docker through Portainer (discover and select an environment), a secured Docker Engine API, or a Kubernetes API and namespace. Enter the HTTPS URL and read credentials, test access, then save. A service is created automatically unless you select an existing one. Inventory syncs every 30–300 seconds; Refresh, Pause/Resume, Reconnect and Remove are available in the same screen.
- **Browser test lab**: start a Docker or Kubernetes lab and choose a failure scenario. Inspect its test incident, timeline and optional AI analysis, then select **Restore healthy** to verify simulated recovery. Ending a session retains its history. No container or cluster is executed or modified by this lab. Test services/incidents stay out of live dashboard metrics and are available through the incident queue's **Test lab incidents** filter.

Real connections require an existing public, reachable HTTPS runtime API. The hosted app cannot access Docker Desktop's local socket or a private cluster directly. Custom CA and client TLS PEM uploads are supported; TLS verification stays enabled. Remote requests are GET-only, pinned to validated public DNS addresses, limited in size/time, and do not follow redirects. Credentials are encrypted at rest using a key derived from the backend session secret (or optional stable `RUNTIME_CREDENTIALS_KEY`); keep that key consistent across replicas and backups. Changing it requires reconnecting saved integrations.

The existing host/in-cluster collector remains an advanced option for private infrastructure. See [runtime connections, lab scenarios, detection rules and collector setup](docs/CONTAINER-TRACKING.md). No root environment file is required.

## Supabase connection and historical data

See [Supabase setup and verified migration](docs/SUPABASE-MIGRATION.md) for TLS, session pooling, row security, data preservation and cutover checks. Switching the database URL creates no historical data copy. The migration command refuses to overwrite existing destination records.
