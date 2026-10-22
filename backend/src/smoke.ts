import "./env.js";
import { randomBytes } from "node:crypto";
import { pool } from "./database.js";

const base = (
  process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 8787}`
).replace(/\/$/, "");
const marker = randomBytes(5).toString("hex");
let organizationId = "";
let userId = "";

async function cleanupSmokeRecords() {
  if (!pool) return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (organizationId)
        await pool.query("DELETE FROM organizations WHERE id=$1", [
          organizationId,
        ]);
      if (userId) await pool.query("DELETE FROM users WHERE id=$1", [userId]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function call<T>(
  path: string,
  cookie: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...init?.headers },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(`${path}: ${payload.error || response.status}`);
  return payload;
}

try {
  const register = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Smoke Operator",
      organization: `Smoke ${marker}`,
      email: `smoke-${marker}@incident-command.test`,
      password: `Smoke-${marker}-Secure!`,
    }),
  });
  if (!register.ok)
    throw new Error(`Registration failed: ${await register.text()}`);
  const registered = (await register.json()) as {
    data: { id: string; organizationId: string };
  };
  organizationId = registered.data.organizationId;
  userId = registered.data.id;
  const cookie = register.headers.get("set-cookie")?.split(";")[0] || "";
  if (!cookie) throw new Error("Session cookie was not issued");

  const streamController = new AbortController();
  const stream = await fetch(`${base}/api/stream`, {
    headers: { cookie },
    signal: streamController.signal,
  });
  const firstFrame = new TextDecoder().decode(
    (await stream.body!.getReader().read()).value,
  );
  streamController.abort();
  if (!firstFrame.includes("connected"))
    throw new Error("Realtime stream did not connect");

  const service = await call<{ data: { id: string; ingestKey: string } }>(
    "/api/services",
    cookie,
    {
      method: "POST",
      body: JSON.stringify({
        name: "Smoke Service",
        description: "Disposable end-to-end verification",
        region: "test",
        expectedStatus: 200,
        checkIntervalSeconds: 300,
      }),
    },
  );
  await call(`/api/ingest/${service.data.id}`, "", {
    method: "POST",
    headers: { "x-ingest-key": service.data.ingestKey },
    body: JSON.stringify({
      eventType: "smoke-signal",
      severity: "warning",
      message: "Disposable telemetry verification",
      latencyMs: 42,
    }),
  });
  const incident = await call<{ data: { id: string } }>(
    "/api/incidents",
    cookie,
    {
      method: "POST",
      body: JSON.stringify({
        title: "Disposable smoke incident",
        serviceId: service.data.id,
        service: "smoke-service",
        severity: "low",
        region: "test",
        description: "Verifies the authenticated incident workflow.",
        impact: "No customer impact; automated verification only.",
      }),
    },
  );
  await call(`/api/incidents/${incident.data.id}/status`, cookie, {
    method: "PATCH",
    body: JSON.stringify({ status: "identified" }),
  });
  const analysis = await call<{ data: { source: string; confidence: number } }>(
    `/api/incidents/${incident.data.id}/analyze`,
    cookie,
    { method: "POST" },
  );
  if (analysis.data.source !== "openrouter")
    throw new Error("Live OpenRouter analysis was not returned");
  const cachedAnalysis = await call<{
    data: { cached?: boolean; confidence: number };
  }>(`/api/incidents/${incident.data.id}/analyze`, cookie, { method: "POST" });
  if (
    !cachedAnalysis.data.cached ||
    cachedAnalysis.data.confidence !== analysis.data.confidence
  )
    throw new Error("Persisted evidence analysis was not reused");
  const overview = await call<{
    data: { metrics: { active: number; servicesTotal: number } };
  }>("/api/overview", cookie);
  if (
    overview.data.metrics.active < 1 ||
    overview.data.metrics.servicesTotal !== 1
  )
    throw new Error("Overview did not reflect persisted organization data");
  console.log(
    JSON.stringify(
      {
        authenticated: true,
        realtime: true,
        servicePersistence: true,
        telemetryIngest: true,
        incidentWorkflow: true,
        openRouter: true,
        persistedAnalysisCache: true,
        overview: true,
        confidence: analysis.data.confidence,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    await cleanupSmokeRecords();
  } finally {
    await pool?.end();
  }
}
