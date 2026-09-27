import { randomBytes } from 'node:crypto'
import { pool, requirePool } from './database.js'
import { broadcast } from './realtime.js'

interface ServiceRow {
  id: string
  organizationId: string
  name: string
  slug: string
  region: string
  healthUrl: string | null
  expectedStatus: number
  checkIntervalSeconds: number
  consecutiveFailures: number
  currentStatus: 'healthy' | 'degraded' | 'down' | 'unknown'
}

export function newIngestKey() {
  return `ic_live_${randomBytes(24).toString('hex')}`
}

export async function checkService(service: ServiceRow) {
  if (!service.healthUrl) throw new Error('This service does not have a health URL')
  const db = requirePool()
  const started = Date.now()
  let statusCode: number | null = null
  let message = ''
  let healthy = false
  try {
    const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(10_000), redirect: 'follow' })
    statusCode = response.status
    healthy = response.status === service.expectedStatus
    message = healthy ? `Health check returned ${response.status}` : `Expected ${service.expectedStatus}, received ${response.status}`
  } catch (error) {
    message = error instanceof Error ? error.message : 'Health check failed'
  }
  const latencyMs = Date.now() - started
  const failures = healthy ? 0 : service.consecutiveFailures + 1
  const status: ServiceRow['currentStatus'] = healthy ? 'healthy' : failures >= 2 ? 'down' : 'degraded'

  await db.query('BEGIN')
  try {
    await db.query(`UPDATE services SET current_status=$1, consecutive_failures=$2, last_checked_at=NOW() WHERE id=$3`, [status, failures, service.id])
    await db.query(`INSERT INTO service_checks (organization_id, service_id, status, status_code, latency_ms, message) VALUES ($1,$2,$3,$4,$5,$6)`, [service.organizationId, service.id, status, statusCode, latencyMs, message])

    if (status === 'down') {
      const existing = await db.query(`SELECT id FROM incidents WHERE organization_id=$1 AND service_id=$2 AND source='health-monitor' AND status <> 'resolved' LIMIT 1`, [service.organizationId, service.id])
      if (!existing.rowCount) {
        const code = `INC-${Date.now().toString(36).toUpperCase()}`
        const created = await db.query<{ id: string }>(`INSERT INTO incidents (organization_id, service_id, code, title, service, severity, status, region, source, description, impact, latency_ms) VALUES ($1,$2,$3,$4,$5,'critical','investigating',$6,'health-monitor',$7,$8,$9) RETURNING id`, [service.organizationId, service.id, code, `${service.name} health check failed`, service.slug, service.region, message, 'Service is unavailable or returning an unexpected response.', latencyMs])
        await db.query(`INSERT INTO incident_events (organization_id, incident_id, event_type, message, metadata) VALUES ($1,$2,'detected',$3,$4)`, [service.organizationId, created.rows[0].id, 'Incident created automatically after consecutive health-check failures.', JSON.stringify({ statusCode, latencyMs })])
        broadcast(service.organizationId, { type: 'incident.created', message: `${service.name} declared down`, resource: 'incident', resourceId: created.rows[0].id })
      }
    }

    if (healthy && service.currentStatus === 'down') {
      const resolved = await db.query<{ id: string }>(`UPDATE incidents SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE organization_id=$1 AND service_id=$2 AND source='health-monitor' AND status <> 'resolved' RETURNING id`, [service.organizationId, service.id])
      for (const incident of resolved.rows) {
        await db.query(`INSERT INTO incident_events (organization_id, incident_id, event_type, message) VALUES ($1,$2,'resolved','Health checks recovered and the incident was resolved automatically.')`, [service.organizationId, incident.id])
      }
    }
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }

  broadcast(service.organizationId, { type: 'service.check', message: `${service.name}: ${status} in ${latencyMs}ms`, resource: 'service', resourceId: service.id, data: { status, statusCode, latencyMs } })
  return { status, statusCode, latencyMs, message, checkedAt: new Date().toISOString() }
}

async function runDueChecks() {
  if (!pool) return
  const result = await pool.query<ServiceRow>(`
    SELECT id, organization_id AS "organizationId", name, slug, region, health_url AS "healthUrl",
      expected_status AS "expectedStatus", check_interval_seconds AS "checkIntervalSeconds",
      consecutive_failures AS "consecutiveFailures", current_status AS "currentStatus"
    FROM services
    WHERE monitoring_enabled=TRUE AND health_url IS NOT NULL
      AND (last_checked_at IS NULL OR last_checked_at < NOW() - make_interval(secs => check_interval_seconds))
    LIMIT 25
  `)
  await Promise.allSettled(result.rows.map(checkService))
}

export function startMonitor() {
  const timer = setInterval(() => runDueChecks().catch((error) => console.error('Monitor cycle failed', error)), 15_000)
  timer.unref()
  runDueChecks().catch((error) => console.error('Initial monitor cycle failed', error))
}
