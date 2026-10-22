# Incident Command AI

A real-time, multi-user incident operations platform. The application starts with zero operational records and uses only data created by signed-in users, monitored health endpoints, or authenticated telemetry ingest.

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
DATABASE_URL=your_neon_connection_string
SESSION_SECRET=a_random_value_of_at_least_32_characters
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=openrouter/free
PORT=8787
FRONTEND_URL=http://localhost:5173
```

`OPENROUTER_API_KEY` is optional until an operator runs root-cause analysis. The database and session secret are required. Run `npm run setup:secret` to generate the local session secret.

Use exactly one local environment file per app: `backend/.env` for server-only settings and `frontend/.env` for public frontend settings. No root `.env` is needed. Both local files are ignored by Git; the adjacent `.env.example` files are safe setup templates.

Leave `VITE_API_URL=` blank in `frontend/.env` to use the existing API proxy. Database credentials, session secrets, and AI keys belong only in `backend/.env` or Railway's environment variables. Vercel frontend variables are public build-time settings.

## 3. Initialize Neon

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
- Backend: Express, TypeScript, Neon PostgreSQL, signed HTTP-only sessions, SSE
- AI: OpenRouter with `openrouter/free` by default

## Operator controls and release verification

The cockpit includes incident search and filters, persisted responder notes and ownership, JSON incident export, service settings and monitoring pause, ingest-key rotation, recent signal history, and role-based workspace invitations and switching. Connection failures expose a retry action, and reconnecting live streams reload current records.

Health checks serialize per service; incident changes and their timelines commit together. Critical telemetry is deduplicated under concurrent requests. PostgreSQL notifications distribute committed updates across API replicas; Neon uses a direct connection for the listener and pooled connections for application traffic.

See [the operations runbook](docs/OPERATIONS.md) for deployment, database replacement, role permissions, verification, and the current capacity and feature limits. Run the integration suite only against an isolated `incident_test` database. GitHub Actions builds both applications, runs the suite with PostgreSQL, and lints the frontend.
