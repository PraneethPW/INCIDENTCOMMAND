export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus =
  "investigating" | "identified" | "monitoring" | "resolved";

export interface AppConfig {
  capabilities?: {
    operatorControls: boolean;
    runtimeTracking?: boolean;
    runtimeWorkspace?: boolean;
    trainedMl?: boolean;
  };
  databaseConfigured: boolean;
  databaseProvider?: string;
  databaseReady: boolean;
  sessionConfigured: boolean;
  aiConfigured: boolean;
  model: string;
}
export interface User {
  userId?: string;
  id?: string;
  name: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: string;
}
export interface IncidentEvent {
  id: string;
  eventType: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  actorName?: string;
}
export interface Incident {
  mlEvidence?: MlResult | null;
  isTest?: boolean;
  runtimeResourceId?: string | null;
  id: string;
  code: string;
  title: string;
  service: string;
  serviceId?: string;
  severity: Severity;
  status: IncidentStatus;
  region: string;
  source: string;
  description: string;
  impact: string;
  latencyMs: number;
  errorRate: number;
  startedAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  updatedAt: string;
  assigneeName?: string;
  assignedTo?: string;
  events?: IncidentEvent[];
  analysis?: Analysis | null;
}
export interface Service {
  mlEnabled?: boolean;
  ml?: MlResult | null;
  id: string;
  name: string;
  slug: string;
  description: string;
  region: string;
  healthUrl?: string;
  expectedStatus: number;
  checkIntervalSeconds: number;
  monitoringEnabled: boolean;
  ingestKey: string | null;
  currentStatus: "healthy" | "degraded" | "down" | "unknown";
  consecutiveFailures: number;
  lastCheckedAt?: string;
  createdAt: string;
}
export interface Analysis {
  summary: string;
  probableCause: string;
  confidence: number;
  evidence: string[];
  recommendations: string[];
  source: "openrouter";
  model: string;
  createdAt?: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
}
export interface Overview {
  metrics: {
    active: number;
    critical: number;
    mttrMinutes: number;
    servicesTotal: number;
    servicesHealthy: number;
    alertVelocity: number;
    availability: number | null;
  };
  trends: Array<{ time: string; incidents: number }>;
  severity: Array<{ name: Severity; value: number }>;
  recent: Incident[];
}
export interface LiveEvent {
  type: string;
  message: string;
  resource?: string;
  resourceId?: string;
  data?: unknown;
  at: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
}
export interface ServiceHistory {
  checks: {
    status: string;
    statusCode: number | null;
    latencyMs: number;
    message: string;
    at: string;
    ml?: MlResult | null;
  }[];
  telemetry: {
    eventType: string;
    severity: string;
    message: string;
    at: string;
  }[];
}
export interface MlResult {
  state: "learning" | "normal" | "anomaly" | "unavailable" | "disabled";
  modelVersion: string;
  baselineCount: number;
  baselineMinimum: number;
  latencyMs: number;
  score?: number;
  threshold: number;
  baselineMedianMs?: number;
  anomaly?: boolean;
  explanation: string;
  preview?: boolean;
}
export interface MlModel {
  version: string;
  algorithm: string;
  scope: string;
  trainedAt: string;
  trainingSamples: number;
  validationSamples: number;
  baselineMinimum: number;
  baselineWindow: number;
  threshold: number;
  features: string[];
  limitations: string[];
  datasetSha256: string;
  trees: number;
  test: {
    samples: number;
    precision: number;
    recall: number;
    f1: number;
    falsePositiveRate: number;
    confusion: { tn: number; fp: number; fn: number; tp: number };
  };
  controlledTest: MlModel["test"];
}

export interface RuntimeSource {
  id: string;
  serviceId: string;
  serviceName: string;
  platform: "docker" | "kubernetes";
  cluster: string;
  observedAt: string;
  receivedAt: string;
  intervalSeconds: number;
  resourceCount: number;
  stale: boolean;
}
export interface RuntimeResource {
  id: string;
  serviceId: string;
  serviceName: string;
  platform: "docker" | "kubernetes";
  cluster: string;
  namespace: string;
  kind: string;
  name: string;
  uid: string;
  status: "healthy" | "degraded" | "down" | "completed" | "unknown";
  reason: string;
  image: string;
  restartCount: number;
  ready: number | null;
  desired: number | null;
  present: boolean;
  observedAt: string;
  stale: boolean;
  incidentId: string | null;
  incidentCode: string | null;
}
export interface Infrastructure {
  sources: RuntimeSource[];
  resources: RuntimeResource[];
}
export interface RuntimeConnection {
  id: string;
  serviceId: string;
  name: string;
  provider: "docker" | "portainer" | "kubernetes";
  endpointUrl: string;
  namespace: string;
  environmentId: number | null;
  selector: string;
  intervalSeconds: number;
  enabled: boolean;
  lastStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
}
export interface RuntimeConnectionInput {
  name: string;
  provider: RuntimeConnection["provider"];
  endpointUrl: string;
  namespace: string;
  environmentId?: number;
  serviceId?: string;
  selector: string;
  intervalSeconds: number;
  token: string;
  certificateAuthority: string;
  clientCertificate: string;
  clientKey: string;
}
export interface RuntimeLabs {
  sessions: {
    id: string;
    serviceId: string;
    name: string;
    platform: "docker" | "kubernetes";
    scenario: string;
    updatedAt: string;
    endedAt: string | null;
  }[];
  resources: Pick<
    RuntimeResource,
    | "id"
    | "serviceId"
    | "kind"
    | "name"
    | "status"
    | "reason"
    | "present"
    | "ready"
    | "desired"
    | "restartCount"
  >[];
  incidents: Pick<
    Incident,
    "id" | "code" | "title" | "status" | "severity" | "serviceId"
  >[];
}
