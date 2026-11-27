import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

interface Tree {
  left: number[];
  right: number[];
  feature: number[];
  threshold: number[];
  samples: number[];
}
interface Forest {
  format: number;
  version: string;
  algorithm: string;
  featureNames: string[];
  baselineMinimum: number;
  baselineWindow: number;
  maxSamples: number;
  threshold: number;
  datasetSha256: string;
  trees: Tree[];
}
export const modelDirectory = new URL("../ml/artifacts/", import.meta.url);
const forest = JSON.parse(
  readFileSync(new URL("model.json", modelDirectory), "utf8"),
) as Forest;
export const modelReport = JSON.parse(
  readFileSync(new URL("metrics.json", modelDirectory), "utf8"),
);
if (
  forest.format !== 1 ||
  forest.featureNames.length !== 2 ||
  !forest.trees.length ||
  forest.trees.length > 256 ||
  !Number.isFinite(forest.threshold) ||
  forest.threshold <= 0 ||
  forest.threshold >= 1 ||
  modelReport.version !== forest.version
)
  throw new Error(
    "The trained latency model artifact is invalid or incomplete.",
  );
export const modelInfo = {
  ...modelReport,
  baselineMinimum: forest.baselineMinimum,
  baselineWindow: forest.baselineWindow,
  inference: "Backend JavaScript inference of the exported scikit-learn forest",
  trees: forest.trees.length,
};
export interface MlResult {
  state: "learning" | "normal" | "anomaly" | "unavailable" | "disabled";
  modelVersion: string;
  scope: "http-latency";
  baselineCount: number;
  baselineMinimum: number;
  latencyMs: number;
  score?: number;
  threshold: number;
  baselineMedianMs?: number;
  anomaly?: boolean;
  explanation: string;
}
function pathAdjustment(n: number) {
  return n <= 1
    ? 0
    : n === 2
      ? 1
      : 2 * (Math.log(n - 1) + 0.5772156649015329) - (2 * (n - 1)) / n;
}
export function forestScore(features: number[]) {
  if (features.length !== 2 || features.some((v) => !Number.isFinite(v)))
    throw new Error("Invalid model features");
  const input = features.map(Math.fround);
  let totalDepth = 0;
  for (const tree of forest.trees) {
    let node = 0,
      depth = 0;
    while (tree.left[node] !== -1) {
      node =
        input[tree.feature[node]] <= tree.threshold[node]
          ? tree.left[node]
          : tree.right[node];
      if (++depth > tree.left.length) throw new Error("Invalid model tree");
    }
    totalDepth += depth + pathAdjustment(tree.samples[node]);
  }
  return (
    2 **
    (-totalDepth / (forest.trees.length * pathAdjustment(forest.maxSamples)))
  );
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};
export function latencyFeatures(latency: number, history: number[]) {
  const baseline = history
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 10000)
    .slice(-forest.baselineWindow);
  if (
    baseline.length < forest.baselineMinimum ||
    !Number.isFinite(latency) ||
    latency < 0
  )
    return null;
  const center = median(baseline);
  const mad = median(baseline.map((v) => Math.abs(v - center)));
  const scale = Math.max(mad * 1.4826, center * 0.1, 1);
  return {
    values: [
      Math.log(Math.max(1, latency / center)),
      Math.log1p(Math.max(0, (latency - center) / scale)),
    ],
    medianMs: center,
    count: baseline.length,
  };
}
export function evaluateLatency(
  latencyMs: number,
  history: number[],
  healthy = true,
  enabled = true,
): MlResult {
  const count = history
    .filter((v) => Number.isFinite(v) && v > 0 && v <= 10000)
    .slice(-forest.baselineWindow).length;
  const common = {
    modelVersion: forest.version,
    scope: "http-latency" as const,
    baselineCount: count,
    baselineMinimum: forest.baselineMinimum,
    latencyMs,
    threshold: forest.threshold,
  };
  if (!enabled)
    return {
      ...common,
      state: "disabled",
      explanation: "ML latency monitoring is paused for this service.",
    };
  if (!healthy || !Number.isFinite(latencyMs) || latencyMs < 0)
    return {
      ...common,
      state: "unavailable",
      explanation:
        "A successful HTTP response is required for latency scoring. Availability checks remain independent.",
    };
  const feature = latencyFeatures(latencyMs, history);
  if (!feature)
    return {
      ...common,
      state: "learning",
      explanation: `Learning a service baseline: ${count}/${forest.baselineMinimum} prior successful checks.`,
    };
  const score = forestScore(feature.values),
    anomaly = score >= forest.threshold;
  return {
    ...common,
    state: anomaly ? "anomaly" : "normal",
    score,
    anomaly,
    baselineMedianMs: feature.medianMs,
    explanation: anomaly
      ? "Response time is unusual relative to this service's recent successful baseline."
      : "Response time is within the model's learned normal pattern.",
  };
}
export async function serviceBaseline(
  db: Pick<PoolClient, "query">,
  serviceId: string,
  org: string,
) {
  const rows = (
    await db.query(
      `SELECT c.latency_ms FROM service_checks c JOIN services s ON s.id=c.service_id
    WHERE c.service_id=$1 AND c.organization_id=$2 AND c.status='healthy' AND c.latency_ms BETWEEN 1 AND 10000
    AND c.checked_at>=COALESCE(s.ml_baseline_since,s.created_at)
    AND COALESCE((c.ml_result->>'anomaly')::boolean,FALSE)=FALSE ORDER BY c.checked_at DESC,c.id DESC LIMIT $3`,
      [serviceId, org, forest.baselineWindow],
    )
  ).rows;
  return rows.reverse().map((r) => Number(r.latency_ms));
}
export async function recordMlObservation(
  db: PoolClient,
  service: {
    id: string;
    organizationId: string;
    name: string;
    region: string;
    ml_anomaly_streak: number;
    ml_normal_streak: number;
    ml_last_result?: { modelVersion?: string } | null;
  },
  result: MlResult,
) {
  const sameModel =
    !service.ml_last_result ||
    service.ml_last_result.modelVersion === result.modelVersion;
  const anomalies =
    result.state === "anomaly"
      ? (sameModel ? service.ml_anomaly_streak : 0) + 1
      : 0;
  const normals =
    result.state === "normal"
      ? (sameModel ? service.ml_normal_streak : 0) + 1
      : 0;
  await db.query(
    "UPDATE services SET ml_last_result=$2,ml_anomaly_streak=$3,ml_normal_streak=$4 WHERE id=$1",
    [
      service.id,
      JSON.stringify(result),
      Math.min(anomalies, 1000000),
      Math.min(normals, 1000000),
    ],
  );
  const existing = (
    await db.query(
      "SELECT id FROM incidents WHERE service_id=$1 AND organization_id=$2 AND source='ml-latency' AND status<>'resolved'",
      [service.id, service.organizationId],
    )
  ).rows[0];
  if (anomalies >= 2 && !existing) {
    const incident = (
      await db.query(
        `INSERT INTO incidents(organization_id,service_id,code,title,service,severity,region,source,description,impact,latency_ms,ml_evidence)
      VALUES($1,$2,$3,$4,$5,'medium',$6,'ml-latency',$7,$8,$9,$10) RETURNING id`,
        [
          service.organizationId,
          service.id,
          `INC-${randomBytes(6).toString("hex").toUpperCase()}`,
          `Unusual response time: ${service.name}`,
          service.name,
          service.region,
          "Two consecutive successful HTTP checks exceeded the trained latency model's anomaly threshold.",
          "Latency requires investigation; customer impact and root cause are unverified.",
          result.latencyMs,
          JSON.stringify(result),
        ],
      )
    ).rows[0];
    await db.query(
      `INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'detected',$3,$4)`,
      [
        service.organizationId,
        incident.id,
        "Trained Isolation Forest detected sustained unusual HTTP latency.",
        JSON.stringify(result),
      ],
    );
  } else if (
    existing &&
    (result.state === "normal" || result.state === "anomaly")
  ) {
    await db.query(
      "UPDATE incidents SET ml_evidence=$2,updated_at=NOW() WHERE id=$1",
      [existing.id, JSON.stringify(result)],
    );
    if (normals >= 2) {
      await db.query(
        "UPDATE incidents SET status='resolved',resolved_at=NOW() WHERE id=$1",
        [existing.id],
      );
      await db.query(
        `INSERT INTO incident_events(organization_id,incident_id,event_type,message,metadata) VALUES($1,$2,'resolved',$3,$4)`,
        [
          service.organizationId,
          existing.id,
          "Two consecutive scored HTTP checks returned to the learned latency baseline.",
          JSON.stringify(result),
        ],
      );
    }
  }
}
