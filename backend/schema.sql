CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'responder' CHECK (role IN ('owner', 'admin', 'responder', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT 'global',
  health_url TEXT,
  expected_status INTEGER NOT NULL DEFAULT 200,
  check_interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK (check_interval_seconds >= 30),
  monitoring_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ingest_key TEXT UNIQUE NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'unknown' CHECK (current_status IN ('healthy', 'degraded', 'down', 'unknown')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS service_checks (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'down')),
  status_code INTEGER,
  latency_ms INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  service TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  region TEXT NOT NULL DEFAULT 'global',
  source TEXT NOT NULL,
  description TEXT NOT NULL,
  impact TEXT NOT NULL DEFAULT 'Impact assessment pending.',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_rate NUMERIC(8, 3) NOT NULL DEFAULT 0,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);

CREATE TABLE IF NOT EXISTS incident_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  probable_cause TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT NOT NULL,
  context_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  latency_ms INTEGER,
  error_rate NUMERIC(8, 3),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Forward-compatible upgrade path from the earlier local prototype schema.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE incident_events ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE incident_events ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE ai_analyses ADD COLUMN IF NOT EXISTS context_hash TEXT;

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE INDEX IF NOT EXISTS services_org_idx ON services(organization_id, current_status);
CREATE INDEX IF NOT EXISTS service_checks_service_idx ON service_checks(service_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS incidents_org_status_idx ON incidents(organization_id, status);
CREATE INDEX IF NOT EXISTS incidents_started_at_idx ON incidents(organization_id, started_at DESC);
CREATE INDEX IF NOT EXISTS incident_events_incident_idx ON incident_events(incident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_analyses_context_idx ON ai_analyses(organization_id, incident_id, context_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_service_idx ON telemetry_events(service_id, received_at DESC);

CREATE TABLE IF NOT EXISTS workspace_invites (
  token_hash TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('responder','viewer','admin')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 days',
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS invites_org_idx ON workspace_invites(organization_id);

-- Bounded, sanitized inventories from service-key-authenticated runtime collectors.
CREATE TABLE IF NOT EXISTS runtime_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('docker','kubernetes')),
  cluster TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds BETWEEN 15 AND 300),
  resource_count INTEGER NOT NULL,
  UNIQUE (service_id, platform, cluster)
);
CREATE TABLE IF NOT EXISTS runtime_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES runtime_sources(id) ON DELETE CASCADE,
  uid TEXT NOT NULL, name TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','completed','unknown')),
  reason TEXT NOT NULL, image TEXT NOT NULL DEFAULT '', restart_count INTEGER NOT NULL DEFAULT 0,
  ready INTEGER, desired INTEGER, present BOOLEAN NOT NULL DEFAULT TRUE, observed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source_id, uid)
);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS runtime_resource_id UUID REFERENCES runtime_resources(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runtime_open_incident_idx ON incidents(runtime_resource_id) WHERE runtime_resource_id IS NOT NULL AND status<>'resolved';
CREATE INDEX IF NOT EXISTS runtime_resources_org_idx ON runtime_resources(organization_id, source_id);

ALTER TABLE services ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS ml_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS ml_baseline_since TIMESTAMPTZ;
ALTER TABLE services ADD COLUMN IF NOT EXISTS ml_last_result JSONB;
ALTER TABLE services ADD COLUMN IF NOT EXISTS ml_anomaly_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS ml_normal_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_checks ADD COLUMN IF NOT EXISTS ml_result JSONB;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS ml_evidence JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS incidents_ml_open_idx ON incidents(service_id) WHERE source='ml-latency' AND status<>'resolved';
CREATE INDEX IF NOT EXISTS checks_ml_baseline_idx ON service_checks(service_id,checked_at DESC);
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS runtime_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('docker','portainer','kubernetes')),
  endpoint_url TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  environment_id INTEGER,
  credentials TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 60 CHECK(interval_seconds BETWEEN 30 AND 300),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_status TEXT NOT NULL DEFAULT 'connected',
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS runtime_connections_due_idx ON runtime_connections(next_check_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS runtime_connections_org_idx ON runtime_connections(organization_id);
ALTER TABLE runtime_connections ADD COLUMN IF NOT EXISTS selector TEXT NOT NULL DEFAULT '';
ALTER TABLE runtime_sources ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'collector' CHECK(origin IN ('collector','connection','lab'));
ALTER TABLE runtime_sources ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES runtime_connections(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS runtime_sources_connection_idx ON runtime_sources(connection_id);
CREATE INDEX IF NOT EXISTS runtime_connections_service_idx ON runtime_connections(service_id);

CREATE TABLE IF NOT EXISTS runtime_lab_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('docker','kubernetes')),
  name TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT 'healthy',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runtime_lab_org_idx ON runtime_lab_sessions(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS runtime_lab_service_idx ON runtime_lab_sessions(service_id);

-- This application authenticates through its backend, not Supabase's public Data API.
-- Table owners retain backend access; anonymous/client roles receive no app-table access.
DO $$
DECLARE app_table text; api_role text; seq_name text;
BEGIN
  FOREACH app_table IN ARRAY ARRAY['organizations','users','memberships','services','service_checks','incidents','incident_events','ai_analyses','telemetry_events','workspace_invites','runtime_sources','runtime_resources','runtime_connections','runtime_lab_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',app_table);
    FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I',app_table,api_role);
      seq_name := NULL;
      IF app_table IN ('service_checks','telemetry_events') THEN seq_name := pg_get_serial_sequence(app_table,'id'); END IF;
      IF seq_name IS NOT NULL THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I',seq_name,api_role); END IF;
    END LOOP;
  END LOOP;
END $$;
