# Incident Command frontend

React and TypeScript cockpit for organization-scoped service monitoring and incident response. The landing visualization and command-center screens are loaded separately; the 3D hero has a fallback when WebGL is unavailable.

For the complete local application, follow the repository's [installation guide](../README.md#local-installation). From the repository root, install dependencies, run `npm run setup:local`, configure `backend/.env`, run database setup, then `npm run dev`.

Frontend-only commands from this folder:

```sh
npm ci
npm run dev
npm run build
npm run lint
# After a build, with the local backend already running:
npm run preview
```

Use `frontend/.env` for public frontend settings only. Leave `VITE_API_URL=` blank for a local backend; no root environment file is required. Both development and preview use **http://localhost:5173** and forward `/api` to **http://localhost:8787**. Port 5173 must be available. The backend's local `FRONTEND_URL` should be `http://localhost:5173` and `NODE_ENV` should be `development` for local HTTP sessions.

Production `/api` requests are forwarded to Railway by `vercel.json`. Keep database credentials and AI keys in the backend environment. Restart Vite after editing frontend settings.

Open `/#/app` to enter the command center directly and retain that entry point across refreshes. See the repository's [operations runbook](../docs/OPERATIONS.md) for configuration and known limits.
