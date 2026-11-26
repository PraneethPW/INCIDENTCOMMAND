import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { PoolClient } from "pg";
import { requirePool, transaction } from "./database.js";
import { httpError, rateLimit, requireAdmin } from "./security.js";
import { newIngestKey } from "./monitor.js";
import {
  ingestRuntime,
  runtimeSnapshotSchema,
  type RuntimeSnapshot,
} from "./runtime-ingest.js";
import {
  connectionInput,
  collectRemote,
  discoverEnvironments,
  encryptCredentials,
  decryptCredentials,
  type ConnectionInput,
} from "./runtime-remote.js";

export const runtimeWorkspace = Router();
const columns = `id,service_id AS "serviceId",name,provider,endpoint_url AS "endpointUrl",namespace,
 environment_id AS "environmentId",selector,interval_seconds AS "intervalSeconds",enabled,
 last_status AS "lastStatus",last_error AS "lastError",last_checked_at AS "lastCheckedAt",created_at AS "createdAt"`;
const idSchema = z.string().uuid();
const platformOf = (provider: string) =>
  provider === "kubernetes" ? "kubernetes" : "docker";
const snapshot = (
  input: ConnectionInput,
  id: string,
  resources: RuntimeSnapshot["resources"],
) =>
  runtimeSnapshotSchema.parse({
    platform: platformOf(input.provider),
    cluster: `web:${id}`,
    intervalSeconds: input.intervalSeconds,
    observedAt: new Date().toISOString(),
    resources,
  });
function credentials(input: ConnectionInput) {
  return {
    token: input.token,
    certificateAuthority: input.certificateAuthority,
    clientCertificate: input.clientCertificate,
    clientKey: input.clientKey,
  };
}
async function createService(
  db: PoolClient,
  org: string,
  name: string,
  isTest: boolean,
) {
  return (
    await db.query(
      `INSERT INTO services(organization_id,name,slug,description,region,ingest_key,is_test,monitoring_enabled)
    VALUES($1,$2,$3,$4,'runtime',$5,$6,FALSE) RETURNING id`,
      [
        org,
        name,
        `runtime-${randomUUID().slice(0, 8)}`,
        isTest ? "Controlled browser test lab" : "Web runtime connection",
        newIngestKey(),
        isTest,
      ],
    )
  ).rows[0].id as string;
}
async function lockOrg(db: PoolClient, org: string) {
  await db.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [org]);
}
runtimeWorkspace.get("/runtime/connections", async (req, res) => {
  res.json({
    data: (
      await requirePool().query(
        `SELECT ${columns} FROM runtime_connections WHERE organization_id=$1 ORDER BY created_at DESC`,
        [req.user!.organizationId],
      )
    ).rows,
  });
});
runtimeWorkspace.use("/runtime/connections", rateLimit(30, 60_000));
runtimeWorkspace.post(
  "/runtime/connections/discover",
  requireAdmin,
  async (req, res) => {
    const input = connectionInput.parse(req.body);
    if (input.provider !== "portainer")
      throw httpError(
        400,
        "Environment discovery is available for Portainer connections.",
      );
    res.json({ data: await discoverEnvironments(input) });
  },
);
runtimeWorkspace.post(
  "/runtime/connections/test",
  requireAdmin,
  async (req, res) => {
    const input = connectionInput.parse(req.body);
    const inventory = snapshot(input, randomUUID(), await collectRemote(input));
    res.json({
      data: { resources: inventory.resources, checkedAt: inventory.observedAt },
    });
  },
);
runtimeWorkspace.post(
  "/runtime/connections",
  requireAdmin,
  async (req, res) => {
    const input = connectionInput.parse(req.body),
      org = req.user!.organizationId,
      id = randomUUID();
    const inventory = snapshot(input, id, await collectRemote(input));
    await transaction(async (db) => {
      await lockOrg(db, org);
      const count = await db.query(
        "SELECT COUNT(*)::int AS n FROM runtime_connections WHERE organization_id=$1",
        [org],
      );
      if (count.rows[0].n >= 10)
        throw httpError(
          400,
          "This workspace already has 10 runtime connections.",
        );
      let serviceId = input.serviceId;
      if (
        serviceId &&
        !(
          await db.query(
            "SELECT id FROM services WHERE id=$1 AND organization_id=$2 AND NOT is_test",
            [serviceId, org],
          )
        ).rowCount
      )
        throw httpError(404, "Service not found");
      serviceId ||= await createService(db, org, input.name, false);
      await db.query(
        `INSERT INTO runtime_connections(id,organization_id,service_id,name,provider,endpoint_url,namespace,environment_id,selector,credentials,interval_seconds,last_checked_at,next_check_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW()+make_interval(secs=>$11::int))`,
        [
          id,
          org,
          serviceId,
          input.name,
          input.provider,
          input.endpointUrl,
          input.namespace,
          input.environmentId || null,
          input.selector,
          encryptCredentials(credentials(input), `${org}:${id}`),
          input.intervalSeconds,
        ],
      );
      await ingestRuntime(
        serviceId!,
        inventory,
        { organizationId: org, origin: "connection", connectionId: id },
        db,
      );
    });
    res.status(201).json({ data: { id } });
  },
);
runtimeWorkspace.patch(
  "/runtime/connections/:id",
  requireAdmin,
  async (req, res) => {
    const id = idSchema.parse(req.params.id),
      org = req.user!.organizationId;
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(req.body);
    const result = await requirePool().query(
      `UPDATE runtime_connections SET enabled=$3,updated_at=NOW(),next_check_at=NOW(),lease_token=NULL,lease_until=NULL,
    last_status=CASE WHEN $3 THEN 'pending' ELSE 'paused' END WHERE id=$1 AND organization_id=$2 RETURNING id`,
      [id, org, enabled],
    );
    if (!result.rowCount) throw httpError(404, "Connection not found");
    res.json({ data: { id, enabled } });
  },
);
runtimeWorkspace.delete(
  "/runtime/connections/:id",
  requireAdmin,
  async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const removed = await requirePool().query(
      "DELETE FROM runtime_connections WHERE id=$1 AND organization_id=$2 RETURNING id",
      [id, req.user!.organizationId],
    );
    if (!removed.rowCount) throw httpError(404, "Connection not found");
    // Inventory and incident history remain; deleting a connection removes its encrypted credentials.
    res.json({ data: { id } });
  },
);
runtimeWorkspace.put(
  "/runtime/connections/:id",
  requireAdmin,
  async (req, res) => {
    const input = connectionInput.parse(req.body),
      id = idSchema.parse(req.params.id),
      org = req.user!.organizationId;
    const prior = (
      await requirePool().query(
        "SELECT service_id,provider FROM runtime_connections WHERE id=$1 AND organization_id=$2",
        [id, org],
      )
    ).rows[0];
    if (!prior) throw httpError(404, "Connection not found");
    if (
      prior.provider !== input.provider ||
      (input.serviceId && input.serviceId !== prior.service_id)
    )
      throw httpError(
        400,
        "Create a new connection to change its provider or service.",
      );
    const inventory = snapshot(input, id, await collectRemote(input));
    await transaction(async (db) => {
      const updated = await db.query(
        `UPDATE runtime_connections SET name=$3,endpoint_url=$4,namespace=$5,environment_id=$6,selector=$7,credentials=$8,interval_seconds=$9,
      enabled=TRUE,last_status='connected',last_error=NULL,last_checked_at=NOW(),next_check_at=NOW()+make_interval(secs=>$9::int),updated_at=NOW(),lease_token=NULL,lease_until=NULL
      WHERE id=$1 AND organization_id=$2 RETURNING service_id`,
        [
          id,
          org,
          input.name,
          input.endpointUrl,
          input.namespace,
          input.environmentId || null,
          input.selector,
          encryptCredentials(credentials(input), `${org}:${id}`),
          input.intervalSeconds,
        ],
      );
      if (!updated.rowCount) throw httpError(404, "Connection not found");
      await ingestRuntime(
        updated.rows[0].service_id,
        inventory,
        { organizationId: org, origin: "connection", connectionId: id },
        db,
      );
    });
    res.json({ data: { id } });
  },
);

export async function syncConnection(id: string, org?: string) {
  const lease = randomUUID();
  const row = (
    await requirePool().query(
      `UPDATE runtime_connections SET lease_token=$3,lease_until=NOW()+INTERVAL '45 seconds'
    WHERE id=$1 AND ($2::uuid IS NULL OR organization_id=$2) AND enabled AND (lease_until IS NULL OR lease_until<NOW()) RETURNING *`,
      [id, org || null, lease],
    )
  ).rows[0];
  if (!row)
    throw httpError(
      409,
      "Connection is paused, busy, or unavailable. Refresh its status and retry.",
    );
  try {
    const input = connectionInput.parse({
      name: row.name,
      provider: row.provider,
      endpointUrl: row.endpoint_url,
      namespace: row.namespace,
      environmentId: row.environment_id || undefined,
      selector: row.selector,
      intervalSeconds: row.interval_seconds,
      ...decryptCredentials(
        row.credentials,
        `${row.organization_id}:${row.id}`,
      ),
    });
    const inventory = snapshot(input, id, await collectRemote(input));
    await transaction(async (db) => {
      const current = await db.query(
        `UPDATE runtime_connections SET last_status='connected',last_error=NULL,last_checked_at=NOW(),
        next_check_at=NOW()+make_interval(secs=>interval_seconds),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2 AND enabled RETURNING id`,
        [id, lease],
      );
      if (current.rowCount)
        await ingestRuntime(
          row.service_id,
          inventory,
          {
            organizationId: row.organization_id,
            origin: "connection",
            connectionId: id,
          },
          db,
        );
    });
    return { resources: inventory.resources.length };
  } catch (error) {
    // Only deliberately sanitized adapter errors may be stored or exposed.
    const message =
      (error as { status?: number }).status === 400
        ? (error as Error).message
        : "Inventory could not be refreshed. Test or reconnect this connection.";
    await requirePool().query(
      `UPDATE runtime_connections SET last_status='error',last_error=$3,last_checked_at=NOW(),
      next_check_at=NOW()+make_interval(secs=>interval_seconds),lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2`,
      [id, lease, message],
    );
    throw httpError(400, message);
  }
}
runtimeWorkspace.post("/runtime/connections/:id/sync", async (req, res) => {
  const id = idSchema.parse(req.params.id),
    org = req.user!.organizationId;
  if (
    !(
      await requirePool().query(
        "SELECT id FROM runtime_connections WHERE id=$1 AND organization_id=$2",
        [id, org],
      )
    ).rowCount
  )
    throw httpError(404, "Connection not found");
  res.json({ data: await syncConnection(id, org) });
});
export function startRuntimeConnections() {
  let stopped = false,
    running = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const due = await requirePool().query(
        `SELECT id FROM runtime_connections WHERE enabled AND next_check_at<=NOW() AND (lease_until IS NULL OR lease_until<NOW()) ORDER BY next_check_at LIMIT 3`,
      );
      await Promise.allSettled(due.rows.map((r) => syncConnection(r.id)));
    } catch {
      /* Readiness can lag the first startup; the next tick retries. */
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, 5000);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export const labScenarios = [
  "healthy",
  "unhealthy",
  "paused",
  "crash",
  "oom",
  "missing",
  "crashloop",
  "imagepull",
  "readiness",
  "replicas",
] as const;
function labSnapshot(
  session: { id: string; platform: string },
  scenario: string,
): RuntimeSnapshot {
  const docker = session.platform === "docker";
  const common = {
    namespace: docker ? "" : "test-lab",
    image: "lab/sample-api:v1",
    restartCount: 0,
    ready: 1,
    desired: 1,
  };
  const resources: RuntimeSnapshot["resources"] = docker
    ? [
        {
          ...common,
          uid: "lab-container",
          name: "sample-api",
          kind: "Container",
          status: "healthy",
          reason: "Simulated container health: healthy",
        },
      ]
    : [
        {
          ...common,
          uid: "lab-pod",
          name: "sample-api-pod",
          kind: "Pod",
          status: "healthy",
          reason: "Simulated Pod Ready",
        },
        {
          ...common,
          uid: "lab-deployment",
          name: "sample-api",
          kind: "Deployment",
          status: "healthy",
          reason: "Simulated 1/1 replicas Ready",
        },
      ];
  const r = resources[0];
  if (scenario === "missing") resources.length = 0;
  else if (scenario !== "healthy") {
    const reasons: Record<string, string> = {
      unhealthy: "Docker health: unhealthy",
      paused: "Container paused",
      crash: "Exited with code 1",
      oom: "OOMKilled",
      crashloop: "CrashLoopBackOff",
      imagepull: "ImagePullBackOff",
      readiness: "Pod not Ready (Running)",
      replicas: "0/1 replicas Ready",
    };
    const affected = scenario === "replicas" ? resources[1] : r;
    affected.status = ["paused", "readiness"].includes(scenario)
      ? "degraded"
      : "down";
    affected.reason = `Simulated: ${reasons[scenario]}`;
    affected.ready = 0;
    if (["crash", "oom", "crashloop"].includes(scenario))
      affected.restartCount = 4;
  }
  return runtimeSnapshotSchema.parse({
    platform: session.platform,
    cluster: `lab:${session.id}`,
    intervalSeconds: 300,
    observedAt: new Date().toISOString(),
    resources,
  });
}
runtimeWorkspace.get("/runtime/labs", async (req, res) => {
  const org = req.user!.organizationId,
    db = requirePool();
  const sessions = (
    await db.query(
      `SELECT id,service_id AS "serviceId",name,platform,scenario,created_at AS "createdAt",updated_at AS "updatedAt",ended_at AS "endedAt"
    FROM runtime_lab_sessions WHERE organization_id=$1 ORDER BY (ended_at IS NULL) DESC,created_at DESC LIMIT 30`,
      [org],
    )
  ).rows;
  const resources = (
    await db.query(
      `SELECT r.id,r.service_id AS "serviceId",r.kind,r.name,r.status,r.reason,r.present,r.ready,r.desired,r.restart_count AS "restartCount"
    FROM runtime_resources r JOIN runtime_sources s ON s.id=r.source_id WHERE r.organization_id=$1 AND s.origin='lab' AND r.service_id=ANY($2::uuid[])`,
      [org, sessions.map((s) => s.serviceId)],
    )
  ).rows;
  const incidents = (
    await db.query(
      `SELECT id,code,title,status,severity,service_id AS "serviceId" FROM incidents WHERE organization_id=$1 AND is_test AND service_id=ANY($2::uuid[]) ORDER BY started_at DESC LIMIT 100`,
      [org, sessions.map((s) => s.serviceId)],
    )
  ).rows;
  res.json({ data: { sessions, resources, incidents } });
});
runtimeWorkspace.use("/runtime/labs", rateLimit(120, 60_000));
runtimeWorkspace.post("/runtime/labs", async (req, res) => {
  const { platform } = z
      .object({ platform: z.enum(["docker", "kubernetes"]) })
      .strict()
      .parse(req.body),
    org = req.user!.organizationId;
  const session = { id: randomUUID(), platform };
  await transaction(async (db) => {
    await lockOrg(db, org);
    if (
      (
        await db.query(
          "SELECT COUNT(*)::int AS n FROM runtime_lab_sessions WHERE organization_id=$1 AND ended_at IS NULL",
          [org],
        )
      ).rows[0].n >= 10
    )
      throw httpError(
        400,
        "End an existing lab before starting another. Up to 10 labs may be active.",
      );
    const serviceId = await createService(
      db,
      org,
      `Test lab · ${platform} · ${session.id.slice(0, 6)}`,
      true,
    );
    await db.query(
      "INSERT INTO runtime_lab_sessions(id,organization_id,service_id,platform,name) VALUES($1,$2,$3,$4,$5)",
      [
        session.id,
        org,
        serviceId,
        platform,
        `${platform === "docker" ? "Docker" : "Kubernetes"} test lab`,
      ],
    );
    await ingestRuntime(
      serviceId,
      labSnapshot(session, "healthy"),
      { organizationId: org, origin: "lab" },
      db,
    );
  });
  res.status(201).json({ data: session });
});
runtimeWorkspace.post("/runtime/labs/:id/scenario", async (req, res) => {
  const id = idSchema.parse(req.params.id),
    org = req.user!.organizationId;
  const { scenario } = z
    .object({ scenario: z.enum(labScenarios) })
    .strict()
    .parse(req.body);
  await transaction(async (db) => {
    const session = (
      await db.query(
        "SELECT * FROM runtime_lab_sessions WHERE id=$1 AND organization_id=$2 AND ended_at IS NULL FOR UPDATE",
        [id, org],
      )
    ).rows[0];
    if (!session) throw httpError(404, "Active lab not found");
    const allowed =
      session.platform === "docker"
        ? ["healthy", "unhealthy", "paused", "crash", "oom", "missing"]
        : [
            "healthy",
            "crashloop",
            "imagepull",
            "readiness",
            "replicas",
            "missing",
          ];
    if (!allowed.includes(scenario))
      throw httpError(400, "This scenario does not match the lab platform.");
    const prior = (
      await db.query(
        "SELECT observed_at FROM runtime_sources WHERE service_id=$1 AND origin='lab'",
        [session.service_id],
      )
    ).rows[0];
    const inventory = labSnapshot(session, scenario);
    inventory.observedAt = new Date(
      Math.max(Date.now(), new Date(prior.observed_at).getTime() + 1),
    ).toISOString();
    await ingestRuntime(
      session.service_id,
      inventory,
      { organizationId: org, origin: "lab" },
      db,
    );
    await db.query(
      "UPDATE runtime_lab_sessions SET scenario=$2,updated_at=NOW() WHERE id=$1",
      [id, scenario],
    );
  });
  res.json({ data: { id, scenario } });
});
runtimeWorkspace.post("/runtime/labs/:id/end", async (req, res) => {
  const id = idSchema.parse(req.params.id),
    org = req.user!.organizationId;
  const updated = await requirePool().query(
    "UPDATE runtime_lab_sessions SET ended_at=NOW(),updated_at=NOW() WHERE id=$1 AND organization_id=$2 AND ended_at IS NULL RETURNING id",
    [id, org],
  );
  if (!updated.rowCount) throw httpError(404, "Active lab not found");
  res.json({ data: { id } });
});
