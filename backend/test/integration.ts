import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "../src/server.js";
import { pool, transaction } from "../src/database.js";
import { checkService } from "../src/monitor.js";
import { isPublicAddress, healthUrl } from "../src/security.js";
import { startRealtime } from "../src/realtime.js";
import { applySchema } from "../src/schema-setup.js";
import { createServer } from "node:http";
import { syncConnection } from "../src/runtime-workspace.js";

if (
  process.env.NODE_ENV !== "test" ||
  !process.env.DATABASE_URL?.includes("incident_test")
)
  throw new Error("Use NODE_ENV=test and an isolated incident_test database");
const db = pool!;
let server: ReturnType<typeof app.listen>;
let base = "";
let stopRealtime: () => void;
const users: { cookie: string; org: string; id: string }[] = [];
async function call(
  path: string,
  cookie = "",
  body?: unknown,
  method = body ? "POST" : "GET",
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", cookie, ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  return {
    status: response.status,
    data: payload.data,
    payload,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function register() {
  const r = await call("/api/auth/register", "", {
    name: "Test Operator",
    email: `${randomUUID()}@example.test`,
    password: "Testing-Password-123",
    organization: "Integration workspace",
  });
  assert.equal(r.status, 201);
  const user = { cookie: r.cookie, org: r.data.organizationId, id: r.data.id };
  users.push(user);
  return user;
}
let owner: (typeof users)[number],
  other: (typeof users)[number],
  service: { id: string; ingestKey: string };
before(async () => {
  await db.query(
    await readFile(new URL("../schema.sql", import.meta.url), "utf8"),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  stopRealtime = startRealtime();
  owner = await register();
  other = await register();
  const r = await call("/api/services", owner.cookie, { name: "Test service" });
  assert.equal(r.status, 201);
  service = r.data;
});
after(async () => {
  stopRealtime();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const u of users) {
    await db.query("DELETE FROM organizations WHERE id=$1", [u.org]);
    await db.query("DELETE FROM users WHERE id=$1", [u.id]);
  }
  await db.end();
});

test("authentication, origin protection, and organization boundaries", async () => {
  assert.equal(
    (await call("/api/config")).data.capabilities.operatorControls,
    true,
  );
  assert.equal((await call("/api/incidents")).status, 401);
  assert.equal(
    (
      await call(
        "/api/services",
        owner.cookie,
        { name: "Bad origin" },
        "POST",
        { origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  const wrong = await call("/api/incidents", other.cookie, {
    title: "Cross org test",
    service: "foreign",
    serviceId: service.id,
    severity: "low",
    description: "Should be rejected",
  });
  assert.equal(wrong.status, 400);
  assert.equal(
    (await call(`/api/services/${service.id}/history`, other.cookie)).status,
    404,
  );
  assert.equal((await call("/api/services", other.cookie)).data.length, 0);
});
test("concurrent critical telemetry creates one incident and preserves zero metrics", async () => {
  const replies = await Promise.all(
    Array.from({ length: 10 }, () =>
      call(
        `/api/ingest/${service.id}`,
        "",
        {
          eventType: "error",
          severity: "critical",
          message: "Failure",
          latencyMs: 0,
          errorRate: 0,
        },
        "POST",
        { "x-ingest-key": service.ingestKey },
      ),
    ),
  );
  assert.ok(replies.every((r) => r.status === 202));
  const incidents = (await call("/api/incidents", owner.cookie)).data;
  assert.equal(incidents.length, 1);
  const rows = await db.query(
    "SELECT latency_ms,error_rate FROM telemetry_events WHERE service_id=$1",
    [service.id],
  );
  assert.equal(rows.rowCount, 10);
  assert.equal(rows.rows[0].latency_ms, 0);
  assert.equal(Number(rows.rows[0].error_rate), 0);
  assert.equal(
    (
      await call(
        `/api/ingest/${service.id}`,
        "",
        { eventType: "error", message: "bad" },
        "POST",
        { "x-ingest-key": "wrong" },
      )
    ).status,
    403,
  );
});
test("incident status, notes, ownership, and idempotent resolution persist", async () => {
  const id = (await call("/api/incidents", owner.cookie)).data[0].id;
  assert.equal(
    (
      await call(
        `/api/incidents/${id}/assignee`,
        owner.cookie,
        { userId: other.id },
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/api/incidents/${id}/assignee`,
        owner.cookie,
        { userId: owner.id },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/api/incidents/${id}/notes`, owner.cookie, {
        message: "Verified the failed deployment.",
      })
    ).status,
    201,
  );
  for (const status of ["identified", "monitoring", "resolved"])
    assert.equal(
      (
        await call(
          `/api/incidents/${id}/status`,
          owner.cookie,
          { status },
          "PATCH",
        )
      ).status,
      200,
    );
  const first = (await call(`/api/incidents/${id}`, owner.cookie)).data;
  await call(
    `/api/incidents/${id}/status`,
    owner.cookie,
    { status: "resolved" },
    "PATCH",
  );
  const second = (await call(`/api/incidents/${id}`, owner.cookie)).data;
  assert.equal(first.resolvedAt, second.resolvedAt);
  assert.equal(first.events.length, second.events.length);
  assert.equal(second.assignedTo, owner.id);
  assert.ok(
    second.events.some((e: { eventType: string }) => e.eventType === "note"),
  );
  assert.equal((await call(`/api/incidents/${id}`, other.cookie)).status, 404);
});
test("service configuration, history and rotation invalidate the old key", async () => {
  assert.equal(
    (await call(`/api/services/${service.id}/check`, owner.cookie, {})).status,
    400,
  );
  assert.equal(
    (
      await call("/api/services", owner.cookie, {
        name: "Unsafe protocol",
        healthUrl: "file:///etc/passwd",
      })
    ).status,
    400,
  );
  const r = await call(
    `/api/services/${service.id}`,
    owner.cookie,
    {
      name: "Updated service",
      description: "edited",
      region: "global",
      healthUrl: "https://example.com/health",
      expectedStatus: 204,
      checkIntervalSeconds: 300,
      monitoringEnabled: false,
    },
    "PATCH",
  );
  assert.equal(r.status, 200);
  assert.equal(
    (await call(`/api/services/${service.id}/history`, owner.cookie)).data
      .telemetry.length,
    10,
  );
  const rotated = await call(
    `/api/services/${service.id}/rotate-key`,
    owner.cookie,
    {},
  );
  assert.equal(rotated.status, 200);
  assert.equal(
    (
      await call(
        `/api/ingest/${service.id}`,
        "",
        { eventType: "info", message: "old key" },
        "POST",
        { "x-ingest-key": service.ingestKey },
      )
    ).status,
    403,
  );
  service.ingestKey = rotated.data.ingestKey;
});
test("monitor serializes failures, suppresses duplicates, and resolves on recovery", async () => {
  const row = {
    id: service.id,
    organizationId: owner.org,
    name: "Test",
    slug: "test",
    region: "global",
    healthUrl: "https://example.com",
    expectedStatus: 204,
    checkIntervalSeconds: 300,
    consecutiveFailures: 0,
    currentStatus: "unknown" as const,
  };
  const first = await checkService(row, false, async () => 500);
  assert.equal(first?.status, "degraded");
  await Promise.all([
    checkService(row, false, async () => 500),
    checkService(row, false, async () => 500),
  ]);
  const open = await db.query(
    "SELECT id FROM incidents WHERE service_id=$1 AND source='health-monitor' AND status<>'resolved'",
    [service.id],
  );
  assert.equal(open.rowCount, 1);
  const state = await db.query(
    "SELECT consecutive_failures FROM services WHERE id=$1",
    [service.id],
  );
  assert.equal(state.rows[0].consecutive_failures, 3);
  const recovered = await checkService(row, false, async () => 204);
  assert.equal(recovered?.status, "healthy");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM incidents WHERE service_id=$1 AND source='health-monitor' AND status<>'resolved'",
        [service.id],
      )
    ).rowCount,
    0,
  );
  assert.equal(
    await checkService(row, true, async () => {
      throw new Error("Paused service must not be probed");
    }),
    null,
  );
});
test("transaction rollback does not leak partially created records", async () => {
  const marker = randomUUID();
  await assert.rejects(
    transaction(async (client) => {
      await client.query("INSERT INTO organizations(name,slug) VALUES($1,$1)", [
        marker,
      ]);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (await db.query("SELECT 1 FROM organizations WHERE slug=$1", [marker]))
      .rowCount,
    0,
  );
});
test("schema setup rolls back all work and retries a transient deadlock", async () => {
  const marker = randomUUID();
  const sequence = "schema_retry_" + marker.replaceAll("-", "");
  await db.query(`CREATE SEQUENCE ${sequence}`);
  try {
    await applySchema(`
      INSERT INTO organizations(name,slug) VALUES('${marker}','${marker}');
      DO $$ BEGIN
        IF nextval('${sequence}')=1 THEN
          RAISE EXCEPTION 'controlled conflict' USING ERRCODE='40P01';
        END IF;
      END $$;
    `);
    assert.equal(
      (await db.query("SELECT 1 FROM organizations WHERE slug=$1", [marker]))
        .rowCount,
      1,
    );
    assert.equal(
      Number(
        (await db.query(`SELECT last_value FROM ${sequence}`)).rows[0]
          .last_value,
      ),
      2,
    );
  } finally {
    await db.query("DELETE FROM organizations WHERE slug=$1", [marker]);
    await db.query(`DROP SEQUENCE ${sequence}`);
  }
});

test("schema setup recovers from a real advisory-lock timeout", async () => {
  const marker = randomUUID();
  const blocker = await db.connect();
  let pending: Promise<void> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT pg_advisory_xact_lock(hashtext('incident-command-schema'))",
    );
    pending = applySchema(
      `INSERT INTO organizations(name,slug) VALUES('${marker}','${marker}')`,
    );
    await delay(2300);
    await blocker.query("COMMIT");
    await pending;
    assert.equal(
      (await db.query("SELECT 1 FROM organizations WHERE slug=$1", [marker]))
        .rowCount,
      1,
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await pending?.catch(() => {});
    await db.query("DELETE FROM organizations WHERE slug=$1", [marker]);
  }
});

test("schema setup surfaces permanent SQL errors without retrying", async () => {
  const sequence = "schema_error_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SEQUENCE ${sequence}`);
  try {
    await assert.rejects(
      applySchema(
        `SELECT nextval('${sequence}'); SELECT * FROM ${sequence}_missing;`,
      ),
      { code: "42P01" },
    );
    assert.equal(
      Number(
        (await db.query(`SELECT last_value FROM ${sequence}`)).rows[0]
          .last_value,
      ),
      1,
    );
  } finally {
    await db.query(`DROP SEQUENCE ${sequence}`);
  }
});

test("schema setup stops after five conflicts and leaves no partial records", async () => {
  const marker = randomUUID();
  const sequence = "schema_limit_" + marker.replaceAll("-", "");
  await db.query(`CREATE SEQUENCE ${sequence}`);
  try {
    await assert.rejects(
      applySchema(`
      SELECT nextval('${sequence}');
      INSERT INTO organizations(name,slug) VALUES('${marker}','${marker}');
      DO $$ BEGIN RAISE EXCEPTION 'controlled conflict' USING ERRCODE='40P01'; END $$;
    `),
      { code: "40P01" },
    );
    assert.equal(
      Number(
        (await db.query(`SELECT last_value FROM ${sequence}`)).rows[0]
          .last_value,
      ),
      5,
    );
    assert.equal(
      (await db.query("SELECT 1 FROM organizations WHERE slug=$1", [marker]))
        .rowCount,
      0,
    );
  } finally {
    await db.query("DELETE FROM organizations WHERE slug=$1", [marker]);
    await db.query(`DROP SEQUENCE ${sequence}`);
  }
});

test("invites are single-use, viewers cannot mutate or see keys, workspace switching is scoped", async () => {
  const invite = await call("/api/team/invites", owner.cookie, {
    role: "viewer",
  });
  assert.equal(invite.status, 201);
  const joined = await call("/api/team/join", other.cookie, {
    token: invite.data.token,
  });
  assert.equal(joined.status, 200);
  assert.equal(
    (await call("/api/team/join", other.cookie, { token: invite.data.token }))
      .status,
    400,
  );
  const viewer = joined.cookie;
  assert.equal((await call("/api/services", viewer)).data[0].ingestKey, null);
  assert.equal(
    (await call("/api/services", viewer, { name: "Forbidden" })).status,
    403,
  );
  assert.equal(
    (await call(`/api/services/${service.id}/check`, viewer, {})).status,
    403,
  );
  assert.equal(
    (await call("/api/team/invites", viewer, { role: "admin" })).status,
    403,
  );
  assert.equal(
    (
      await call("/api/workspaces/switch", viewer, {
        organizationId: randomUUID(),
      })
    ).status,
    404,
  );
  assert.equal((await call("/api/workspaces", viewer)).data.length, 2);
  assert.equal(
    (
      await call(
        `/api/team/${owner.id}`,
        owner.cookie,
        { role: "viewer" },
        "PATCH",
      )
    ).status,
    404,
  );
});
test("public health URL policy blocks private, mapped, metadata and local destinations", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "0.0.0.0",
    "100.64.0.1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.throws(() => healthUrl("ftp://example.com"));
  assert.throws(() => healthUrl("https://user:pass@example.com"));
});
test("SSE delivers committed events and reconnects with a fresh snapshot trigger", async () => {
  const controller = new AbortController();
  const response = await fetch(base + "/api/stream", {
    headers: { cookie: owner.cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes("connected"));
  await call(
    `/api/ingest/${service.id}`,
    "",
    { eventType: "live", message: "SSE test" },
    "POST",
    { "x-ingest-key": service.ingestKey },
  );
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    let frames = "";
    while (!frames.includes("telemetry.received")) {
      frames += new TextDecoder().decode((await reader.read()).value);
    }
    assert.ok(!frames.includes(service.ingestKey));
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
});

test("AI uses configured model, caches persisted evidence, and preserves stale analysis on provider failure", async () => {
  const id = (await call("/api/incidents", owner.cookie)).data[0].id;
  const original = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_API_KEY = "local-provider-test";
  process.env.OPENROUTER_MODEL = "test/model";
  let providerCalls = 0;
  let unavailable = false;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://openrouter.ai/api/v1/chat/completions") {
      providerCalls++;
      assert.equal(JSON.parse(String(init?.body)).model, "test/model");
      if (unavailable)
        return new Response(
          JSON.stringify({ error: { message: "Provider unavailable" } }),
          { status: 503 },
        );
      return new Response(
        JSON.stringify({
          model: "test/model",
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "submit_incident_analysis",
                      arguments: JSON.stringify({
                        summary: "Checks failed, then recovered.",
                        probableCause:
                          "Evidence is insufficient to determine the underlying cause.",
                        confidence: 20,
                        evidence: ["Recorded failed health checks."],
                        recommendations: [
                          "Verify current service health before taking action.",
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return original(input, init);
  };
  try {
    const first = await call(`/api/incidents/${id}/analyze`, owner.cookie, {});
    assert.equal(first.status, 200);
    assert.equal(first.data.model, "test/model");
    const cached = await call(`/api/incidents/${id}/analyze`, owner.cookie, {});
    assert.equal(cached.data.cached, true);
    assert.equal(providerCalls, 1);
    await call(`/api/incidents/${id}/notes`, owner.cookie, {
      message: "New evidence after analysis",
    });
    unavailable = true;
    const stale = await call(`/api/incidents/${id}/analyze`, owner.cookie, {});
    assert.equal(stale.status, 200);
    assert.equal(stale.data.stale, true);
    assert.equal(stale.data.summary, first.data.summary);
  } finally {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
  }
});

test("runtime snapshots authenticate, isolate, deduplicate and verify recovery", async () => {
  const runtimeOwner = await register();
  const svc = (
    await call("/api/services", runtimeOwner.cookie, {
      name: "Runtime test service",
    })
  ).data;
  const at = Date.now() - 30_000;
  const resource = {
    uid: "container-01",
    name: "orders",
    kind: "Container",
    status: "down",
    reason: "OOMKilled",
    image: "sha256:123",
    restartCount: 4,
  };
  const snapshot = (n: number, resources: unknown[] = [resource]) => ({
    platform: "docker",
    cluster: "test-host",
    observedAt: new Date(at + n * 1000).toISOString(),
    intervalSeconds: 30,
    resources,
  });
  const ingest = (body: unknown, key = svc.ingestKey) =>
    call(`/api/ingest/${svc.id}/runtime`, "", body, "POST", {
      "x-ingest-key": key,
    });
  assert.equal((await ingest(snapshot(0), "wrong")).status, 403);
  assert.equal(
    (await call(`/api/ingest/${svc.id}/runtime`, "", snapshot(0))).status,
    401,
  );
  const replies = await Promise.all(
    Array.from({ length: 5 }, () => ingest(snapshot(1))),
  );
  assert.ok(replies.every((r) => r.status === 202));
  assert.equal(replies.filter((r) => !r.payload.ignored).length, 1);
  const inventory = (await call("/api/infrastructure", runtimeOwner.cookie))
    .data;
  assert.equal(inventory.resources.length, 1);
  assert.equal(inventory.resources[0].status, "down");
  const incidentId = inventory.resources[0].incidentId;
  assert.ok(incidentId);
  assert.equal(
    (await call("/api/infrastructure", other.cookie)).data.resources.length,
    0,
  );
  assert.equal((await call("/api/infrastructure")).status, 401);
  assert.equal(
    (
      await ingest(
        snapshot(0, [{ ...resource, status: "healthy", reason: "Running" }]),
      )
    ).payload.ignored,
    true,
  );
  assert.equal(
    (await call(`/api/incidents/${incidentId}`, runtimeOwner.cookie)).data
      .status,
    "investigating",
  );
  await ingest(snapshot(2, []));
  assert.equal(
    (await call("/api/infrastructure", runtimeOwner.cookie)).data.resources[0]
      .present,
    false,
  );
  assert.equal(
    (await call(`/api/incidents/${incidentId}`, runtimeOwner.cookie)).data
      .status,
    "investigating",
  );
  await ingest(
    snapshot(3, [{ ...resource, status: "unknown", reason: "Starting" }]),
  );
  assert.equal(
    (await call(`/api/incidents/${incidentId}`, runtimeOwner.cookie)).data
      .status,
    "investigating",
  );
  await ingest(
    snapshot(4, [
      { ...resource, status: "healthy", reason: "Docker health: healthy" },
    ]),
  );
  const recovered = (
    await call(`/api/incidents/${incidentId}`, runtimeOwner.cookie)
  ).data;
  assert.equal(recovered.status, "resolved");
  assert.ok(
    recovered.events.some(
      (e: { eventType: string }) => e.eventType === "resolved",
    ),
  );
  await ingest(snapshot(5));
  const incidents = await db.query(
    "SELECT id FROM incidents WHERE service_id=$1 AND status<>'resolved'",
    [svc.id],
  );
  assert.equal(incidents.rowCount, 1);
  await db.query(
    "UPDATE runtime_sources SET observed_at=NOW()-INTERVAL '5 minutes' WHERE service_id=$1",
    [svc.id],
  );
  assert.equal(
    (await call("/api/infrastructure", runtimeOwner.cookie)).data.sources.find(
      (s: { serviceId: string }) => s.serviceId === svc.id,
    ).stale,
    true,
  );
  assert.equal(
    (await ingest({ ...snapshot(6), resources: [resource, resource] })).status,
    400,
  );
  assert.equal(
    (
      await ingest({
        ...snapshot(6),
        observedAt: new Date(Date.now() + 3600_000).toISOString(),
      })
    ).status,
    400,
  );
  assert.equal(
    (await ingest(snapshot(6, [{ ...resource, env: { PASSWORD: "reject" } }])))
      .status,
    400,
  );
  assert.equal(
    (await ingest({ ...snapshot(6), platform: "kubernetes" })).status,
    400,
  );
  const kubernetes = {
    ...snapshot(7, [
      {
        ...resource,
        uid: "pod-01",
        kind: "Pod",
        namespace: "orders",
        reason: "CrashLoopBackOff",
      },
    ]),
    platform: "kubernetes",
    cluster: "test-cluster-orders",
  };
  assert.equal((await ingest(kubernetes)).status, 202);
  const kube = (
    await call("/api/infrastructure", runtimeOwner.cookie)
  ).data.resources.find(
    (r: { platform: string }) => r.platform === "kubernetes",
  );
  assert.ok(kube.incidentId);
  const event = (
    await call(`/api/incidents/${kube.incidentId}`, runtimeOwner.cookie)
  ).data.events[0];
  assert.equal(event.metadata.namespace, "orders");
  const originalFetch = globalThis.fetch;
  const savedKey = process.env.OPENROUTER_API_KEY;
  let runtimeAnalysisCalls = 0;
  process.env.OPENROUTER_API_KEY = "runtime-test-provider";
  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://openrouter.ai/api/v1/chat/completions")
      return originalFetch(input, init);
    runtimeAnalysisCalls++;
    const request = JSON.parse(String(init?.body));
    const context = JSON.parse(request.messages[1].content);
    assert.equal(context.runtime[0].uid, "pod-01");
    assert.equal(context.runtime[0].platform, "kubernetes");
    assert.equal(context.runtime[0].namespace, "orders");
    assert.ok(!JSON.stringify(context).includes(svc.ingestKey));
    return new Response(
      JSON.stringify({
        model: "test/runtime",
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Runtime evidence received",
                probableCause: "Crash loop requires investigation",
                confidence: 30,
                evidence: ["Pod CrashLoopBackOff"],
                recommendations: ["Verify pod image and resource limits"],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  try {
    assert.equal(
      (
        await call(
          `/api/incidents/${kube.incidentId}/analyze`,
          runtimeOwner.cookie,
          {},
        )
      ).status,
      200,
    );
    await ingest({
      ...kubernetes,
      observedAt: new Date(at + 8000).toISOString(),
    });
    const cachedRuntime = await call(
      `/api/incidents/${kube.incidentId}/analyze`,
      runtimeOwner.cookie,
      {},
    );
    assert.equal(cachedRuntime.data.cached, true);
    assert.equal(runtimeAnalysisCalls, 1);
    await ingest({
      ...kubernetes,
      observedAt: new Date(at + 9000).toISOString(),
      resources: kubernetes.resources.map((r) => ({
        ...r,
        restartCount: r.restartCount + 1,
      })),
    });
    const changedRuntime = await call(
      `/api/incidents/${kube.incidentId}/analyze`,
      runtimeOwner.cookie,
      {},
    );
    assert.equal(changedRuntime.status, 200);
    assert.equal(changedRuntime.data.cached, undefined);
    assert.equal(runtimeAnalysisCalls, 2);
    await db.query(
      "UPDATE runtime_sources SET observed_at=NOW()-INTERVAL '5 minutes' WHERE service_id=$1 AND platform='kubernetes'",
      [svc.id],
    );
    const staleRuntime = await call(
      `/api/incidents/${kube.incidentId}/analyze`,
      runtimeOwner.cookie,
      {},
    );
    assert.equal(staleRuntime.status, 200);
    assert.equal(staleRuntime.data.cached, undefined);
    assert.equal(runtimeAnalysisCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }

  await call(`/api/services/${svc.id}/rotate-key`, runtimeOwner.cookie, {});
  assert.equal((await ingest(snapshot(8))).status, 403);
});

test("request boundaries return safe JSON and preserve explicitly allowed cross-origin clients", async () => {
  const invalid = await fetch(base + "/api/incidents", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: '{"password":"do-not-echo"',
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "Request body must be valid JSON",
  });
  const large = await fetch(base + "/api/incidents", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ description: "x".repeat(1_100_000) }),
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error, "Request body is too large");
  assert.equal((await call("/api/missing-route", owner.cookie)).status, 404);
  assert.equal(
    (
      await call(
        "/api/workspaces/switch",
        owner.cookie,
        { organizationId: owner.org },
        "POST",
        { "sec-fetch-site": "cross-site" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/workspaces/switch",
        owner.cookie,
        { organizationId: owner.org },
        "POST",
        { "sec-fetch-site": "cross-site", origin: "http://localhost:5173" },
      )
    ).status,
    200,
  );
});

test("readiness rejects an incomplete application schema", async () => {
  await db.query(
    "ALTER TABLE telemetry_events RENAME TO telemetry_events_readiness_test",
  );
  try {
    assert.equal((await call("/api/health")).status, 503);
  } finally {
    await db.query(
      "ALTER TABLE telemetry_events_readiness_test RENAME TO telemetry_events",
    );
  }
  assert.equal((await call("/api/health")).status, 200);
});

test("trained ML detects sustained slow HTTP 200 responses, scopes evidence and verifies recovery independently of availability", async () => {
  const operator = await register();
  const created = (
    await call("/api/services", operator.cookie, {
      name: "ML latency service",
      healthUrl: "https://example.com/health",
    })
  ).data;
  await db.query(
    "UPDATE services SET created_at=NOW()-INTERVAL '1 hour' WHERE id=$1",
    [created.id],
  );
  await db.query(
    `INSERT INTO service_checks(organization_id,service_id,status,status_code,latency_ms,message,checked_at)
    SELECT $1,$2,'healthy',200,5,'Test baseline fixture',NOW()-make_interval(secs=>n) FROM generate_series(1,25) n`,
    [operator.org, created.id],
  );
  const input = {
    ...created,
    organizationId: operator.org,
    healthUrl: "https://example.com/health",
    consecutiveFailures: 0,
  };
  await db.query(
    "UPDATE services SET ml_anomaly_streak=6,ml_last_result=$2 WHERE id=$1",
    [created.id, JSON.stringify({ modelVersion: "retired-model" })],
  );
  const slow = async () => {
    await delay(100);
    return 200;
  };
  const first = await checkService(input, false, slow);
  assert.equal(first!.status, "healthy");
  assert.equal(first!.ml.state, "anomaly");
  assert.equal((await call("/api/incidents", operator.cookie)).data.length, 0);
  await Promise.all([
    checkService(input, false, slow),
    checkService(input, false, slow),
  ]);
  const incidents = (await call("/api/incidents", operator.cookie)).data;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].source, "ml-latency");
  assert.ok(incidents[0].mlEvidence.score >= incidents[0].mlEvidence.threshold);
  assert.equal(
    (await call("/api/incidents", other.cookie)).data.some(
      (i: { id: string }) => i.id === incidents[0].id,
    ),
    false,
  );
  const preview = await call("/api/ml/preview", operator.cookie, {
    serviceId: created.id,
    latencyMs: 1000,
  });
  assert.equal(preview.data.state, "anomaly");
  assert.equal(preview.data.persisted, false);
  assert.equal(
    (
      await call("/api/ml/preview", other.cookie, {
        serviceId: created.id,
        latencyMs: 1000,
      })
    ).status,
    404,
  );
  await checkService(input, false, async () => 200);
  assert.equal(
    (await call(`/api/incidents/${incidents[0].id}`, operator.cookie)).data
      .status,
    "investigating",
  );
  await checkService(input, false, async () => 200);
  assert.equal(
    (await call(`/api/incidents/${incidents[0].id}`, operator.cookie)).data
      .status,
    "resolved",
  );
  const history = (
    await call(`/api/services/${created.id}/history`, operator.cookie)
  ).data;
  assert.ok(
    history.checks.some(
      (c: { ml: { modelVersion: string } }) => c.ml?.modelVersion,
    ),
  );
  await checkService(input, false, slow);
  await checkService(input, false, slow);
  const open = (await call("/api/incidents", operator.cookie)).data.find(
    (i: { status: string }) => i.status !== "resolved",
  );
  assert.ok(open);
  const settings = (await call("/api/services", operator.cookie)).data.find(
    (s: { id: string }) => s.id === created.id,
  );
  const body = {
    name: settings.name,
    description: settings.description,
    region: settings.region,
    healthUrl: settings.healthUrl,
    expectedStatus: settings.expectedStatus,
    checkIntervalSeconds: settings.checkIntervalSeconds,
    monitoringEnabled: settings.monitoringEnabled,
    mlEnabled: false,
  };
  assert.equal(
    (await call(`/api/services/${created.id}`, operator.cookie, body, "PATCH"))
      .status,
    200,
  );
  assert.equal(
    (await checkService(input, false, async () => 200))!.ml.state,
    "disabled",
  );
  assert.equal(
    (await call(`/api/incidents/${open.id}`, operator.cookie)).data.status,
    "investigating",
  );
  await call(
    `/api/services/${created.id}`,
    operator.cookie,
    { ...body, mlEnabled: true },
    "PATCH",
  );
  await call(`/api/services/${created.id}/ml/reset`, operator.cookie, {});
  assert.equal(
    (await checkService(input, false, async () => 200))!.ml.state,
    "learning",
  );
  assert.equal(
    (await call(`/api/incidents/${open.id}`, operator.cookie)).data.status,
    "investigating",
  );
  const otherReset = await call(
    `/api/services/${created.id}/ml/reset`,
    other.cookie,
    {},
  );
  assert.equal(otherReset.status, 404);
  assert.equal((await call("/api/ml/model")).status, 401);
  const model = (await call("/api/ml/model", operator.cookie)).data;
  assert.equal(model.algorithm, "Isolation Forest");
  const archive = await fetch(base + "/api/ml/dataset", {
    headers: { cookie: operator.cookie },
  });
  assert.equal(archive.status, 200);
  assert.equal(
    Buffer.from(await archive.arrayBuffer())
      .subarray(0, 2)
      .toString(),
    "PK",
  );
  const figure = await fetch(base + "/api/ml/evaluation", {
    headers: { cookie: operator.cookie },
  });
  assert.equal(figure.status, 200);
  assert.ok(figure.headers.get("content-type")!.includes("image/png"));

  assert.ok(model.limitations.length > 0);
  const viewer = await register();
  viewer.cookie = (
    await call("/api/workspaces/switch", viewer.cookie, {
      organizationId: viewer.org,
    })
  ).cookie;
  await db.query(
    "UPDATE memberships SET role='viewer' WHERE user_id=$1 AND organization_id=$2",
    [viewer.id, viewer.org],
  );
  assert.equal(
    (
      await call("/api/ml/preview", viewer.cookie, {
        serviceId: created.id,
        latencyMs: 1000,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(`/api/services/${created.id}/ml/reset`, viewer.cookie, {}))
      .status,
    403,
  );
});

test("browser labs isolate test data, deduplicate failures, retain missing incidents and verify simulated recovery", async () => {
  const operator = await register();
  const lab = await call("/api/runtime/labs", operator.cookie, {
    platform: "docker",
  });
  assert.equal(lab.status, 201);
  const id = lab.data.id;
  const scenario = (scenario: string) =>
    call(`/api/runtime/labs/${id}/scenario`, operator.cookie, { scenario });
  assert.equal((await scenario("unhealthy")).status, 200);
  await Promise.all([scenario("unhealthy"), scenario("unhealthy")]);
  let state = (await call("/api/runtime/labs", operator.cookie)).data;
  assert.equal(state.incidents.length, 1);
  const incident = state.incidents[0];
  assert.equal((await call("/api/incidents", operator.cookie)).data.length, 0);
  assert.equal(
    (await call("/api/incidents?scope=test", operator.cookie)).data.length,
    1,
  );
  assert.equal((await call("/api/services", operator.cookie)).data.length, 0);
  assert.equal(
    (await call("/api/infrastructure", operator.cookie)).data.resources.length,
    0,
  );
  const overview = (await call("/api/overview", operator.cookie)).data;
  assert.equal(overview.metrics.active, 0);
  assert.equal(overview.metrics.servicesTotal, 0);
  assert.equal(overview.recent.length, 0);
  assert.ok(
    overview.trends.every((p: { incidents: number }) => p.incidents === 0),
  );
  assert.equal(
    (await call(`/api/incidents/${incident.id}`, operator.cookie)).data.isTest,
    true,
  );
  assert.equal(
    (
      await call(`/api/runtime/labs/${id}/scenario`, other.cookie, {
        scenario: "healthy",
      })
    ).status,
    404,
  );
  assert.equal((await scenario("crashloop")).status, 400);
  await scenario("missing");
  assert.equal(
    (await call(`/api/incidents/${incident.id}`, operator.cookie)).data.status,
    "investigating",
  );
  await scenario("healthy");
  assert.equal(
    (await call(`/api/incidents/${incident.id}`, operator.cookie)).data.status,
    "resolved",
  );
  await scenario("oom");
  state = (await call("/api/runtime/labs", operator.cookie)).data;
  assert.equal(state.incidents.length, 2);
  assert.equal(
    (await call(`/api/runtime/labs/${id}/end`, operator.cookie, {})).status,
    200,
  );
  assert.equal((await scenario("healthy")).status, 404);
  assert.equal(
    (await call("/api/runtime/labs", operator.cookie)).data.incidents.length,
    2,
  );
  const svc = await db.query("SELECT id,ingest_key FROM services WHERE id=$1", [
    state.sessions[0].serviceId,
  ]);
  assert.equal(
    (
      await call(
        `/api/ingest/${svc.rows[0].id}/runtime`,
        "",
        {
          platform: "docker",
          cluster: `lab:${id}`,
          observedAt: new Date().toISOString(),
          intervalSeconds: 30,
          resources: [],
        },
        "POST",
        { "x-ingest-key": svc.rows[0].ingest_key },
      )
    ).status,
    400,
  );
});

test("Kubernetes labs preserve stable identities across failure types and keep all test actions read-only for viewers", async () => {
  const operator = await register();
  const viewerUser = await register();
  await db.query(
    "INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')",
    [operator.org, viewerUser.id],
  );
  viewerUser.cookie = (
    await call("/api/workspaces/switch", viewerUser.cookie, {
      organizationId: operator.org,
    })
  ).cookie;
  const lab = (
    await call("/api/runtime/labs", operator.cookie, { platform: "kubernetes" })
  ).data;
  for (const scenario of ["crashloop", "imagepull", "readiness", "replicas"]) {
    assert.equal(
      (
        await call(`/api/runtime/labs/${lab.id}/scenario`, operator.cookie, {
          scenario,
        })
      ).status,
      200,
    );
  }
  const state = (await call("/api/runtime/labs", operator.cookie)).data;
  assert.equal(state.resources.length, 2);
  assert.equal(state.incidents.length, 2);
  assert.equal(
    (await call("/api/runtime/labs", viewerUser.cookie)).status,
    200,
  );
  assert.equal(
    (await call("/api/runtime/labs", viewerUser.cookie, { platform: "docker" }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(`/api/runtime/labs/${lab.id}/scenario`, viewerUser.cookie, {
        scenario: "healthy",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/runtime/connections/test", viewerUser.cookie, {})).status,
    403,
  );
  await call(`/api/runtime/labs/${lab.id}/scenario`, operator.cookie, {
    scenario: "healthy",
  });
  assert.ok(
    (await call("/api/runtime/labs", operator.cookie)).data.incidents.every(
      (i: { status: string }) => i.status === "resolved",
    ),
  );
});

test("web Docker connections persist encrypted credentials, poll real API fixtures, serialize refreshes and preserve observations on failure", async () => {
  const operator = await register();
  let healthy = true,
    reject = false,
    slow = false;
  const remote = createServer(async (req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer test-remote-secret");
    if (slow) await delay(100);
    res.setHeader("content-type", "application/json");
    if (reject) {
      res.writeHead(403).end('{"error":"do-not-expose-remote-details"}');
      return;
    }
    res.end(
      JSON.stringify(
        req.url!.startsWith("/containers/json")
          ? [{ Id: "a".repeat(64) }]
          : {
              Id: "a".repeat(64),
              Name: "/orders-api",
              State: {
                Status: "running",
                Health: { Status: healthy ? "healthy" : "unhealthy" },
              },
              Config: { Env: ["SECRET=do-not-store"] },
              Image: "sample:v1",
              RestartCount: 0,
            },
      ),
    );
  }).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => remote.once("listening", resolve));
  const port = (remote.address() as { port: number }).port;
  try {
    const input = {
      name: "Connected Docker",
      provider: "docker",
      endpointUrl: `http://127.0.0.1:${port}`,
      token: "test-remote-secret",
    };
    const preview = await call(
      "/api/runtime/connections/test",
      operator.cookie,
      input,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.resources[0].status, "healthy");
    assert.ok(!JSON.stringify(preview).includes("do-not-store"));
    const created = await call(
      "/api/runtime/connections",
      operator.cookie,
      input,
    );
    assert.equal(created.status, 201);
    const id = created.data.id;
    const raw = (
      await db.query(
        "SELECT credentials FROM runtime_connections WHERE id=$1",
        [id],
      )
    ).rows[0].credentials;
    assert.ok(raw.startsWith("v1:") && !raw.includes("test-remote-secret"));
    const listed = await call("/api/runtime/connections", operator.cookie);
    assert.ok(!JSON.stringify(listed).includes("test-remote-secret"));
    assert.equal(
      (await call("/api/runtime/connections", other.cookie)).data.length,
      0,
    );
    assert.equal(
      (await call(`/api/runtime/connections/${id}/sync`, other.cookie, {}))
        .status,
      404,
    );
    healthy = false;
    await syncConnection(id, operator.org);
    const inventory = (await call("/api/infrastructure", operator.cookie)).data;
    assert.equal(inventory.sources[0].origin, "connection");
    assert.equal(inventory.sources[0].cluster, input.name);
    const incident = inventory.resources[0].incidentId;
    assert.ok(incident);
    slow = true;
    const refreshes = await Promise.allSettled([
      syncConnection(id),
      syncConnection(id),
    ]);
    assert.equal(refreshes.filter((r) => r.status === "fulfilled").length, 1);
    slow = false;
    reject = true;
    await assert.rejects(syncConnection(id), /rejected these credentials/);
    const failed = (await call("/api/runtime/connections", operator.cookie))
      .data[0];
    assert.equal(failed.lastStatus, "error");
    assert.ok(!failed.lastError.includes("do-not-expose"));
    assert.equal(
      (await call(`/api/incidents/${incident}`, operator.cookie)).data.status,
      "investigating",
    );
    assert.equal(
      (await call("/api/infrastructure", operator.cookie)).data.resources[0]
        .present,
      true,
    );
    await call(
      `/api/runtime/connections/${id}`,
      operator.cookie,
      { enabled: false },
      "PATCH",
    );
    await assert.rejects(syncConnection(id), /paused/);
    reject = false;
    healthy = true;
    assert.equal(
      (
        await call(
          `/api/runtime/connections/${id}`,
          operator.cookie,
          input,
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (await call(`/api/incidents/${incident}`, operator.cookie)).data.status,
      "resolved",
    );
    assert.equal(
      (
        await call(
          `/api/runtime/connections/${id}`,
          operator.cookie,
          { ...input, provider: "kubernetes" },
          "PUT",
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          `/api/runtime/connections/${id}`,
          other.cookie,
          undefined,
          "DELETE",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          `/api/runtime/connections/${id}`,
          operator.cookie,
          undefined,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/api/runtime/connections", operator.cookie)).data.length,
      0,
    );
    assert.equal(
      (await call(`/api/incidents/${incident}`, operator.cookie)).data.status,
      "resolved",
    );
  } finally {
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});
