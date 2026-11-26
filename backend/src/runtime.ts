import { Router } from "express";
import { requirePool } from "./database.js";
import { httpError } from "./security.js";
import { ingestRuntime, runtimeSnapshotSchema } from "./runtime-ingest.js";
export { runtimeSnapshotSchema } from "./runtime-ingest.js";

export const runtime = Router();
runtime.post("/ingest/:serviceId/runtime", async (req, res) => {
  const key = req.header("x-ingest-key");
  if (!key) throw httpError(401, "x-ingest-key header required");
  const input = runtimeSnapshotSchema.parse(req.body);
  if (/^(web:|lab:)/.test(input.cluster))
    throw httpError(
      400,
      "This source name is reserved for the runtime workspace",
    );
  const result = await ingestRuntime(String(req.params.serviceId), input, {
    key,
  });
  res.status(202).json({ accepted: true, ...result });
});

runtime.get("/infrastructure", async (req, res) => {
  const db = requirePool(),
    org = req.user!.organizationId;
  const [sources, resources] = await Promise.all([
    db.query(
      `SELECT rs.id,rs.service_id AS "serviceId",s.name AS "serviceName",rs.platform,COALESCE(c.name,rs.cluster) AS cluster,rs.origin,rs.observed_at AS "observedAt",
      rs.received_at AS "receivedAt",rs.interval_seconds AS "intervalSeconds",rs.resource_count AS "resourceCount",
      (NOW()-rs.observed_at > make_interval(secs => GREATEST(90,rs.interval_seconds*3))) AS stale
      FROM runtime_sources rs JOIN services s ON s.id=rs.service_id LEFT JOIN runtime_connections c ON c.id=rs.connection_id WHERE rs.organization_id=$1 AND NOT s.is_test ORDER BY rs.received_at DESC LIMIT 100`,
      [org],
    ),
    db.query(
      `SELECT r.id,r.service_id AS "serviceId",s.name AS "serviceName",rs.platform,COALESCE(c.name,rs.cluster) AS cluster,rs.origin,r.namespace,r.kind,r.name,r.uid,r.status,r.reason,r.image,
      r.restart_count AS "restartCount",r.ready,r.desired,r.present,r.observed_at AS "observedAt",
      (NOW()-rs.observed_at > make_interval(secs => GREATEST(90,rs.interval_seconds*3))) AS stale,
      i.id AS "incidentId",i.code AS "incidentCode"
      FROM runtime_resources r JOIN services s ON s.id=r.service_id JOIN runtime_sources rs ON rs.id=r.source_id LEFT JOIN runtime_connections c ON c.id=rs.connection_id
      LEFT JOIN incidents i ON i.runtime_resource_id=r.id AND i.status<>'resolved'
      WHERE r.organization_id=$1 AND NOT s.is_test ORDER BY r.present DESC,r.observed_at DESC,r.name LIMIT 1000`,
      [org],
    ),
  ]);
  res.json({ data: { sources: sources.rows, resources: resources.rows } });
});
