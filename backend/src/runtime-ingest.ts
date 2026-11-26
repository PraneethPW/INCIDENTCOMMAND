import { randomBytes } from "node:crypto";
import { z } from "zod";
import { transaction } from "./database.js";
import { httpError } from "./security.js";
import type { PoolClient } from "pg";

const text = (max: number) => z.string().trim().min(1).max(max);
const resourceSchema = z
  .object({
    uid: text(256),
    name: text(200),
    namespace: z.string().max(100).default(""),
    kind: z.enum([
      "Container",
      "Pod",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
    ]),
    status: z.enum(["healthy", "degraded", "down", "completed", "unknown"]),
    reason: text(500),
    image: z.string().max(500).default(""),
    restartCount: z.number().int().min(0).max(2147483647).default(0),
    ready: z.number().int().min(0).max(100000).nullable().default(null),
    desired: z.number().int().min(0).max(100000).nullable().default(null),
  })
  .strict();
export const runtimeSnapshotSchema = z
  .object({
    platform: z.enum(["docker", "kubernetes"]),
    cluster: text(100),
    observedAt: z.iso.datetime({ offset: true }),
    intervalSeconds: z.number().int().min(15).max(300),
    resources: z.array(resourceSchema).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const r of value.resources) {
      if (seen.has(r.uid))
        ctx.addIssue({ code: "custom", message: "Duplicate resource UID" });
      seen.add(r.uid);
      if ((value.platform === "docker") !== (r.kind === "Container"))
        ctx.addIssue({
          code: "custom",
          message: "Resource kind does not match platform",
        });
    }
    const age = Date.now() - Date.parse(value.observedAt);
    if (age > 600_000 || age < -60_000)
      ctx.addIssue({
        code: "custom",
        message:
          "Snapshot must be collected within ten minutes and not in the future",
      });
  });
export type RuntimeSnapshot = z.infer<typeof runtimeSnapshotSchema>;

export async function ingestRuntime(
  serviceId: string,
  input: RuntimeSnapshot,
  access: {
    key?: string;
    organizationId?: string;
    origin?: "collector" | "connection" | "lab";
    connectionId?: string;
  },
  client?: PoolClient,
) {
  const origin = access.origin || "collector";
  const persist = async (db: PoolClient) => {
    // Serialize snapshots and key rotation on the service row.
    const service = (
      await db.query(
        "SELECT id,organization_id AS org,name,slug,region,is_test FROM services WHERE id=$1 AND (($2::text IS NOT NULL AND ingest_key=$2) OR ($3::uuid IS NOT NULL AND organization_id=$3)) FOR UPDATE",
        [serviceId, access.key || null, access.organizationId || null],
      )
    ).rows[0];
    if (!service) throw httpError(403, "Invalid ingest key");
    if (service.is_test !== (origin === "lab"))
      throw httpError(400, "Test and live runtime sources must stay separate");
    const existing = (
      await db.query(
        "SELECT id,observed_at,origin,connection_id FROM runtime_sources WHERE service_id=$1 AND platform=$2 AND cluster=$3",
        [service.id, input.platform, input.cluster],
      )
    ).rows[0];
    if (
      existing &&
      (existing.origin !== origin ||
        existing.connection_id !== (access.connectionId || null))
    )
      throw httpError(
        409,
        "This runtime source is managed by a different connection",
      );
    if (
      existing &&
      new Date(existing.observed_at).getTime() >= Date.parse(input.observedAt)
    )
      return { ignored: true, resources: input.resources.length };
    const source = (
      await db.query(
        `INSERT INTO runtime_sources(organization_id,service_id,platform,cluster,observed_at,interval_seconds,resource_count,origin,connection_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(service_id,platform,cluster) DO UPDATE SET
       observed_at=EXCLUDED.observed_at,received_at=NOW(),interval_seconds=EXCLUDED.interval_seconds,resource_count=EXCLUDED.resource_count RETURNING id`,
        [
          service.org,
          service.id,
          input.platform,
          input.cluster,
          input.observedAt,
          input.intervalSeconds,
          input.resources.length,
          origin,
          access.connectionId || null,
        ],
      )
    ).rows[0];
    // Disappearance is not verified recovery. Retain the last observation and incident.
    await db.query(
      "UPDATE runtime_resources SET present=FALSE WHERE source_id=$1",
      [source.id],
    );
    // A steady-state heartbeat uses bulk inventory queries, not one round trip per resource.
    const priorRows = (
      await db.query(
        "SELECT uid,status,reason FROM runtime_resources WHERE source_id=$1",
        [source.id],
      )
    ).rows;
    const prior = new Map(priorRows.map((r) => [r.uid, r]));
    const storedRows = (
      await db.query(
        `
      INSERT INTO runtime_resources(organization_id,service_id,source_id,uid,name,namespace,kind,status,reason,image,restart_count,ready,desired,observed_at)
      SELECT $1,$2,$3,r.uid,r.name,r.namespace,r.kind,r.status,r.reason,r.image,r."restartCount",r.ready,r.desired,$5
      FROM jsonb_to_recordset($4::jsonb) AS r(uid text,name text,namespace text,kind text,status text,reason text,image text,"restartCount" integer,ready integer,desired integer)
      ON CONFLICT(source_id,uid) DO UPDATE SET name=EXCLUDED.name,namespace=EXCLUDED.namespace,kind=EXCLUDED.kind,status=EXCLUDED.status,
      reason=EXCLUDED.reason,image=EXCLUDED.image,restart_count=EXCLUDED.restart_count,ready=EXCLUDED.ready,desired=EXCLUDED.desired,present=TRUE,observed_at=EXCLUDED.observed_at
      RETURNING id,uid`,
        [
          service.org,
          service.id,
          source.id,
          JSON.stringify(input.resources),
          input.observedAt,
        ],
      )
    ).rows;
    const storedByUid = new Map(storedRows.map((r) => [r.uid, r]));
    const incidentRows = (
      await db.query(
        "SELECT id,runtime_resource_id FROM incidents WHERE organization_id=$1 AND runtime_resource_id=ANY($2::uuid[]) AND status<>'resolved'",
        [service.org, storedRows.map((r) => r.id)],
      )
    ).rows;
    const openIncidents = new Map(
      incidentRows.map((r) => [r.runtime_resource_id, r]),
    );
    const telemetry = [];
    for (const resource of input.resources) {
      const previous = prior.get(resource.uid);
      const stored = storedByUid.get(resource.uid)!;
      const incident = openIncidents.get(stored.id);
      const failing = ["down", "degraded"].includes(resource.status);
      const changed =
        !previous ||
        previous.status !== resource.status ||
        previous.reason !== resource.reason;
      const evidence = {
        ...resource,
        origin,
        platform: input.platform,
        cluster: input.cluster,
        observedAt: input.observedAt,
      };
      let incidentId = incident?.id;
      if (failing && !incidentId) {
        incidentId = (
          await db.query(
            `INSERT INTO incidents(organization_id,service_id,runtime_resource_id,code,title,service,severity,region,source,description,impact,is_test)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [
              service.org,
              service.id,
              stored.id,
              `INC-${randomBytes(6).toString("hex").toUpperCase()}`,
              `${origin === "lab" ? "Test lab · " : ""}${resource.kind} ${resource.name}: ${resource.reason}`.slice(
                0,
                300,
              ),
              service.name,
              resource.status === "down" ? "critical" : "high",
              service.region,
              input.platform,
              resource.reason,
              origin === "lab"
                ? "Controlled browser test scenario. No live host or cluster was modified."
                : "Runtime workload requires investigation; customer impact is not yet verified.",
              origin === "lab",
            ],
          )
        ).rows[0].id;
        await db.query(
          "INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'detected',$3,$4)",
          [
            service.org,
            incidentId,
            `${origin === "lab" ? "Test lab" : input.platform + " observation"} detected ${resource.kind} ${resource.name}: ${resource.reason}`,
            JSON.stringify(evidence),
          ],
        );
      } else if (
        incidentId &&
        ["healthy", "completed"].includes(resource.status)
      ) {
        await db.query(
          "UPDATE incidents SET status='resolved',resolved_at=NOW(),updated_at=NOW() WHERE id=$1",
          [incidentId],
        );
        await db.query(
          "INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'resolved',$3,$4)",
          [
            service.org,
            incidentId,
            `${origin === "lab" ? "Test lab recovery" : origin === "connection" ? "API verified recovery" : "Collector verified recovery"}: ${resource.name}. ${resource.reason}`,
            JSON.stringify(evidence),
          ],
        );
      } else if (incidentId && changed) {
        await db.query("UPDATE incidents SET updated_at=NOW() WHERE id=$1", [
          incidentId,
        ]);
        if (failing)
          await db.query("UPDATE incidents SET severity=$2 WHERE id=$1", [
            incidentId,
            resource.status === "down" ? "critical" : "high",
          ]);
        await db.query(
          "INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'runtime_observation',$3,$4)",
          [service.org, incidentId, resource.reason, JSON.stringify(evidence)],
        );
      }
      if (changed)
        telemetry.push({
          eventType: `${input.platform}.observation`,
          severity: failing ? "critical" : "info",
          message: `${resource.kind} ${resource.name}: ${resource.reason}`,
          metadata: evidence,
        });
    }
    if (telemetry.length)
      await db.query(
        `INSERT INTO telemetry_events(organization_id,service_id,event_type,severity,message,metadata)
      SELECT $1,$2,t."eventType",t.severity,t.message,t.metadata FROM jsonb_to_recordset($3::jsonb) AS t("eventType" text,severity text,message text,metadata jsonb)`,
        [service.org, service.id, JSON.stringify(telemetry)],
      );
    await db.query("SELECT pg_notify('incident_command',$1)", [
      JSON.stringify({
        organizationId: service.org,
        event: {
          type: origin === "lab" ? "runtime.lab.updated" : "runtime.updated",
          message: `${origin === "lab" ? "Test lab · " : ""}${input.platform}: ${input.resources.length} resources observed for ${service.name}`,
          resource: "service",
          resourceId: service.id,
        },
      }),
    ]);
    return { ignored: false, resources: input.resources.length };
  };
  return client ? persist(client) : transaction(persist);
}
