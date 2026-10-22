import "./env.js";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { analyzeIncident } from "./ai.js";
import {
  clearSessionCookie,
  createSessionToken,
  requireAuth,
  resolveSession,
  setSessionCookie,
} from "./auth.js";
import { databaseReady, pool, requirePool, transaction } from "./database.js";
import { checkService, newIngestKey, startMonitor } from "./monitor.js";
import { attachClient, broadcast, startRealtime } from "./realtime.js";

import {
  healthUrl,
  httpError,
  rateLimit,
  requireOperator,
  requireAdmin,
} from "./security.js";
import { workspace } from "./workspace.js";

export const app = express();
const port = Number(process.env.PORT || 8787);
const origins = process.env.FRONTEND_URL?.split(",").map((item) =>
  item.trim(),
) || ["http://localhost:5173"];

app.set("trust proxy", 1);
app.use(cors({ origin: origins, credentials: true }));
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`,
    );
  });
  next();
});
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !req.path.startsWith("/api/ingest/")
  ) {
    const origin = req.header("origin");
    if (origin && !origins.includes(origin))
      return res.status(403).json({ error: "Origin is not allowed" });
  }
  next();
});
app.use("/api/auth", rateLimit(30, 15 * 60_000));
app.use("/api/ingest", rateLimit(600, 60_000));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

const severity = z.enum(["critical", "high", "medium", "low"]);
const incidentStatus = z.enum([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);
const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
const incidentSelect = `
  SELECT i.id, i.code, i.title, i.service, i.service_id AS "serviceId", i.severity, i.status, i.region,
    i.source, i.description, i.impact, i.latency_ms AS "latencyMs", i.error_rate::float AS "errorRate",
    i.started_at AS "startedAt", i.acknowledged_at AS "acknowledgedAt", i.resolved_at AS "resolvedAt",
    i.updated_at AS "updatedAt", u.name AS "assigneeName", i.assigned_to AS "assignedTo"
  FROM incidents i LEFT JOIN users u ON u.id=i.assigned_to`;

app.get("/api/config", async (_req, res) => {
  res.json({
    data: {
      capabilities: { operatorControls: true },
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      databaseReady: await databaseReady(),
      sessionConfigured: Boolean(
        process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32,
      ),
      aiConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || "openrouter/free",
    },
  });
});

app.get("/api/health", async (_req, res) => {
  const ready = await databaseReady();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    database: ready ? "connected" : "not-ready",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/auth/register", async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(2).max(80),
      email: z.string().email(),
      password: z
        .string()
        .min(8)
        .refine(
          (value) => Buffer.byteLength(value) <= 72,
          "Password must be at most 72 bytes",
        ),
      organization: z.string().trim().min(2).max(100),
    })
    .parse(req.body);
  const db = requirePool();
  const email = input.email.toLowerCase().trim();
  const existing = await db.query("SELECT 1 FROM users WHERE email=$1", [
    email,
  ]);
  if (existing.rowCount)
    return res
      .status(409)
      .json({ error: "An account already exists for this email" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const baseSlug = slugify(input.organization) || "organization";
    const slug = `${baseSlug}-${randomBytes(2).toString("hex")}`;
    const organization = await client.query<{ id: string; name: string }>(
      "INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id,name",
      [input.organization.trim(), slug],
    );
    const user = await client.query<{
      id: string;
      name: string;
      email: string;
    }>(
      "INSERT INTO users (name,email,password_hash) VALUES ($1,$2,$3) RETURNING id,name,email",
      [input.name.trim(), email, await bcrypt.hash(input.password, 12)],
    );
    await client.query(
      `INSERT INTO memberships (organization_id,user_id,role) VALUES ($1,$2,'owner')`,
      [organization.rows[0].id, user.rows[0].id],
    );
    await client.query("COMMIT");
    setSessionCookie(
      res,
      await createSessionToken(user.rows[0].id, organization.rows[0].id),
    );
    return res.status(201).json({
      data: {
        ...user.rows[0],
        organizationId: organization.rows[0].id,
        organizationName: organization.rows[0].name,
        role: "owner",
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const input = z
    .object({ email: z.string().email(), password: z.string().min(1) })
    .parse(req.body);
  const db = requirePool();
  const result = await db.query<{
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    organizationId: string;
    organizationName: string;
    role: string;
  }>(
    `
    SELECT u.id,u.name,u.email,u.password_hash AS "passwordHash",o.id AS "organizationId",o.name AS "organizationName",m.role
    FROM users u JOIN memberships m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
    WHERE u.email=$1 ORDER BY m.created_at LIMIT 1`,
    [input.email.toLowerCase().trim()],
  );
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash)))
    return res.status(401).json({ error: "Invalid email or password" });
  setSessionCookie(res, await createSessionToken(user.id, user.organizationId));
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return res.json({ data: safeUser });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await resolveSession(req);
  if (!user) return res.status(401).json({ error: "No active session" });
  res.json({ data: user });
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) =>
  req.path.startsWith("/ingest/") ? next() : requireAuth(req, res, next),
);

app.use("/api", (req, res, next) => {
  for (const part of req.path.split("/")) {
    if (
      part.length === 36 &&
      part.includes("-") &&
      !z.string().uuid().safeParse(part).success
    )
      return res.status(400).json({ error: "Invalid resource identifier" });
  }
  next();
});
app.use("/api", workspace);
app.use("/api", (req, res, next) =>
  req.path.startsWith("/ingest/") ||
  ["GET", "HEAD", "OPTIONS"].includes(req.method)
    ? next()
    : requireOperator(req, res, next),
);

app.get("/api/overview", async (req, res) => {
  const db = requirePool();
  const org = req.user!.organizationId;
  const [metrics, trends, severityMix, recent] = await Promise.all([
    db.query(
      `SELECT
      COUNT(*) FILTER (WHERE status <> 'resolved')::int AS active,
      COUNT(*) FILTER (WHERE severity='critical' AND status <> 'resolved')::int AS critical,
      COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at-started_at))/60) FILTER (WHERE resolved_at > NOW()-INTERVAL '30 days')),0)::int AS "mttrMinutes",
      (SELECT COUNT(*)::int FROM services WHERE organization_id=$1) AS "servicesTotal",
      (SELECT COUNT(*)::int FROM services WHERE organization_id=$1 AND current_status='healthy') AS "servicesHealthy",
      COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 hour')::int AS "alertVelocity"
      FROM incidents WHERE organization_id=$1`,
      [org],
    ),
    db.query(
      `SELECT to_char(bucket,'HH24:MI') AS time, COUNT(i.id)::int AS incidents
      FROM generate_series(NOW()-INTERVAL '24 hours',NOW()-INTERVAL '4 hours',INTERVAL '4 hours') bucket
      LEFT JOIN incidents i ON i.organization_id=$1 AND i.started_at>=bucket AND i.started_at<bucket+INTERVAL '4 hours'
      GROUP BY bucket ORDER BY bucket`,
      [org],
    ),
    db.query(
      `SELECT severity AS name, COUNT(*)::int AS value FROM incidents WHERE organization_id=$1 AND status<>'resolved' GROUP BY severity`,
      [org],
    ),
    db.query(
      `${incidentSelect} WHERE i.organization_id=$1 ORDER BY i.started_at DESC LIMIT 5`,
      [org],
    ),
  ]);
  const checks = await db.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='healthy')::int AS healthy FROM service_checks WHERE organization_id=$1 AND checked_at>NOW()-INTERVAL '24 hours'`,
    [org],
  );
  const total = checks.rows[0]?.total || 0;
  const healthy = checks.rows[0]?.healthy || 0;
  res.json({
    data: {
      metrics: {
        ...metrics.rows[0],
        availability: total
          ? Number(((healthy / total) * 100).toFixed(3))
          : null,
      },
      trends: trends.rows,
      severity: severityMix.rows,
      recent: recent.rows,
    },
  });
});

app.get("/api/incidents", async (req, res) => {
  const result = await requirePool().query(
    `${incidentSelect} WHERE i.organization_id=$1 ORDER BY CASE WHEN i.status='resolved' THEN 1 ELSE 0 END,i.started_at DESC LIMIT 100`,
    [req.user!.organizationId],
  );
  res.json({ data: result.rows });
});

app.get("/api/incidents/:id", async (req, res) => {
  const db = requirePool();
  const org = req.user!.organizationId;
  const incident = await db.query(
    `${incidentSelect} WHERE i.organization_id=$1 AND i.id=$2`,
    [org, req.params.id],
  );
  if (!incident.rowCount)
    return res.status(404).json({ error: "Incident not found" });
  const [events, analysis] = await Promise.all([
    db.query(
      `SELECT e.id,e.event_type AS "eventType",e.message,e.metadata,e.created_at AS "createdAt",u.name AS "actorName" FROM incident_events e LEFT JOIN users u ON u.id=e.actor_user_id WHERE e.organization_id=$1 AND e.incident_id=$2 ORDER BY e.created_at DESC`,
      [org, req.params.id],
    ),
    db.query(
      `SELECT summary,probable_cause AS "probableCause",confidence,evidence,recommendations,model,created_at AS "createdAt",'openrouter' AS source FROM ai_analyses WHERE organization_id=$1 AND incident_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [org, req.params.id],
    ),
  ]);
  res.json({
    data: {
      ...incident.rows[0],
      events: events.rows,
      analysis: analysis.rows[0] || null,
    },
  });
});

app.post("/api/incidents", async (req, res) => {
  const input = z
    .object({
      title: z.string().min(4).max(180),
      serviceId: z.string().uuid().optional().nullable(),
      service: z.string().min(1).max(80),
      severity,
      region: z.string().min(1).max(50).default("global"),
      description: z.string().min(4).max(2000),
      impact: z.string().max(1000).default("Impact assessment pending."),
    })
    .parse(req.body);
  const db = requirePool();
  const org = req.user!.organizationId;
  const code = `INC-${randomBytes(6).toString("hex").toUpperCase()}`;
  const created = await transaction(async (db) => {
    if (
      input.serviceId &&
      !(
        await db.query(
          "SELECT 1 FROM services WHERE organization_id=$1 AND id=$2",
          [org, input.serviceId],
        )
      ).rowCount
    )
      throw httpError(400, "Service does not belong to this workspace");
    const created = await db.query(
      `INSERT INTO incidents (organization_id,service_id,code,title,service,severity,region,source,description,impact,assigned_to) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9,$10) RETURNING id`,
      [
        org,
        input.serviceId || null,
        code,
        input.title,
        input.service,
        input.severity,
        input.region,
        input.description,
        input.impact,
        req.user!.userId,
      ],
    );
    await db.query(
      `INSERT INTO incident_events (organization_id,incident_id,actor_user_id,event_type,message) VALUES ($1,$2,$3,'created','Incident created manually by the on-call operator.')`,
      [org, created.rows[0].id, req.user!.userId],
    );
    return created;
  });
  const result = await db.query(
    `${incidentSelect} WHERE i.organization_id=$1 AND i.id=$2`,
    [org, created.rows[0].id],
  );
  broadcast(org, {
    type: "incident.created",
    message: `${code}: ${input.title}`,
    resource: "incident",
    resourceId: created.rows[0].id,
    data: result.rows[0],
  });
  res.status(201).json({ data: result.rows[0] });
});

app.patch("/api/incidents/:id/status", async (req, res) => {
  const input = z.object({ status: incidentStatus }).parse(req.body);
  const db = requirePool();
  const org = req.user!.organizationId;
  const updated = await transaction(async (db) => {
    const current = await db.query(
      "SELECT status FROM incidents WHERE organization_id=$1 AND id=$2 FOR UPDATE",
      [org, req.params.id],
    );
    if (current.rows[0]?.status === input.status)
      return db.query(
        "SELECT id,code,title,status FROM incidents WHERE organization_id=$1 AND id=$2",
        [org, req.params.id],
      );
    const updated = await db.query(
      `UPDATE incidents SET status=$1,acknowledged_at=CASE WHEN $1<>'investigating' THEN COALESCE(acknowledged_at,NOW()) ELSE acknowledged_at END,resolved_at=CASE WHEN $1='resolved' THEN COALESCE(resolved_at,NOW()) ELSE NULL END,updated_at=NOW() WHERE organization_id=$2 AND id=$3 RETURNING id,code,title,status`,
      [input.status, org, req.params.id],
    );
    if (!updated.rowCount) throw httpError(404, "Incident not found");
    await db.query(
      `INSERT INTO incident_events (organization_id,incident_id,actor_user_id,event_type,message,metadata) VALUES ($1,$2,$3,'status_changed',$4,$5)`,
      [
        org,
        req.params.id,
        req.user!.userId,
        `Status changed to ${input.status} by ${req.user!.name}.`,
        JSON.stringify({ status: input.status }),
      ],
    );
    return updated;
  });
  broadcast(org, {
    type: "incident.updated",
    message: `${updated.rows[0].code} moved to ${input.status}`,
    resource: "incident",
    resourceId: String(req.params.id),
    data: updated.rows[0],
  });
  res.json({ data: updated.rows[0] });
});

app.post(
  "/api/incidents/:id/analyze",
  rateLimit(6, 60_000),
  async (req, res) => {
    const db = requirePool();
    const org = req.user!.organizationId;
    const incident = await db.query(
      `${incidentSelect} WHERE i.organization_id=$1 AND i.id=$2`,
      [org, req.params.id],
    );
    if (!incident.rowCount)
      return res.status(404).json({ error: "Incident not found" });
    const [events, checks, telemetry] = await Promise.all([
      db.query(
        `SELECT event_type,message,metadata,created_at FROM incident_events WHERE organization_id=$1 AND incident_id=$2 AND event_type<>'ai_analysis' ORDER BY created_at DESC LIMIT 50`,
        [org, req.params.id],
      ),
      incident.rows[0].serviceId
        ? db.query(
            `SELECT status,status_code,latency_ms,message,checked_at FROM service_checks WHERE organization_id=$1 AND service_id=$2 ORDER BY checked_at DESC LIMIT 30`,
            [org, incident.rows[0].serviceId],
          )
        : Promise.resolve({ rows: [] }),
      incident.rows[0].serviceId
        ? db.query(
            `SELECT event_type,severity,message,latency_ms,error_rate,metadata,received_at FROM telemetry_events WHERE organization_id=$1 AND service_id=$2 ORDER BY received_at DESC LIMIT 50`,
            [org, incident.rows[0].serviceId],
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const context = {
      incident: incident.rows[0],
      timeline: events.rows,
      healthChecks: checks.rows,
      telemetry: telemetry.rows,
    };
    const contextHash = createHash("sha256")
      .update(JSON.stringify(context))
      .digest("hex");
    const latest = await db.query(
      `SELECT summary,probable_cause AS "probableCause",confidence,evidence,recommendations,model,context_hash AS "contextHash",created_at AS "createdAt",'openrouter' AS source FROM ai_analyses WHERE organization_id=$1 AND incident_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [org, req.params.id],
    );
    const persistedAnalysis = latest.rows[0] ? { ...latest.rows[0] } : null;
    if (persistedAnalysis) delete persistedAnalysis.contextHash;
    if (latest.rows[0]?.contextHash === contextHash)
      return res.json({ data: { ...persistedAnalysis, cached: true } });

    let analysis;
    try {
      analysis = await analyzeIncident(context);
    } catch (error) {
      if (persistedAnalysis)
        return res.json({
          data: {
            ...persistedAnalysis,
            stale: true,
            warning:
              "OpenRouter is temporarily unavailable. Showing the last saved analysis; newer evidence has not been analyzed.",
          },
        });
      throw error;
    }
    await transaction(async (db) => {
      await db.query(
        `INSERT INTO ai_analyses (organization_id,incident_id,summary,probable_cause,confidence,evidence,recommendations,model,context_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          org,
          req.params.id,
          analysis.summary,
          analysis.probableCause,
          analysis.confidence,
          JSON.stringify(analysis.evidence),
          JSON.stringify(analysis.recommendations),
          analysis.model,
          contextHash,
        ],
      );
      await db.query(
        `INSERT INTO incident_events (organization_id,incident_id,actor_user_id,event_type,message,metadata) VALUES ($1,$2,$3,'ai_analysis','AI root-cause analysis completed.',$4)`,
        [
          org,
          req.params.id,
          req.user!.userId,
          JSON.stringify({
            confidence: analysis.confidence,
            model: analysis.model,
          }),
        ],
      );
    });
    broadcast(org, {
      type: "analysis.completed",
      message: `Analysis completed for ${incident.rows[0].code}`,
      resource: "incident",
      resourceId: String(req.params.id),
    });
    res.json({ data: analysis });
  },
);

app.get("/api/services", async (req, res) => {
  const result = await requirePool().query(
    `SELECT id,name,slug,description,region,health_url AS "healthUrl",expected_status AS "expectedStatus",check_interval_seconds AS "checkIntervalSeconds",monitoring_enabled AS "monitoringEnabled",CASE WHEN $2='viewer' THEN NULL ELSE ingest_key END AS "ingestKey",current_status AS "currentStatus",consecutive_failures AS "consecutiveFailures",last_checked_at AS "lastCheckedAt",created_at AS "createdAt" FROM services WHERE organization_id=$1 ORDER BY name`,
    [req.user!.organizationId, req.user!.role],
  );
  res.json({ data: result.rows });
});

app.post("/api/services", requireAdmin, async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(2).max(100),
      description: z.string().max(500).default(""),
      region: z.string().min(1).max(50).default("global"),
      healthUrl: z.string().url().optional().or(z.literal("")),
      expectedStatus: z.coerce.number().int().min(100).max(599).default(200),
      checkIntervalSeconds: z.coerce
        .number()
        .int()
        .min(30)
        .max(3600)
        .default(60),
    })
    .parse(req.body);
  if (input.healthUrl) healthUrl(input.healthUrl);
  const db = requirePool();
  const org = req.user!.organizationId;
  const base = slugify(input.name) || "service";
  const slug = `${base}-${randomBytes(2).toString("hex")}`;
  const result = await db.query(
    `INSERT INTO services (organization_id,name,slug,description,region,health_url,expected_status,check_interval_seconds,ingest_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,name,slug,description,region,health_url AS "healthUrl",expected_status AS "expectedStatus",check_interval_seconds AS "checkIntervalSeconds",monitoring_enabled AS "monitoringEnabled",ingest_key AS "ingestKey",current_status AS "currentStatus",last_checked_at AS "lastCheckedAt"`,
    [
      org,
      input.name,
      slug,
      input.description,
      input.region,
      input.healthUrl || null,
      input.expectedStatus,
      input.checkIntervalSeconds,
      newIngestKey(),
    ],
  );
  broadcast(org, {
    type: "service.created",
    message: `${input.name} added to the service graph`,
    resource: "service",
    resourceId: result.rows[0].id,
    data: result.rows[0],
  });
  res.status(201).json({ data: result.rows[0] });
});

app.patch("/api/services/:id", requireAdmin, async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(2).max(100),
      description: z.string().max(500),
      region: z.string().trim().min(1).max(50),
      healthUrl: z.string().url().or(z.literal("")),
      expectedStatus: z.number().int().min(100).max(599),
      checkIntervalSeconds: z.number().int().min(30).max(3600),
      monitoringEnabled: z.boolean(),
    })
    .parse(req.body);
  if (input.healthUrl) healthUrl(input.healthUrl);
  const result = await requirePool().query(
    `UPDATE services SET name=$1,description=$2,region=$3,health_url=$4,expected_status=$5,check_interval_seconds=$6,monitoring_enabled=$7 WHERE organization_id=$8 AND id=$9 RETURNING id`,
    [
      input.name,
      input.description,
      input.region,
      input.healthUrl || null,
      input.expectedStatus,
      input.checkIntervalSeconds,
      input.monitoringEnabled,
      req.user!.organizationId,
      req.params.id,
    ],
  );
  if (!result.rowCount) throw httpError(404, "Service not found");
  broadcast(req.user!.organizationId, {
    type: "service.updated",
    message: "Service settings updated",
    resource: "service",
    resourceId: String(req.params.id),
  });
  res.json({ ok: true });
});
app.post("/api/services/:id/rotate-key", requireAdmin, async (req, res) => {
  const key = newIngestKey();
  const result = await requirePool().query(
    "UPDATE services SET ingest_key=$1 WHERE organization_id=$2 AND id=$3 RETURNING id",
    [key, req.user!.organizationId, req.params.id],
  );
  if (!result.rowCount) throw httpError(404, "Service not found");
  broadcast(req.user!.organizationId, {
    type: "service.updated",
    message: "Service ingest key rotated",
    resource: "service",
    resourceId: String(req.params.id),
  });
  res.json({ data: { ingestKey: key } });
});
app.get("/api/services/:id/history", async (req, res) => {
  const org = req.user!.organizationId;
  const db = requirePool();
  if (
    !(
      await db.query(
        "SELECT 1 FROM services WHERE organization_id=$1 AND id=$2",
        [org, req.params.id],
      )
    ).rowCount
  )
    throw httpError(404, "Service not found");
  const [checks, telemetry] = await Promise.all([
    db.query(
      'SELECT status,status_code AS "statusCode",latency_ms AS "latencyMs",message,checked_at AS "at" FROM service_checks WHERE organization_id=$1 AND service_id=$2 ORDER BY checked_at DESC LIMIT 30',
      [org, req.params.id],
    ),
    db.query(
      'SELECT event_type AS "eventType",severity,message,received_at AS "at" FROM telemetry_events WHERE organization_id=$1 AND service_id=$2 ORDER BY received_at DESC LIMIT 30',
      [org, req.params.id],
    ),
  ]);
  res.json({ data: { checks: checks.rows, telemetry: telemetry.rows } });
});

app.post("/api/services/:id/check", async (req, res) => {
  const result = await requirePool().query(
    `SELECT id,organization_id AS "organizationId",name,slug,region,health_url AS "healthUrl",expected_status AS "expectedStatus",check_interval_seconds AS "checkIntervalSeconds",consecutive_failures AS "consecutiveFailures",current_status AS "currentStatus" FROM services WHERE organization_id=$1 AND id=$2`,
    [req.user!.organizationId, req.params.id],
  );
  if (!result.rowCount)
    return res.status(404).json({ error: "Service not found" });
  res.json({ data: await checkService(result.rows[0]) });
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const detach = attachClient(req.user!.organizationId, res);
  const expiry = setTimeout(() => res.end(), 5 * 60_000);
  req.on("close", () => {
    clearTimeout(expiry);
    detach();
  });
});

app.post("/api/ingest/:serviceId", async (req, res) => {
  const key = req.header("x-ingest-key");
  if (!key)
    return res.status(401).json({ error: "x-ingest-key header required" });
  const input = z
    .object({
      eventType: z.string().min(1).max(80),
      severity: z.enum(["info", "warning", "critical"]).default("info"),
      message: z.string().min(1).max(1000),
      latencyMs: z.number().int().nonnegative().max(2147483647).optional(),
      errorRate: z.number().min(0).max(100).optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    })
    .parse(req.body);
  const db = requirePool();
  const service = await db.query<{
    id: string;
    organizationId: string;
    name: string;
    slug: string;
    region: string;
  }>(
    `SELECT id,organization_id AS "organizationId",name,slug,region FROM services WHERE id=$1 AND ingest_key=$2`,
    [req.params.serviceId, key],
  );
  if (!service.rowCount)
    return res.status(403).json({ error: "Invalid ingest key" });
  const s = service.rows[0];
  await transaction(async (db) => {
    if (
      !(
        await db.query(
          "SELECT id FROM services WHERE id=$1 AND ingest_key=$2 FOR UPDATE",
          [s.id, key],
        )
      ).rowCount
    )
      throw httpError(403, "Invalid ingest key");
    await db.query(
      `INSERT INTO telemetry_events (organization_id,service_id,event_type,severity,message,latency_ms,error_rate,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        s.organizationId,
        s.id,
        input.eventType,
        input.severity,
        input.message,
        input.latencyMs ?? null,
        input.errorRate ?? null,
        JSON.stringify(input.metadata),
      ],
    );
    if (input.severity === "critical") {
      const existing = await db.query(
        `SELECT id FROM incidents WHERE organization_id=$1 AND service_id=$2 AND source='telemetry-ingest' AND status<>'resolved' LIMIT 1`,
        [s.organizationId, s.id],
      );
      if (existing.rowCount) {
        await db.query(
          "UPDATE incidents SET latency_ms=COALESCE($1,latency_ms),error_rate=COALESCE($2,error_rate),updated_at=NOW() WHERE organization_id=$3 AND id=$4",
          [
            input.latencyMs ?? null,
            input.errorRate ?? null,
            s.organizationId,
            existing.rows[0].id,
          ],
        );
        await db.query(
          `INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'telemetry',$3,$4)`,
          [
            s.organizationId,
            existing.rows[0].id,
            input.message,
            JSON.stringify({
              eventType: input.eventType,
              latencyMs: input.latencyMs,
              errorRate: input.errorRate,
            }),
          ],
        );
      }
      if (!existing.rowCount) {
        const code = `INC-${randomBytes(6).toString("hex").toUpperCase()}`;
        const created = await db.query<{ id: string }>(
          `INSERT INTO incidents (organization_id,service_id,code,title,service,severity,status,region,source,description,impact,latency_ms,error_rate) VALUES ($1,$2,$3,$4,$5,'critical','investigating',$6,'telemetry-ingest',$7,'Impact assessment pending.',$8,$9) RETURNING id`,
          [
            s.organizationId,
            s.id,
            code,
            `${s.name}: ${input.eventType}`,
            s.slug,
            s.region,
            input.message,
            input.latencyMs || 0,
            input.errorRate || 0,
          ],
        );
        await db.query(
          `INSERT INTO incident_events (organization_id,incident_id,event_type,message,metadata) VALUES ($1,$2,'detected','Critical telemetry created this incident.',$3)`,
          [s.organizationId, created.rows[0].id, JSON.stringify(input)],
        );
      }
    }
  });
  broadcast(s.organizationId, {
    type: "telemetry.received",
    message: `${s.name}: ${input.message}`,
    resource: "service",
    resourceId: s.id,
  });
  res.status(202).json({ accepted: true });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (!(error instanceof z.ZodError))
      console.error(error instanceof Error ? error.message : "Request failed");
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({ error: "Invalid request", issues: error.issues });
    const typed = error as Error & {
      status?: number;
      setup?: string;
      code?: string;
    };
    if (typed.code === "23505")
      return res.status(409).json({ error: "That record already exists" });
    if (typed.code === "22P02")
      return res.status(400).json({ error: "Invalid resource identifier" });
    const status = typed.status || 500;
    res.status(status).json({
      error:
        status >= 500
          ? "Service temporarily unavailable. Please retry shortly."
          : typed.message,
      setup: typed.setup,
    });
  },
);

if (process.env.NODE_ENV !== "test") {
  const stopRealtime = startRealtime();
  const stopMonitor = startMonitor();
  const server = app.listen(port, () =>
    console.log(`Incident Command API online at http://localhost:${port}`),
  );
  const stop = () => {
    stopMonitor();
    stopRealtime();
    server.close(() => {
      void pool?.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 12_000).unref();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
