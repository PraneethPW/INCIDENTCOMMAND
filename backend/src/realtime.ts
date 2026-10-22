import type { Response } from "express";
import pg from "pg";
import { pool } from "./database.js";

interface RealtimeEvent {
  type: string;
  message: string;
  resource?: string;
  resourceId?: string;
  data?: unknown;
  at?: string;
}
const clients = new Map<string, Set<Response>>();
function deliver(organizationId: string, event: RealtimeEvent) {
  const payload = `data: ${JSON.stringify({ ...event, at: event.at || new Date().toISOString() })}\n\n`;
  clients.get(organizationId)?.forEach((response) => {
    if (response.destroyed || response.writableLength > 256_000) {
      response.end();
      return;
    }
    response.write(payload);
  });
}
export function attachClient(organizationId: string, response: Response) {
  const group = clients.get(organizationId) || new Set<Response>();
  group.add(response);
  clients.set(organizationId, group);
  response.write(
    `retry: 3000\ndata: ${JSON.stringify({ type: "connected", message: "Live command stream connected", at: new Date().toISOString() })}\n\n`,
  );
  return () => {
    group.delete(response);
    if (!group.size) clients.delete(organizationId);
  };
}
export function broadcast(organizationId: string, event: RealtimeEvent) {
  // Keep notifications small and never distribute ingest keys or raw telemetry.
  const { data: _data, ...safeEvent } = event;
  void pool
    ?.query(`SELECT pg_notify('incident_command', $1)`, [
      JSON.stringify({ organizationId, event: safeEvent }),
    ])
    .catch(() => deliver(organizationId, safeEvent));
}
export function startRealtime() {
  let stopped = false;
  let client: pg.Client | undefined;
  let retry: ReturnType<typeof setTimeout>;
  async function listen() {
    if (!pool || stopped) return;
    try {
      const url = new URL(
        process.env.DATABASE_LISTEN_URL || process.env.DATABASE_URL!,
      );
      if (url.hostname.endsWith(".neon.tech"))
        url.hostname = url.hostname.replace("-pooler.", ".");
      const connection = new pg.Client({
        connectionString: url.href,
        connectionTimeoutMillis: 10_000,
      });
      client = connection;
      const reconnect = () => {
        if (client !== connection) return;
        client = undefined;
        void connection.end().catch(() => undefined);
        if (!stopped) retry = setTimeout(() => void listen(), 5000);
      };
      connection.on("error", reconnect);
      connection.on("notification", (message) => {
        try {
          const value = JSON.parse(message.payload || "");
          if (value.organizationId && value.event)
            deliver(value.organizationId, value.event);
        } catch {
          /* Invalid frame. */
        }
      });
      await connection.connect();
      await connection.query("LISTEN incident_command");
      clients.forEach((_group, org) =>
        deliver(org, {
          type: "connected",
          message: "Live command stream reconnected",
        }),
      );
    } catch {
      void client?.end().catch(() => undefined);
      client = undefined;
      if (!stopped) retry = setTimeout(() => void listen(), 15_000);
    }
  }
  void listen();
  const heartbeat = setInterval(
    () =>
      clients.forEach((group) =>
        group.forEach((response) => {
          if (!response.destroyed) response.write(": heartbeat\n\n");
        }),
      ),
    25_000,
  );
  heartbeat.unref();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    void client?.end().catch(() => undefined);
    client = undefined;
    clients.forEach((group) => group.forEach((response) => response.end()));
    clients.clear();
  };
}
