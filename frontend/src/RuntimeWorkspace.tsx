import { useCallback, useEffect, useState } from "react";
import {
  Boxes,
  Container,
  FlaskConical,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { api } from "./api";
import { Dialog } from "./Operations";
import { InfrastructurePanel } from "./Infrastructure";
import type {
  Infrastructure,
  RuntimeConnection,
  RuntimeConnectionInput,
  RuntimeLabs,
  RuntimeResource,
  Service,
  User,
} from "./types";

const message = (e: unknown) =>
  e instanceof Error
    ? e.message
    : "Unable to complete this action. Retry shortly.";
const date = (v: string | null) =>
  v ? new Date(v).toLocaleString() : "Not checked yet";
const emptyLabs: RuntimeLabs = { sessions: [], resources: [], incidents: [] };
export function RuntimeWorkspace({
  data,
  services,
  user,
  onRefresh,
  onOpenIncident,
}: {
  data: Infrastructure;
  services: Service[];
  user: User;
  onRefresh: () => Promise<void>;
  onOpenIncident: (id: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"live" | "lab">("live");
  const [connections, setConnections] = useState<RuntimeConnection[]>([]);
  const [labs, setLabs] = useState(emptyLabs);
  const [editing, setEditing] = useState<RuntimeConnection | "new" | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [removing, setRemoving] = useState<RuntimeConnection | null>(null);
  const canManage = ["owner", "admin"].includes(user.role),
    canWrite = user.role !== "viewer";
  const reload = useCallback(async () => {
    try {
      const [nextConnections, nextLabs] = await Promise.all([
        api.runtimeConnections(),
        api.runtimeLabs(),
      ]);
      setConnections(nextConnections);
      setLabs(nextLabs);
      setLoaded(true);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  // Refresh persisted runtime controls with the parent SSE snapshot, including reconnects.
  useEffect(() => {
    void Promise.resolve().then(reload);
  }, [reload, data]);
  async function act(key: string, operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await operation();
      await reload();
      await onRefresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="runtime-workspace">
      <div className="runtime-intro panel">
        <div>
          <span className="runtime-kicker">DOCKER / KUBERNETES</span>
          <h2>Connect. Observe. Respond.</h2>
          <p>
            Bring a reachable runtime API into your workspace, or explore
            incident response in a browser test lab.
          </p>
        </div>
        <ShieldCheck size={34} aria-hidden="true" />
      </div>
      <div
        className="runtime-tabs"
        role="tablist"
        aria-label="Runtime workspace"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "live"
              : event.key === "End"
                ? "lab"
                : tab === "live"
                  ? "lab"
                  : "live";
          setTab(next);
          event.currentTarget
            .querySelector<HTMLButtonElement>(`#runtime-tab-${next}`)
            ?.focus();
        }}
      >
        <button
          role="tab"
          id="runtime-tab-live"
          aria-controls="runtime-panel-live"
          tabIndex={tab === "live" ? 0 : -1}
          aria-selected={tab === "live"}
          onClick={() => setTab("live")}
        >
          <Link2 size={17} /> Live connections
        </button>
        <button
          role="tab"
          id="runtime-tab-lab"
          aria-controls="runtime-panel-lab"
          tabIndex={tab === "lab" ? 0 : -1}
          aria-selected={tab === "lab"}
          onClick={() => setTab("lab")}
        >
          <FlaskConical size={17} /> Browser test lab
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setError("");
              void reload();
            }}
          >
            Retry
          </button>
        </p>
      )}
      {!loaded && <p role="status">Loading runtime workspace…</p>}
      {busy && (
        <p className="runtime-progress" role="status">
          Updating runtime state…
        </p>
      )}
      {tab === "live" ? (
        <div
          id="runtime-panel-live"
          role="tabpanel"
          aria-labelledby="runtime-tab-live"
        >
          <div className="runtime-section-head">
            <div>
              <h3>Your connections</h3>
              <p>
                Inventory syncs automatically. Real APIs are read through GET
                requests only.
              </p>
            </div>
            {canManage && (
              <button
                className="primary-button compact"
                onClick={() => setEditing("new")}
              >
                <Link2 size={16} /> Add connection
              </button>
            )}
          </div>
          {!connections.length && loaded && (
            <div className="panel runtime-onboarding">
              <Link2 size={28} />
              <div>
                <h3>Connect through a web form</h3>
                <p>
                  Use a Portainer API, a secured Docker API, or a Kubernetes
                  API. The hosted app needs a reachable HTTPS endpoint and read
                  credentials.
                </p>
                <p>
                  For Docker Desktop running only on your laptop, try the
                  browser lab below. A local socket cannot be accessed by the
                  hosted website.
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={() => setTab("lab")}
              >
                Try browser lab
              </button>
            </div>
          )}
          <div className="runtime-connection-grid">
            {connections.map((c) => (
              <article className="panel runtime-connection" key={c.id}>
                <div className="runtime-section-head">
                  <h3>{c.name}</h3>
                  <span
                    className={`runtime-state ${!c.enabled ? "unknown" : c.lastStatus === "error" ? "down" : c.lastStatus === "connected" ? "healthy" : "unknown"}`}
                  >
                    {!c.enabled ? "paused" : c.lastStatus}
                  </span>
                </div>
                <p>
                  {c.provider === "portainer"
                    ? "Docker via Portainer"
                    : c.provider === "docker"
                      ? "Docker API"
                      : "Kubernetes API"}{" "}
                  · every {c.intervalSeconds}s
                </p>
                <code className="runtime-endpoint">{c.endpointUrl}</code>
                <small>Last attempt · {date(c.lastCheckedAt)}</small>
                {c.lastError && (
                  <p className="form-error">
                    {c.lastError} Previous observations remain available; failed
                    syncs do not resolve incidents.
                  </p>
                )}
                <div className="runtime-actions">
                  {canWrite && (
                    <button
                      className="secondary-button"
                      disabled={Boolean(busy) || !c.enabled}
                      onClick={() =>
                        void act(c.id, () => api.syncRuntime(c.id))
                      }
                    >
                      <RefreshCw
                        size={14}
                        className={busy === c.id ? "spin" : ""}
                      />{" "}
                      Refresh
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button
                        className="secondary-button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void act(c.id, () =>
                            api.toggleRuntime(c.id, !c.enabled),
                          )
                        }
                      >
                        {c.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        className="secondary-button"
                        disabled={Boolean(busy)}
                        onClick={() => setEditing(c)}
                      >
                        Reconnect
                      </button>
                      <button
                        className="secondary-button"
                        disabled={Boolean(busy)}
                        onClick={() => setRemoving(c)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <InfrastructurePanel
            webWorkspace
            data={data}
            services={services}
            user={user}
            onConnectService={() => setEditing("new")}
            onOpenIncident={onOpenIncident}
          />
        </div>
      ) : (
        <div
          id="runtime-panel-lab"
          role="tabpanel"
          aria-labelledby="runtime-tab-lab"
        >
          <div className="runtime-lab-notice">
            <FlaskConical size={24} />
            <div>
              <b>Controlled simulation · no installation needed</b>
              <p>
                These scenarios submit test observations to the incident engine.
                They do not run containers, contact a cluster, or change real
                infrastructure. Test services and incidents stay out of live
                metrics.
              </p>
            </div>
          </div>
          <div className="runtime-lab-launch">
            {(["docker", "kubernetes"] as const).map((platform) => (
              <article className="panel" key={platform}>
                {platform === "docker" ? (
                  <Container size={30} />
                ) : (
                  <Boxes size={30} />
                )}
                <h3>{platform === "docker" ? "Docker" : "Kubernetes"} lab</h3>
                <p>
                  {platform === "docker"
                    ? "Explore unhealthy containers, crashes, paused workloads and memory failures."
                    : "Explore crash loops, image pull failures, readiness problems and replica loss."}
                </p>
                <button
                  className="primary-button compact"
                  disabled={Boolean(busy) || !canWrite}
                  onClick={() =>
                    void act(platform, () => api.startLab(platform))
                  }
                >
                  {busy === platform ? "Starting…" : "Start lab"}
                </button>
              </article>
            ))}
          </div>
          <div className="runtime-section-head">
            <h3>Test sessions</h3>
            <label>
              <input
                type="checkbox"
                checked={showEnded}
                onChange={(e) => setShowEnded(e.target.checked)}
              />{" "}
              Include ended sessions
            </label>
          </div>
          {!labs.sessions.filter((s) => showEnded || !s.endedAt).length &&
            loaded && (
              <p className="runtime-muted">
                Start a lab, choose a failure, then restore health to follow its
                incident through recovery.
              </p>
            )}
          {labs.sessions
            .filter((s) => showEnded || !s.endedAt)
            .map((session) => {
              const scenarios =
                session.platform === "docker"
                  ? [
                      ["unhealthy", "Unhealthy"],
                      ["paused", "Paused"],
                      ["crash", "Crash"],
                      ["oom", "Out of memory"],
                      ["missing", "Missing workload"],
                    ]
                  : [
                      ["crashloop", "Crash loop"],
                      ["imagepull", "Image pull failure"],
                      ["readiness", "Not ready"],
                      ["replicas", "Replica loss"],
                      ["missing", "Missing workloads"],
                    ];
              return (
                <article className="panel runtime-lab-session" key={session.id}>
                  <div className="runtime-section-head">
                    <div>
                      <span className="runtime-kicker">
                        TEST DATA · {session.platform.toUpperCase()}
                      </span>
                      <h3>
                        {session.name} <small>#{session.id.slice(0, 6)}</small>
                      </h3>
                    </div>
                    <span className="runtime-state unknown">
                      {session.endedAt ? "ended" : session.scenario}
                    </span>
                  </div>
                  <p>
                    Last scenario · {date(session.updatedAt)}. This state
                    changes only when you run a scenario.
                  </p>
                  <div className="runtime-actions">
                    {scenarios.map(([key, label]) => (
                      <button
                        className="secondary-button"
                        aria-pressed={session.scenario === key}
                        key={key}
                        disabled={
                          Boolean(busy) || !canWrite || Boolean(session.endedAt)
                        }
                        onClick={() =>
                          void act(session.id, () =>
                            api.labScenario(session.id, key),
                          )
                        }
                      >
                        {label}
                      </button>
                    ))}
                    <button
                      className="primary-button compact"
                      disabled={
                        Boolean(busy) || !canWrite || Boolean(session.endedAt)
                      }
                      onClick={() =>
                        void act(session.id, () =>
                          api.labScenario(session.id, "healthy"),
                        )
                      }
                    >
                      Restore healthy
                    </button>
                  </div>
                  <div className="runtime-lab-resources">
                    {labs.resources
                      .filter((r) => r.serviceId === session.serviceId)
                      .map((r) => (
                        <div key={r.id}>
                          <span
                            className={`runtime-state ${r.present ? r.status : "unknown"}`}
                          >
                            {r.present ? r.status : "missing"}
                          </span>
                          <b>
                            {r.kind} · {r.name}
                          </b>
                          <span>
                            {r.present
                              ? r.reason
                              : "Absent from the last simulated inventory; recovery is unverified."}
                          </span>
                        </div>
                      ))}
                  </div>
                  <div className="runtime-lab-results">
                    <b>Test incident history</b>
                    {labs.incidents.filter(
                      (i) => i.serviceId === session.serviceId,
                    ).length === 0 ? (
                      <p>No failure recorded. Choose a scenario above.</p>
                    ) : (
                      labs.incidents
                        .filter((i) => i.serviceId === session.serviceId)
                        .map((i) => (
                          <button
                            key={i.id}
                            onClick={() => void onOpenIncident(i.id)}
                          >
                            <span>
                              {i.code} · {i.status}
                            </span>
                            <b>{i.title}</b>
                            <span>Investigate →</span>
                          </button>
                        ))
                    )}
                  </div>
                  {!session.endedAt && canWrite && (
                    <button
                      className="runtime-end-lab"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void act(session.id, () => api.endLab(session.id))
                      }
                    >
                      End session · retain test history
                    </button>
                  )}
                </article>
              );
            })}
        </div>
      )}
      {editing && (
        <ConnectionDialog
          connection={editing === "new" ? undefined : editing}
          services={services}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
            await onRefresh();
          }}
        />
      )}
      {removing && (
        <Dialog
          title="Remove connection"
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="command-form runtime-connect-form">
            <p>
              Remove {removing.name} and its saved credentials? Polling stops.
              Existing observations and incident history remain available.
            </p>
            <button
              className="primary-button compact"
              disabled={Boolean(busy)}
              onClick={() =>
                void act(removing.id, async () => {
                  await api.removeRuntime(removing.id);
                  setRemoving(null);
                })
              }
            >
              Remove connection
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function ConnectionDialog({
  connection,
  services,
  onClose,
  onSaved,
}: {
  connection?: RuntimeConnection;
  services: Service[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [input, setInput] = useState<RuntimeConnectionInput>({
    name: connection?.name || "",
    provider: connection?.provider || "portainer",
    endpointUrl: connection?.endpointUrl || "",
    namespace: connection?.namespace || "default",
    environmentId: connection?.environmentId || undefined,
    serviceId: connection?.serviceId,
    selector: connection?.selector || "",
    intervalSeconds: connection?.intervalSeconds || 60,
    token: "",
    certificateAuthority: "",
    clientCertificate: "",
    clientKey: "",
  });
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [preview, setPreview] = useState<RuntimeResource[] | null>(null);
  const [environments, setEnvironments] = useState<
    { id: number; name: string }[]
  >([]);
  function change<K extends keyof RuntimeConnectionInput>(
    key: K,
    value: RuntimeConnectionInput[K],
  ) {
    setInput((v) => ({ ...v, [key]: value }));
    setPreview(null);
    setError("");
    if (
      ["endpointUrl", "token", "certificateAuthority", "provider"].includes(key)
    )
      setEnvironments([]);
  }
  async function action(mode: string) {
    if (busy) return;
    setBusy(mode);
    setError("");
    try {
      if (mode === "discover")
        setEnvironments(await api.discoverRuntime(input));
      else if (mode === "test")
        setPreview((await api.testRuntime(input)).resources);
      else {
        await api.saveRuntime(input, connection?.id);
        await onSaved();
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function file(
    key: "certificateAuthority" | "clientCertificate" | "clientKey",
    selected?: File,
  ) {
    if (!selected) return;
    if (selected.size > 32768) {
      setError("Each PEM file must be 32 KB or smaller.");
      return;
    }
    try {
      change(key, await selected.text());
    } catch {
      setError("Could not read this file. Select it again.");
    }
  }
  return (
    <Dialog
      title={connection ? "Reconnect runtime API" : "Connect a runtime API"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className="command-form runtime-connect-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action("save");
        }}
      >
        <p>
          Enter a reachable HTTPS API and read credentials. Connection tests
          verify access before anything is saved. Saved credentials are
          encrypted and never returned to the browser.
        </p>
        {connection && (
          <p className="runtime-lab-notice">
            Enter credentials again to reconnect. Saved secrets are never
            prefilled.
          </p>
        )}
        <fieldset disabled={Boolean(busy)}>
          <label className="field">
            <span>CONNECTION TYPE</span>
            <select
              value={input.provider}
              disabled={Boolean(connection)}
              onChange={(e) =>
                change(
                  "provider",
                  e.target.value as RuntimeConnectionInput["provider"],
                )
              }
            >
              <option value="portainer">Docker via Portainer</option>
              <option value="docker">Secured Docker Engine API</option>
              <option value="kubernetes">Kubernetes API</option>
            </select>
          </label>
          <label className="field">
            <span>CONNECTION NAME</span>
            <input
              required
              minLength={2}
              maxLength={64}
              placeholder="Production workloads"
              value={input.name}
              onChange={(e) => change("name", e.target.value)}
            />
          </label>
          <label className="field">
            <span>HTTPS API URL</span>
            <input
              required
              type="url"
              placeholder={
                input.provider === "portainer"
                  ? "https://portainer.example.com:9443"
                  : input.provider === "docker"
                    ? "https://docker-api.example.com:2376"
                    : "https://cluster-api.example.com:6443"
              }
              value={input.endpointUrl}
              onChange={(e) => {
                change("endpointUrl", e.target.value);
                change("environmentId", undefined);
              }}
            />
          </label>
          <label className="field">
            <span>
              {input.provider === "portainer"
                ? "PORTAINER API ACCESS TOKEN"
                : "BEARER TOKEN (OR USE CLIENT TLS BELOW)"}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={input.token}
              onChange={(e) => change("token", e.target.value)}
            />
          </label>
          {input.provider === "portainer" && (
            <div className="runtime-portainer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void action("discover")}
              >
                Find environments
              </button>
              <label className="field">
                <span>ENVIRONMENT</span>
                <select
                  value={input.environmentId || ""}
                  onChange={(e) =>
                    change("environmentId", Number(e.target.value) || undefined)
                  }
                >
                  <option value="">
                    {environments.length
                      ? "Choose an environment"
                      : connection?.environmentId
                        ? "Re-discover to change environment"
                        : "Find environments first"}
                  </option>
                  {connection?.environmentId &&
                    !environments.some(
                      (e) => e.id === connection.environmentId,
                    ) && (
                      <option value={connection.environmentId}>
                        Environment #{connection.environmentId}
                      </option>
                    )}
                  {environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · #{e.id}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {input.provider === "kubernetes" && (
            <label className="field">
              <span>NAMESPACE</span>
              <input
                required
                maxLength={63}
                value={input.namespace}
                onChange={(e) => change("namespace", e.target.value)}
              />
            </label>
          )}
          <div className="form-grid">
            <label className="field">
              <span>LABEL SELECTOR (OPTIONAL)</span>
              <input
                placeholder={
                  input.provider === "kubernetes" ? "app=orders" : "app=orders"
                }
                value={input.selector}
                onChange={(e) => change("selector", e.target.value)}
              />
            </label>
            <label className="field">
              <span>SYNC INTERVAL</span>
              <select
                value={input.intervalSeconds}
                onChange={(e) =>
                  change("intervalSeconds", Number(e.target.value))
                }
              >
                <option value={30}>30 seconds</option>
                <option value={60}>1 minute</option>
                <option value={300}>5 minutes</option>
              </select>
            </label>
          </div>
          {!connection && (
            <label className="field">
              <span>LINK TO SERVICE</span>
              <select
                value={input.serviceId || ""}
                onChange={(e) =>
                  change("serviceId", e.target.value || undefined)
                }
              >
                <option value="">Create a service automatically</option>
                {services.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <details>
            <summary>Certificate trust and client TLS</summary>
            <p>
              Upload PEM files when using a private CA or mutual TLS. Server
              certificate verification stays enabled.
            </p>
            {(
              [
                ["certificateAuthority", "CA certificate"],
                ["clientCertificate", "Client certificate"],
                ["clientKey", "Client private key"],
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  type="file"
                  accept=".pem,.crt,.key,.cer"
                  onChange={(e) => void file(key, e.target.files?.[0])}
                />
              </label>
            ))}
          </details>
        </fieldset>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {busy && (
          <p role="status">
            {busy === "discover"
              ? "Discovering environments…"
              : busy === "test"
                ? "Verifying API access and reading inventory…"
                : "Testing and saving connection…"}
          </p>
        )}
        {preview && (
          <div className="runtime-preview" role="status">
            <b>Connection verified · {preview.length} resources</b>
            <p>
              {preview.length
                ? preview
                    .slice(0, 5)
                    .map((r) => `${r.name} (${r.status})`)
                    .join(" · ")
                : "The API is reachable. No workloads match this namespace or selector."}
            </p>
          </div>
        )}
        <div className="runtime-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void action("test")}
          >
            Test connection
          </button>
          <button className="primary-button compact" disabled={Boolean(busy)}>
            {connection ? "Save reconnection" : "Connect and monitor"}
          </button>
        </div>
        <small>
          Only sanitized inventory is stored. Use an API identity with the
          minimum read permissions for containers or the selected namespace.
        </small>
      </form>
    </Dialog>
  );
}
