import type { Analysis, AppConfig, Incident, IncidentStatus, LiveEvent, Overview, Service, User } from './types'

export class ApiError extends Error { status: number; setup?: string; constructor(message: string, status: number, setup?: string) { super(message); this.status = status; this.setup = setup } }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => ({})) as { error?: string; setup?: string }
  if (!response.ok) throw new ApiError(payload.error || `Request failed (${response.status})`, response.status, payload.setup)
  return payload as T
}

export const api = {
  config: async () => (await request<{ data: AppConfig }>('/api/config')).data,
  me: async () => (await request<{ data: User }>('/api/auth/me')).data,
  register: async (body: { name: string; email: string; password: string; organization: string }) => (await request<{ data: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) })).data,
  login: async (body: { email: string; password: string }) => (await request<{ data: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) })).data,
  logout: async () => request('/api/auth/logout', { method: 'POST' }),
  overview: async () => (await request<{ data: Overview }>('/api/overview')).data,
  incidents: async () => (await request<{ data: Incident[] }>('/api/incidents')).data,
  incident: async (id: string) => (await request<{ data: Incident }>(`/api/incidents/${id}`)).data,
  createIncident: async (body: Record<string, unknown>) => (await request<{ data: Incident }>('/api/incidents', { method: 'POST', body: JSON.stringify(body) })).data,
  updateStatus: async (id: string, status: IncidentStatus) => (await request<{ data: Incident }>(`/api/incidents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })).data,
  analyze: async (id: string) => (await request<{ data: Analysis }>(`/api/incidents/${id}/analyze`, { method: 'POST' })).data,
  services: async () => (await request<{ data: Service[] }>('/api/services')).data,
  createService: async (body: Record<string, unknown>) => (await request<{ data: Service }>('/api/services', { method: 'POST', body: JSON.stringify(body) })).data,
  checkService: async (id: string) => (await request<{ data: unknown }>(`/api/services/${id}/check`, { method: 'POST' })).data,
}

export function subscribe(onEvent: (event: LiveEvent) => void, onConnection: (connected: boolean) => void) {
  const stream = new EventSource('/api/stream', { withCredentials: true })
  stream.onopen = () => onConnection(true)
  stream.onmessage = (event) => { try { onEvent(JSON.parse(event.data) as LiveEvent) } catch { /* Ignore malformed frames. */ } }
  stream.onerror = () => onConnection(false)
  return () => stream.close()
}
