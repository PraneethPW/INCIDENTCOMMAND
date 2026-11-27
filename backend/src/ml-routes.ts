import { Router } from "express";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { requirePool, transaction } from "./database.js";
import { httpError, rateLimit, requireAdmin } from "./security.js";
import {
  modelInfo,
  modelDirectory,
  serviceBaseline,
  evaluateLatency,
} from "./ml.js";
import { broadcast } from "./realtime.js";

export const mlRoutes = Router();
mlRoutes.get("/ml/model", (_req, res) => res.json({ data: modelInfo }));
mlRoutes.get("/ml/dataset", (_req, res) =>
  res.download(
    fileURLToPath(new URL("IncidentCommand_ML_Dataset.zip", modelDirectory)),
    "IncidentCommand_ML_Dataset.zip",
  ),
);
mlRoutes.get("/ml/evaluation", (_req, res) =>
  res.sendFile(fileURLToPath(new URL("evaluation.png", modelDirectory))),
);
mlRoutes.post("/ml/preview", rateLimit(30, 60_000), async (req, res) => {
  const { serviceId, latencyMs } = z
    .object({
      serviceId: z.string().uuid(),
      latencyMs: z.number().min(0).max(600000),
    })
    .strict()
    .parse(req.body);
  const db = requirePool(),
    org = req.user!.organizationId;
  const service = (
    await db.query(
      "SELECT id,health_url FROM services WHERE id=$1 AND organization_id=$2 AND NOT is_test",
      [serviceId, org],
    )
  ).rows[0];
  if (!service) throw httpError(404, "Service not found");
  if (!service.health_url)
    throw httpError(400, "Select a service with an HTTP health endpoint.");
  const baseline = await serviceBaseline(db, serviceId, org);
  res.json({
    data: {
      ...evaluateLatency(latencyMs, baseline),
      preview: true,
      persisted: false,
    },
  });
});
mlRoutes.post("/services/:id/ml/reset", requireAdmin, async (req, res) => {
  const id = z.string().uuid().parse(req.params.id),
    org = req.user!.organizationId;
  await transaction(async (db) => {
    const result = await db.query(
      "UPDATE services SET ml_baseline_since=NOW(),ml_last_result=NULL,ml_anomaly_streak=0,ml_normal_streak=0 WHERE id=$1 AND organization_id=$2 AND NOT is_test RETURNING id",
      [id, org],
    );
    if (!result.rowCount) throw httpError(404, "Service not found");
  });
  broadcast(org, {
    type: "service.updated",
    message: "Latency baseline reset; new observations are required.",
    resource: "service",
    resourceId: id,
  });
  res.json({ data: { id } });
});
