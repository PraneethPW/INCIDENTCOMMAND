import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Copy, RefreshCw, Settings2, Users, X } from "lucide-react";
import { api } from "./api";
import type { Incident, Member, Service, ServiceHistory, User } from "./types";

const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Unable to complete this action. Please retry.";
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current
      ?.querySelector<HTMLElement>("input,button,select,textarea")
      ?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const items = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ) || [],
      );
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        className="command-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <span>WORKSPACE OPERATIONS</span>
            <h2>{title}</h2>
          </div>
          <button aria-label="Close dialog" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ServiceControls({
  service,
  user,
  onUpdated,
}: {
  service: Service;
  user: User;
  onUpdated: () => void;
}) {
  const [mode, setMode] = useState<"edit" | "history" | "rotate" | null>(null);
  const [history, setHistory] = useState<ServiceHistory | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = ["owner", "admin"].includes(user.role);
  async function showHistory() {
    setMode("history");
    setError("");
    setHistory(null);
    try {
      setHistory(await api.history(service.id));
    } catch (e) {
      setError(message(e));
    }
  }
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(e.currentTarget);
    try {
      await api.editService(service.id, {
        name: form.get("name"),
        description: form.get("description"),
        region: form.get("region"),
        healthUrl: form.get("healthUrl"),
        expectedStatus: Number(form.get("expectedStatus")),
        checkIntervalSeconds: Number(form.get("checkIntervalSeconds")),
        monitoringEnabled: form.get("monitoringEnabled") === "on",
      });
      setMode(null);
      onUpdated();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="service-management">
        <button onClick={() => void showHistory()}>View signal history</button>
        {admin && (
          <>
            <button
              onClick={() => {
                setError("");
                setMode("edit");
              }}
            >
              <Settings2 size={14} /> Edit service
            </button>
            <button
              onClick={() => {
                setError("");
                setMode("rotate");
              }}
            >
              Rotate key
            </button>
          </>
        )}
      </div>
      {!service.monitoringEnabled && (
        <p className="paused-label">Scheduled monitoring paused</p>
      )}
      {mode === "edit" && (
        <Dialog
          title={`Manage ${service.name}`}
          onClose={() => !busy && setMode(null)}
        >
          <form className="command-form" onSubmit={save}>
            <label>
              SERVICE NAME
              <input
                name="name"
                defaultValue={service.name}
                required
                minLength={2}
                maxLength={100}
              />
            </label>
            <label>
              DESCRIPTION
              <textarea
                name="description"
                defaultValue={service.description}
                maxLength={500}
              />
            </label>
            <label>
              HEALTH URL
              <input
                name="healthUrl"
                type="url"
                defaultValue={service.healthUrl || ""}
                placeholder="https://api.example.com/health"
              />
            </label>
            <div className="form-grid">
              <label>
                REGION
                <input name="region" defaultValue={service.region} required />
              </label>
              <label>
                INTERVAL (SECONDS)
                <input
                  type="number"
                  name="checkIntervalSeconds"
                  min={30}
                  max={3600}
                  defaultValue={service.checkIntervalSeconds}
                  required
                />
              </label>
            </div>
            <label>
              EXPECTED STATUS
              <input
                type="number"
                name="expectedStatus"
                min={100}
                max={599}
                defaultValue={service.expectedStatus}
                required
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="monitoringEnabled"
                defaultChecked={service.monitoringEnabled}
              />{" "}
              Scheduled monitoring enabled
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary-button" disabled={busy}>
              {busy ? "Saving…" : "Save service"}
            </button>
          </form>
        </Dialog>
      )}
      {mode === "rotate" && (
        <Dialog
          title="Rotate ingest key"
          onClose={() => !busy && setMode(null)}
        >
          <div className="command-form">
            <p>
              The current key for {service.name} will stop working immediately.
              Update your telemetry sender with the new copied command
              afterward.
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .rotateKey(service.id)
                  .then(() => {
                    setMode(null);
                    onUpdated();
                  })
                  .catch((e) => setError(message(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Rotating…" : "Rotate key now"}
            </button>
          </div>
        </Dialog>
      )}
      {mode === "history" && (
        <Dialog
          title={`${service.name} · signals`}
          onClose={() => setMode(null)}
        >
          <div className="signal-history">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {!history && !error && <p>Loading recorded signals…</p>}
            {history && (
              <>
                <h3>Recent health checks</h3>
                {!history.checks.length && (
                  <p>No health checks recorded yet.</p>
                )}
                {history.checks.map((item, i) => (
                  <div key={i}>
                    <span className={`service-state ${item.status}`}>
                      {item.status}
                    </span>
                    <b>
                      {item.latencyMs} ms · {item.statusCode ?? "No response"}
                    </b>
                    <p>{item.message}</p>
                    <small>{new Date(item.at).toLocaleString()}</small>
                  </div>
                ))}
                <h3>Recent telemetry</h3>
                {!history.telemetry.length && <p>No telemetry received yet.</p>}
                {history.telemetry.map((item, i) => (
                  <div key={i}>
                    <b>
                      {item.severity} · {item.eventType}
                    </b>
                    <p>{item.message}</p>
                    <small>{new Date(item.at).toLocaleString()}</small>
                  </div>
                ))}
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

export function IncidentCollaboration({
  incident,
  user,
  onUpdated,
}: {
  incident: Incident;
  user: User;
  onUpdated: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api
      .team()
      .then((data) => {
        if (active) setMembers(data);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [user.organizationId]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      onUpdated();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="collaboration-section">
      <label>
        INCIDENT OWNER
        <select
          aria-label="Incident owner"
          disabled={busy || user.role === "viewer"}
          value={incident.assignedTo || ""}
          onChange={(e) =>
            void action(() => api.assign(incident.id, e.target.value || null))
          }
        >
          <option value="">Unassigned</option>
          {members
            .filter((m) => m.role !== "viewer")
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </label>
      {user.role !== "viewer" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api.note(incident.id, note);
              setNote("");
            });
          }}
        >
          <label>
            RESPONDER NOTE
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              required
              placeholder="What changed, what you checked, and the next action…"
            />
          </label>
          <button
            className="primary-button compact"
            disabled={busy || !note.trim()}
          >
            Add timeline note
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="text-button"
        onClick={() => {
          const blob = new Blob([JSON.stringify(incident, null, 2)], {
            type: "application/json",
          });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = `${incident.code}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        Export incident report
      </button>
    </section>
  );
}

export function TeamPanel({
  user,
  onWorkspaceChanged,
}: {
  user: User;
  onWorkspaceChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [spaces, setSpaces] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState("");
  const [role, setRole] = useState("responder");
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  async function load() {
    const [m, s] = await Promise.all([api.team(), api.workspaces()]);
    setMembers(m);
    setSpaces(s);
  }
  // Load the authenticated workspace from the API on mount.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    void Promise.resolve()
      .then(load)
      .catch((e) => setError(message(e)));
  }, []);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="team-layout">
      <article className="panel">
        <div className="panel-head">
          <div>
            <small>PEOPLE & ACCESS</small>
            <h2>Your response team</h2>
          </div>
          <Users />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="team-members">
          {members.map((m) => (
            <div className="team-member" key={m.id}>
              <span className="member-avatar">
                {m.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <b>{m.name}</b>
                <small>{m.email}</small>
              </div>
              {user.role === "owner" && m.role !== "owner" ? (
                <select
                  aria-label={`Role for ${m.name}`}
                  disabled={busy}
                  value={m.role}
                  onChange={(e) =>
                    void action(() => api.role(m.id, e.target.value))
                  }
                >
                  <option value="admin">Admin</option>
                  <option value="responder">Responder</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className="role-badge">{m.role}</span>
              )}
            </div>
          ))}
        </div>
      </article>
      <article className="panel team-actions">
        <h2>Workspace access</h2>
        <p>
          Owners and admins manage services. Responders coordinate incidents.
          Viewers have read-only access.
        </p>
        {spaces.length > 1 && (
          <label>
            SWITCH WORKSPACE
            <select
              value={user.organizationId}
              disabled={busy}
              onChange={(e) =>
                void action(async () => {
                  await api.switchWorkspace(e.target.value);
                  onWorkspaceChanged();
                })
              }
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {["owner", "admin"].includes(user.role) && (
          <>
            <h3>Invite a teammate</h3>
            <p>
              Create a single-use code valid for 48 hours. Your teammate creates
              an account, then enters the code here to join.
            </p>
            <label>
              INVITATION ROLE
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="responder">Responder</option>
                <option value="viewer">Viewer</option>
                {user.role === "owner" && <option value="admin">Admin</option>}
              </select>
            </label>
            <button
              className="primary-button compact"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  setInvite((await api.invite(role)).token);
                  setCopied(false);
                })
              }
            >
              Create invitation code
            </button>
            {invite && (
              <div className="invite-result">
                <code>{invite}</code>
                <button
                  aria-label="Copy invitation code"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(invite)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError(
                          "Clipboard unavailable. Select and copy the code above.",
                        ),
                      )
                  }
                >
                  <Copy size={15} />
                  {copied ? "Copied" : "Copy code"}
                </button>
              </div>
            )}
          </>
        )}
        <h3>Join another workspace</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(async () => {
              await api.join(token.trim());
              onWorkspaceChanged();
            });
          }}
        >
          <label>
            INVITATION CODE
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
              placeholder="Paste the invitation code"
            />
          </label>
          <button
            className="primary-button compact"
            disabled={busy || !token.trim()}
          >
            <RefreshCw size={15} /> Join workspace
          </button>
        </form>
      </article>
    </section>
  );
}
