import { randomBytes } from "node:crypto";
import { pool, transaction } from "./database.js";
import { probe, httpError } from "./security.js";

interface ServiceRow {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  region: string;
  healthUrl: string | null;
  expectedStatus: number;
  checkIntervalSeconds: number;
  consecutiveFailures: number;
  currentStatus: "healthy" | "degraded" | "down" | "unknown";
}

export function newIngestKey() {
  return `ic_live_${randomBytes(24).toString("hex")}`;
}

export async function checkService(
  input: ServiceRow,
  scheduled = false,
  performProbe = probe,
) {
  return transaction(async (db) => {
    // A row lock serializes manual checks and all worker replicas for this service.
    const locked = await db.query(
      `SELECT id, organization_id AS "organizationId", name, slug, region, health_url AS "healthUrl", expected_status AS "expectedStatus", check_interval_seconds AS "checkIntervalSeconds", consecutive_failures AS "consecutiveFailures", current_status AS "currentStatus", monitoring_enabled AS enabled, last_checked_at AS checked FROM services WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [input.id, input.organizationId],
    );
    const service = locked.rows[0] as ServiceRow & {
      enabled: boolean;
      checked: Date | null;
    };
    if (!service) throw httpError(404, "Service not found");
    if (
      scheduled &&
      (!service.enabled ||
        (service.checked &&
          Date.now() - service.checked.getTime() <
            service.checkIntervalSeconds * 1000))
    )
      return null;
    if (!service.healthUrl)
      throw httpError(400, "This service does not have a health URL");
    const started = Date.now();
    let statusCode: number | null = null;
    let message = "";
    let healthy = false;
    try {
      statusCode = await performProbe(service.healthUrl);
      healthy = statusCode === service.expectedStatus;
      message = healthy
        ? `Health check returned ${statusCode}`
        : `Expected ${service.expectedStatus}, received ${statusCode}`;
    } catch (error) {
      message = error instanceof Error ? error.message : "Health check failed";
    }
    const latencyMs = Date.now() - started;
    const failures = healthy ? 0 : service.consecutiveFailures + 1;
    const status: ServiceRow["currentStatus"] = healthy
      ? "healthy"
      : failures >= 2
        ? "down"
        : "degraded";

    await db.query(
      `UPDATE services SET current_status=$1, consecutive_failures=$2, last_checked_at=NOW() WHERE id=$3`,
      [status, failures, service.id],
    );
    await db.query(
      `INSERT INTO service_checks (organization_id, service_id, status, status_code, latency_ms, message) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        service.organizationId,
        service.id,
        status,
        statusCode,
        latencyMs,
        message,
      ],
    );

    if (status === "down") {
      const existing = await db.query(
        `SELECT id FROM incidents WHERE organization_id=$1 AND service_id=$2 AND source='health-monitor' AND status <> 'resolved' LIMIT 1`,
        [service.organizationId, service.id],
      );
      if (!existing.rowCount) {
        const code = `INC-${randomBytes(6).toString("hex").toUpperCase()}`;
        const created = await db.query<{ id: string }>(
          `INSERT INTO incidents (organization_id, service_id, code, title, service, severity, status, region, source, description, impact, latency_ms) VALUES ($1,$2,$3,$4,$5,'critical','investigating',$6,'health-monitor',$7,$8,$9) RETURNING id`,
          [
            service.organizationId,
            service.id,
            code,
            `${service.name} health check failed`,
            service.slug,
            service.region,
            message,
            "Service is unavailable or returning an unexpected response.",
            latencyMs,
          ],
        );
        await db.query(
          `INSERT INTO incident_events (organization_id, incident_id, event_type, message, metadata) VALUES ($1,$2,'detected',$3,$4)`,
          [
            service.organizationId,
            created.rows[0].id,
            "Incident created automatically after consecutive health-check failures.",
            JSON.stringify({ statusCode, latencyMs }),
          ],
        );
      }
    }

    if (healthy) {
      const resolved = await db.query<{ id: string }>(
        `UPDATE incidents SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE organization_id=$1 AND service_id=$2 AND source='health-monitor' AND status <> 'resolved' RETURNING id`,
        [service.organizationId, service.id],
      );
      for (const incident of resolved.rows) {
        await db.query(
          `INSERT INTO incident_events (organization_id, incident_id, event_type, message) VALUES ($1,$2,'resolved','Health checks recovered and the incident was resolved automatically.')`,
          [service.organizationId, incident.id],
        );
      }
    }

    // NOTIFY is delivered only when the transaction commits.
    await db.query(`SELECT pg_notify('incident_command', $1)`, [
      JSON.stringify({
        organizationId: service.organizationId,
        event: {
          type: "service.check",
          message: `${service.name}: ${status}`,
          resource: "service",
          resourceId: service.id,
        },
      }),
    ]);
    return {
      status,
      statusCode,
      latencyMs,
      message,
      checkedAt: new Date().toISOString(),
    };
  });
}

async function runDueChecks() {
  if (!pool) return;
  const result = await pool.query<ServiceRow>(`
    SELECT id, organization_id AS "organizationId", name, slug, region, health_url AS "healthUrl",
      expected_status AS "expectedStatus", check_interval_seconds AS "checkIntervalSeconds",
      consecutive_failures AS "consecutiveFailures", current_status AS "currentStatus"
    FROM services
    WHERE monitoring_enabled=TRUE AND health_url IS NOT NULL
      AND (last_checked_at IS NULL OR last_checked_at < NOW() - make_interval(secs => check_interval_seconds))
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT 25
  `);
  // Reserve most pool connections for interactive requests while probes wait on networks.
  const queue = [...result.rows];
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (queue.length) {
        const service = queue.shift();
        if (!service) return;
        try {
          await checkService(service, true);
        } catch (error) {
          console.error(
            "Scheduled check failed:",
            error instanceof Error ? error.message : "Database unavailable",
          );
        }
      }
    }),
  );
}

export function startMonitor() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let delay = 15_000;
  async function cycle() {
    try {
      await runDueChecks();
      delay = 15_000;
    } catch (error) {
      delay = Math.min(delay * 2, 300_000);
      console.error(
        "Monitor unavailable; retrying in",
        delay,
        "ms:",
        error instanceof Error ? error.message : "Database error",
      );
    }
    if (!stopped) {
      timer = setTimeout(cycle, delay);
      timer.unref();
    }
  }
  void cycle();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
