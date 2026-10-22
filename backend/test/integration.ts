import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { app } from "../src/server.js";
import { pool, transaction } from "../src/database.js";
import { checkService } from "../src/monitor.js";
import { isPublicAddress, healthUrl } from "../src/security.js";
import { startRealtime } from "../src/realtime.js";

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
