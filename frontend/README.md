# Incident Command frontend

React and TypeScript cockpit for organization-scoped service monitoring and incident response. The landing visualization and command-center screens are loaded separately; the 3D hero has a fallback when WebGL is unavailable.

```sh
npm ci
npm run dev
npm run build
npm run lint
```

Local `/api` requests are forwarded to port 8787 by Vite. Production `/api` requests are forwarded to Railway by `vercel.json`. Prefer this same-origin setup for sessions and SSE. `VITE_API_URL` can override the API origin where cross-origin cookies are explicitly supported.

Open `/#/app` to enter the command center directly and retain that entry point across refreshes. See the repository's [operations runbook](../docs/OPERATIONS.md) for configuration and known limits.
