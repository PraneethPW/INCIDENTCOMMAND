# Docker and Kubernetes incident tracking

Infrastructure connects runtime state to services, incidents, timelines, AI evidence and organization-scoped live updates.

## Web app workflow (default)

**Infrastructure → Live connections → Add connection** supports Docker via Portainer, secured Docker Engine APIs and namespace-scoped Kubernetes APIs. Supply the API HTTPS address and read credentials, use Test connection, and save. Portainer's Find environments button discovers Docker environments before testing. Optional PEM uploads support custom CAs and mutual TLS. The backend polls automatically and offers Refresh, Pause/Resume, Reconnect and Remove. A removed connection deletes saved credentials while preserving observation and incident history.

Docker connections list containers and inspect their state. Kubernetes connections require list access to Pods, Deployments, StatefulSets and DaemonSets in the selected namespace. All remote requests are GET-only; use a read-restricted API identity/gateway. Docker API credentials themselves can be privileged, so keep them narrowly scoped at the gateway. Failed or partial inventory reads retain previous evidence and never resolve incidents. More than 200 matching resources requires a narrower label selector or namespace. Each workspace supports up to 10 saved connections; polling intervals are 30–300 seconds.

Only public HTTPS destinations are accepted in production. Private addresses, embedded credentials, redirects and failed server certificate verification are rejected. Local-only Docker Desktop or private Kubernetes endpoints need an existing reachable API/gateway or the advanced collector below. No browser can directly reach the laptop's Unix socket through the hosted backend.

**Infrastructure → Browser test lab** needs no setup. Start Docker or Kubernetes, select a controlled failure, inspect the test incident and choose Restore healthy. Docker scenarios cover health failure, pause, crash, OOM and disappearance. Kubernetes scenarios cover crash loop, image pull, readiness, replica loss and disappearance. Stable simulated resource identities demonstrate incident deduplication and verified simulated recovery. Missing resources retain open incidents. Up to 10 labs may be active per workspace. Ending a session archives it without changing its incidents.

The lab submits labelled synthetic observations to the same incident engine; it does not launch or alter workloads. Test services, inventory and incidents are excluded from live defaults and metrics. Select Test lab incidents in the queue to review retained history. AI receives the test flag and is instructed to describe the evidence as simulated. A session's scenario changes only on user action; no background lab heartbeats are generated.

Connection credentials use authenticated AES-256-GCM encryption scoped to the workspace and connection. Keep SESSION_SECRET, or the optional dedicated RUNTIME_CREDENTIALS_KEY, stable across replicas and restores. Credentials are never returned by list APIs. Workspace administrators manage connections; responders may refresh and run labs; viewers can inspect only. New tables are protected from Supabase's public Data API by RLS and revoked client grants.

## Advanced collector setup

The following optional commands are for hosts or clusters that push inventory instead of using the web connection form.

## Quick start: Docker host

1. Install the repository dependencies as described in the README. The collector needs Node.js 22+ and the Docker CLI connected to the monitored daemon.
2. In **Services**, connect a service. Its health URL may be blank when using only runtime observations.
3. Use the environment settings below in Bash from the repository root on the Docker host. Copy the service ID and ingest key from Services; supply the key when prompted and do not paste it into tracked files.
4. Give each monitored host a stable, unique `RUNTIME_CLUSTER`. Optional `RUNTIME_SELECTOR=app=orders` narrows the Docker inventory to containers with that label. When using Compose, `RUNTIME_SELECTOR=com.docker.compose.project=myproject` selects one project.
5. Run `npm run collector`. Add `-- --once` for a single snapshot. Leave it running under your normal process supervisor for continuous tracking.

The collector runs `docker ps --all` and `docker inspect` without modifying containers. It forwards only resource identity, selected state, image ID, restart count, and Compose project name. Environment variables, arbitrary labels, health-check output and raw logs are excluded. Docker daemon access is privileged even for inspection; keep this process on a trusted host. The web API has no Docker socket.

A minimal Bash setup, with placeholders:

```bash
read -r -s -p 'Service ingest key: ' INCIDENT_INGEST_KEY; echo
export INCIDENT_INGEST_KEY
export INCIDENT_API_URL=https://incident-command-ai.vercel.app
export INCIDENT_SERVICE_ID=YOUR_SERVICE_UUID
export RUNTIME_PLATFORM=docker
export RUNTIME_CLUSTER=docker-host-01
export RUNTIME_INTERVAL_SECONDS=30
npm run collector
```

No extra `.env` is required. App configuration remains in `backend/.env` and `frontend/.env`; collectors use their process environment or Kubernetes Secret references.

## Kubernetes: local kubectl

Use the same setup, with:

```bash
export RUNTIME_PLATFORM=kubernetes
export RUNTIME_CLUSTER=cluster-01-orders
export KUBE_NAMESPACE=orders
# Optional: KUBE_CONTEXT=my-context and RUNTIME_SELECTOR=app=orders
npm run collector
```

The collector reads Pods, Deployments, StatefulSets and DaemonSets in **one namespace**. Give each `(service, platform, cluster)` combination exactly one active collector and a stable scope. Use a different `RUNTIME_CLUSTER` for another namespace, context or selector. Changing scope under the same identity makes excluded resources appear missing. Keep kubectl within one minor version of the API server.

## Kubernetes: in-cluster collector

The manifest at `deploy/kubernetes/collector.yaml` includes a ServiceAccount, namespace Role, RoleBinding, and one collector Deployment. Permissions are limited to `get/list` for Pods and the three workload types; there is no Secrets, pod exec/logs, node, cluster-admin, or mutation permission.

Build the **Kubernetes collector image** from the repository root. Its default kubectl version is pinned; choose one compatible with your API server:

```bash
docker build -f scripts/runtime/Dockerfile \
  --build-arg KUBECTL_VERSION=v1.37.2 \
  -t YOUR_REGISTRY/incident-collector:VERSION .
docker push YOUR_REGISTRY/incident-collector:VERSION
```

Edit every namespace occurrence, the image tag, API URL, service UUID, and cluster identity in the manifest. Create the `incident-collector` Secret in that same namespace through your secret manager, with a key named `ingest-key` containing the existing service ingest key. Do not commit Secret values. Then:

```bash
kubectl apply -f deploy/kubernetes/collector.yaml
kubectl -n YOUR_NAMESPACE rollout status deployment/incident-collector
```

The pod runs as an unprivileged user with a read-only root filesystem, dropped Linux capabilities, resource limits and a small disposable `/tmp`. Apply your cluster's egress policy so the collector can reach only the Kubernetes API, DNS and the Incident Command API. No network policy is installed automatically because endpoint addresses and CNI capabilities vary.

## Detection and lifecycle

| Observation | Interpretation |
| --- | --- |
| Docker unhealthy, restarting, dead, nonzero exit or OOMKilled | Down; critical incident |
| Docker paused | Degraded; high incident |
| Docker running | Healthy runtime observation; without a Docker healthcheck this does not establish HTTP availability |
| Docker successful exit code 0 | Completed; expected one-shot completion is not an incident |
| Pod CrashLoopBackOff, image pull/config/run errors, failed nonzero termination | Down; critical incident; last termination reason retained when available |
| Pod Failed phase | Down; critical incident |
| Pod unschedulable or not Ready after 120s | Degraded; high incident |
| New Pod/workload within readiness grace, unobserved controller generation, terminating Pod | Unknown; no new incident and no automatic resolution |
| Workload replica loss | Degraded when partly available; down at zero ready replicas after startup grace |
| Workload progress deadline / replica failure | Down |
| Pod Ready, desired replicas Ready, successful completion or scale to zero | Verified runtime recovery; closes that resource's open incident |
| Resource disappears from a complete inventory | Missing; retain its incident for human review |
| No source heartbeat for max(90s, 3 × interval) | Stale; last reported health is not treated as current health |

Each resource UID has at most one open runtime incident. Concurrent/replayed snapshots are deduplicated and older observations cannot undo newer ones. A later failure after recovery opens a new incident. Pod replacement has a new UID: review the old missing Pod's incident separately. Health-monitor and generic telemetry incidents remain independent. Runtime failure does not rewrite a service's HTTP check state.

The collector submits a complete scope inventory, bounded to 200 resources. If collection fails or exceeds this bound, nothing is submitted; narrow the selector rather than silently truncating. Interval bounds are 15–300 seconds. The UI loads at most 1,000 resources and 100 sources, labels counts as loaded records, and refreshes through SSE and the existing fallback. Historical missing resources remain stored; choose an explicit retention policy for long-lived clusters.

## API and migration

Run `npm run db:setup --prefix backend` using the target database before deploying this release. The additive, idempotent schema setup includes runtime sources/resources, encrypted connections, lab sessions, test flags and incident deduplication indexes; it creates no demo records. Rollback may leave these additions in place. The existing Railway pre-deploy runs this setup. The frontend gates web forms and labs on the backend runtimeWorkspace capability, retaining the older inventory screen during a mixed-version rollout.

- `POST /api/ingest/:serviceId/runtime`: `x-ingest-key` required; snapshot schema below. Never send kubeconfig, environment variables, secrets, arbitrary shell output or raw Docker inspection JSON.
- `GET/POST /api/runtime/connections`, `POST /api/runtime/connections/test`, `POST /api/runtime/connections/discover`, `PUT/PATCH/DELETE /api/runtime/connections/:id`, `POST /api/runtime/connections/:id/sync`. Connection management requires an administrator; refresh allows responders.
- `GET/POST /api/runtime/labs`, `POST /api/runtime/labs/:id/scenario`, `POST /api/runtime/labs/:id/end`. Viewers cannot mutate sessions.
- `GET /api/incidents?scope=live|test|all` defaults to live.
- `GET /api/infrastructure`: session required; only the active organization is returned. Viewers can read state but cannot obtain service ingest keys.

```json
{
  "platform": "kubernetes",
  "cluster": "cluster-01-orders",
  "observedAt": "REPLACE_WITH_CURRENT_ISO_TIMESTAMP",
  "intervalSeconds": 30,
  "resources": [{
    "uid": "RESOURCE_UID", "name": "orders-api-abc", "namespace": "orders", "kind": "Pod",
    "status": "down", "reason": "CrashLoopBackOff (last exit: OOMKilled)",
    "image": "registry/orders@sha256:IMAGE_DIGEST", "restartCount": 5, "ready": 0, "desired": 1
  }]
}
```

Only declared schema fields are accepted. Snapshot timestamps must be within ten minutes, at most one minute ahead of server time. Changed resource state/reason is persisted as telemetry; incident transitions retain structured evidence. AI receives the linked resource's current state, freshness, image and identity alongside the existing timeline and telemetry. Suggestions remain advisory.

## Run the application with Docker Compose

Configure the existing two app `.env` files and the database first. `backend/.env` must use a database reachable **from the container**; a host-local database needs `host.docker.internal` on Docker Desktop. No root `.env` is used.

```bash
docker compose build
docker compose run --rm backend node dist/setup-db.js
docker compose up -d
```

Open `http://localhost:8080`. The frontend proxies `/api` and SSE to the backend. This Compose file is a local, loopback-only setup with development cookie settings. For an internet-facing deployment use HTTPS, `NODE_ENV=production`, and your exact frontend origin. Existing Vercel/Railway deployment remains supported; no cluster or Docker daemon is required for the API itself.

## Relationship to the Digital Twin proposal

This release supplies runtime identity, images, readiness/restart evidence, incident correlation and a separate collector deployment. It is the observability foundation for a future incident-time snapshot and executable twin. It does not claim to reconstruct a service topology, reproduce faults, execute remediation trials, calculate fidelity/safety scores or authorize production changes. Those experiments require a separately isolated worker, sanitized workloads, measured evidence, policy checks and an explicit approval workflow as described in the proposal. The repository's existing Express/PostgreSQL stack is retained.

## Verify

```bash
npm run test:collector
npm run build
npm run lint --prefix frontend
NODE_ENV=test DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/incident_test \
  SESSION_SECRET=integration-test-secret-at-least-32-characters npm test --prefix backend
```

Tests use sanitized Docker/Kubernetes fixtures for runtime adapters and an isolated real PostgreSQL database for authentication, organization isolation, concurrent alert deduplication, missing/stale handling, key rotation, timestamp replay rejection and recovery. An actual Docker daemon and Kubernetes cluster are separately required to validate your deployment and permissions. In a disposable namespace, reproduce a failed test Pod, observe its incident, then restore the same test resource to a healthy state; verify timeline recovery and connected-browser updates. Never inject faults into production to test this feature.
