export type Severity = "critical" | "high" | "medium" | "low";
export type IncidentStatus =
  "investigating" | "identified" | "monitoring" | "resolved";

export interface AppConfig {
  capabilities?: { operatorControls: boolean };
  databaseConfigured: boolean;
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
  }[];
  telemetry: {
    eventType: string;
    severity: string;
    message: string;
    at: string;
  }[];
}
