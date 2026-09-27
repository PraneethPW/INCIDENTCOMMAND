import type { Response } from 'express'

interface RealtimeEvent {
  type: string
  message: string
  resource?: string
  resourceId?: string
  data?: unknown
  at?: string
}

const clients = new Map<string, Set<Response>>()

export function attachClient(organizationId: string, response: Response) {
  const group = clients.get(organizationId) || new Set<Response>()
  group.add(response)
  clients.set(organizationId, group)
  response.write(`data: ${JSON.stringify({ type: 'connected', message: 'Live command stream connected', at: new Date().toISOString() })}\n\n`)
  return () => {
    group.delete(response)
    if (!group.size) clients.delete(organizationId)
  }
}

export function broadcast(organizationId: string, event: RealtimeEvent) {
  const payload = `data: ${JSON.stringify({ ...event, at: event.at || new Date().toISOString() })}\n\n`
  clients.get(organizationId)?.forEach((response) => response.write(payload))
}

setInterval(() => {
  clients.forEach((group) => group.forEach((response) => response.write(': heartbeat\n\n')))
}, 25_000).unref()
