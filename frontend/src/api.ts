import type {
  Analysis,
  AppConfig,
  Incident,
  IncidentStatus,
  LiveEvent,
  Overview,
  Service,
  User,
} from "./types";

export class ApiError extends Error {
  status: number;
  setup?: string;
  constructor(message: string, status: number, setup?: string) {
    super(message);
    this.status = status;
    this.setup = setup;
  }
}

const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const apiUrl = (path: string) => `${apiBase}${path}`;

export const ingestUrl = (id: string) =>
  new URL(apiUrl(`/api/ingest/${id}`), window.location.origin).href;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(url), {
    credentials: "include",
    signal: AbortSignal.timeout(url.endsWith("/analyze") ? 50_000 : 20_000),
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    setup?: string;
  };
  if (!response.ok)
    throw new ApiError(
      payload.error || `Request failed (${response.status})`,
      response.status,
      payload.setup,
    );
  return payload as T;
}

export const api = {
  config: async () => (await request<{ data: AppConfig }>("/api/config")).data,
  me: async () => (await request<{ data: User }>("/api/auth/me")).data,
  register: async (body: {
    name: string;
    email: string;
    password: string;
    organization: string;
  }) =>
    (
      await request<{ data: User }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).data,
  login: async (body: { email: string; password: string }) =>
    (
      await request<{ data: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).data,
  logout: async () => request("/api/auth/logout", { method: "POST" }),
  overview: async () =>
    (await request<{ data: Overview }>("/api/overview")).data,
  incidents: async () =>
    (await request<{ data: Incident[] }>("/api/incidents")).data,
  incident: async (id: string) =>
    (await request<{ data: Incident }>(`/api/incidents/${id}`)).data,
  createIncident: async (body: Record<string, unknown>) =>
    (
      await request<{ data: Incident }>("/api/incidents", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).data,
  updateStatus: async (id: string, status: IncidentStatus) =>
    (
      await request<{ data: Incident }>(`/api/incidents/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      })
    ).data,
  analyze: async (id: string) =>
    (
      await request<{ data: Analysis }>(`/api/incidents/${id}/analyze`, {
        method: "POST",
      })
    ).data,
  team: async () =>
    (await request<{ data: import("./types").Member[] }>("/api/team")).data,
  workspaces: async () =>
    (
      await request<{ data: { id: string; name: string; role: string }[] }>(
        "/api/workspaces",
      )
    ).data,
  switchWorkspace: (organizationId: string) =>
    request("/api/workspaces/switch", {
      method: "POST",
      body: JSON.stringify({ organizationId }),
    }),
  invite: async (role: string) =>
    (
      await request<{ data: { token: string } }>("/api/team/invites", {
        method: "POST",
        body: JSON.stringify({ role }),
      })
    ).data,
  join: (token: string) =>
    request("/api/team/join", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  role: (id: string, role: string) =>
    request(`/api/team/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  note: (id: string, message: string) =>
    request(`/api/incidents/${id}/notes`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  assign: (id: string, userId: string | null) =>
    request(`/api/incidents/${id}/assignee`, {
      method: "PATCH",
      body: JSON.stringify({ userId }),
    }),
  editService: (id: string, body: Record<string, unknown>) =>
    request(`/api/services/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  rotateKey: (id: string) =>
    request(`/api/services/${id}/rotate-key`, { method: "POST" }),
  history: async (id: string) =>
    (
      await request<{ data: import("./types").ServiceHistory }>(
        `/api/services/${id}/history`,
      )
    ).data,
  services: async () =>
    (await request<{ data: Service[] }>("/api/services")).data,
  createService: async (body: Record<string, unknown>) =>
    (
      await request<{ data: Service }>("/api/services", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).data,
  checkService: async (id: string) =>
    (
      await request<{ data: unknown }>(`/api/services/${id}/check`, {
        method: "POST",
      })
    ).data,
};

export function subscribe(
  onEvent: (event: LiveEvent) => void,
  onConnection: (connected: boolean) => void,
) {
  const stream = new EventSource(apiUrl("/api/stream"), {
    withCredentials: true,
  });
  stream.onopen = () => onConnection(true);
  stream.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as LiveEvent);
    } catch {
      /* Ignore malformed frames. */
    }
  };
  stream.onerror = () => onConnection(false);
  return () => stream.close();
}
