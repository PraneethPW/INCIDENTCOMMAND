import { useState } from "react";
import {
  Boxes,
  Container,
  Copy,
  ExternalLink,
  Search,
  ShieldCheck,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { Infrastructure, RuntimeResource, Service, User } from "./types";
import { Dialog } from "./Operations";

const statusLabel = (r: RuntimeResource) =>
  !r.present ? "missing" : r.stale ? "stale" : r.status;
const date = (value: string) => new Date(value).toLocaleString();
export function InfrastructurePanel({
  data,
  services,
  user,
  onConnectService,
  onOpenIncident,
}: {
  data: Infrastructure;
  services: Service[];
  user: User;
  onConnectService: () => void;
  onOpenIncident: (id: string) => Promise<void>;
}) {
  const [platform, setPlatform] = useState("all");
  const [health, setHealth] = useState("all");
  const [search, setSearch] = useState("");
  const [setup, setSetup] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = data.resources.find((r) => r.id === detailId);
  const resources = data.resources.filter(
    (r) =>
      (platform === "all" || r.platform === platform) &&
      (health === "all" ||
        (health === "attention"
          ? ["down", "degraded", "missing", "stale"].includes(statusLabel(r))
          : statusLabel(r) === health)) &&
      `${r.name} ${r.cluster} ${r.namespace} ${r.serviceName} ${r.reason}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const counts = {
    healthy: data.resources.filter((r) => statusLabel(r) === "healthy").length,
    attention: data.resources.filter((r) =>
      ["down", "degraded", "missing", "stale"].includes(statusLabel(r)),
    ).length,
    docker: data.resources.filter((r) => r.platform === "docker").length,
    kubernetes: data.resources.filter((r) => r.platform === "kubernetes")
      .length,
  };
  return (
    <section className="infrastructure-layout">
      <div className="runtime-intro panel">
        <div>
          <span className="runtime-kicker">DOCKER / KUBERNETES</span>
          <h2>Every workload. One response.</h2>
          <p>
            Follow container health and cluster workloads from their first
            signal to a verified recovery.
          </p>
        </div>
        <button
          className="primary-button compact"
          onClick={() => setSetup(true)}
        >
          <Terminal size={17} /> Connect collector
        </button>
      </div>
      <div className="runtime-metrics">
        {[
          ["Docker containers", counts.docker],
          ["Kubernetes resources", counts.kubernetes],
          ["Healthy observations", counts.healthy],
          ["Need attention", counts.attention],
        ].map(([label, value]) => (
          <article className="panel" key={label}>
            <small>{label}</small>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <div className="runtime-toolbar">
        <label className="runtime-search">
          <Search size={17} />
          <input
            aria-label="Search infrastructure"
            placeholder="Find workload, cluster, or reason…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="Runtime platform"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="all">All platforms</option>
          <option value="docker">Docker</option>
          <option value="kubernetes">Kubernetes</option>
        </select>
        <select
          aria-label="Runtime health"
          value={health}
          onChange={(e) => setHealth(e.target.value)}
        >
          <option value="all">All states</option>
          <option value="attention">Needs attention</option>
          <option value="healthy">Healthy</option>
          <option value="down">Down</option>
          <option value="degraded">Degraded</option>
          <option value="unknown">Unknown</option>
          <option value="completed">Completed</option>
          <option value="stale">Stale</option>
          <option value="missing">Missing</option>
        </select>
      </div>
      {data.sources.length > 0 && (
        <div className="runtime-sources" aria-label="Collector heartbeats">
          {data.sources.map((s) => (
            <div key={s.id} className={s.stale ? "collector-stale" : ""}>
              {s.stale ? <WifiOff size={15} /> : <span className="live-dot" />}
              <b>{s.cluster}</b>
              <span>
                {s.platform} · {s.resourceCount} resources
              </span>
              <small>
                {s.stale ? "Heartbeat overdue" : "Collector reporting"} ·{" "}
                {date(s.observedAt)}
              </small>
            </div>
          ))}
        </div>
      )}
      {!data.resources.length ? (
        <div className="panel runtime-empty">
          <Boxes size={38} />
          <h3>Your runtime inventory starts here.</h3>
          <p>
            Connect a Docker host or a Kubernetes namespace. Observed failures
            will open incidents in your existing queue.
          </p>
          <button
            className="primary-button compact"
            onClick={() => setSetup(true)}
          >
            Set up a collector
          </button>
        </div>
      ) : (
        <div className="panel runtime-inventory">
          <div className="runtime-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>WORKLOAD</th>
                  <th>STATE</th>
                  <th>PLACEMENT</th>
                  <th>READY / RESTARTS</th>
                  <th>RESPONSE</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <button
                        className="runtime-name"
                        onClick={() => setDetailId(r.id)}
                      >
                        {r.platform === "docker" ? (
                          <Container size={18} />
                        ) : (
                          <Boxes size={18} />
                        )}
                        <span>
                          <b>{r.name}</b>
                          <small>
                            {r.kind} · {r.serviceName}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <span className={`runtime-state ${statusLabel(r)}`}>
                        {statusLabel(r)}
                      </span>
                      <small className="runtime-reason">
                        {!r.present
                          ? "Absent from latest inventory"
                          : r.stale
                            ? `Last reported: ${r.status}`
                            : r.reason}
                      </small>
                    </td>
                    <td>
                      <b>{r.cluster}</b>
                      <small>{r.namespace || "Host scope"}</small>
                    </td>
                    <td>
                      <b>
                        {r.desired === null
                          ? "—"
                          : `${r.ready}/${r.desired} ready`}
                      </b>
                      <small>{r.restartCount} restarts</small>
                    </td>
                    <td>
                      {r.incidentId ? (
                        <button
                          className="runtime-incident"
                          onClick={() => void onOpenIncident(r.incidentId!)}
                        >
                          {r.incidentCode}
                          <ExternalLink size={13} />
                        </button>
                      ) : (
                        <span className="runtime-muted">No open incident</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!resources.length && (
            <p className="runtime-no-match">
              No workloads match these filters.
            </p>
          )}
          <footer>
            {resources.length} of {data.resources.length} loaded resources ·
            Last observed state; stale or missing is never treated as recovery.
          </footer>
        </div>
      )}
      <div className="runtime-boundary">
        <ShieldCheck size={18} />
        <p>
          Collectors observe runtime state. Incident decisions, notes, and AI
          investigation stay in your workspace. Disappearing workloads keep
          their incident open for review.
        </p>
      </div>
      {setup && (
        <CollectorSetup
          services={services}
          user={user}
          onClose={() => setSetup(false)}
          onConnectService={onConnectService}
        />
      )}
      {detail && (
        <Dialog title={detail.name} onClose={() => setDetailId(null)}>
          <div className="runtime-detail">
            <span className={`runtime-state ${statusLabel(detail)}`}>
              {statusLabel(detail)}
            </span>
            <p>{detail.reason}</p>
            <dl>
              {[
                ["Platform", detail.platform],
                ["Cluster / host", detail.cluster],
                ["Namespace", detail.namespace || "Host scope"],
                ["Resource UID", detail.uid],
                ["Image / digest", detail.image || "Not reported"],
                ["Last observed", date(detail.observedAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {detail.incidentId && (
              <button
                className="primary-button compact"
                onClick={() => {
                  setDetailId(null);
                  void onOpenIncident(detail.incidentId!);
                }}
              >
                Open incident
              </button>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
function CollectorSetup({
  services,
  user,
  onClose,
  onConnectService,
}: {
  services: Service[];
  user: User;
  onClose: () => void;
  onConnectService: () => void;
}) {
  const [platform, setPlatform] = useState("docker");
  const [serviceId, setServiceId] = useState(services[0]?.id || "");
  const [copyState, setCopyState] = useState("");
  const apiOrigin = new URL(
    import.meta.env.VITE_API_URL || window.location.origin,
  ).origin;
  const command = `# Run from the INCIDENTCOMMAND repository on the monitored host.\n# Enter the service ingest key when prompted; it stays out of shell history.\nread -r -s -p 'Service ingest key: ' INCIDENT_INGEST_KEY; echo\nexport INCIDENT_INGEST_KEY\nexport INCIDENT_API_URL='${apiOrigin}'\nexport INCIDENT_SERVICE_ID='${serviceId || "YOUR_SERVICE_ID"}'\nexport RUNTIME_PLATFORM='${platform}'\nexport RUNTIME_CLUSTER='${platform === "docker" ? "docker-host-01" : "cluster-01-default"}'\n${platform === "kubernetes" ? "export KUBE_NAMESPACE='default'\n" : ""}npm run collector`;
  return (
    <Dialog title="Connect a runtime collector" onClose={onClose}>
      <div className="command-form runtime-setup">
        <p>
          Run the collector where it can read Docker or Kubernetes. Use a unique
          cluster name for each host or namespace. Use Bash for the commands
          below.
        </p>
        {!services.length ? (
          <>
            <p>First connect a service to receive the runtime signals.</p>
            <button
              className="primary-button compact"
              disabled={!["owner", "admin"].includes(user.role)}
              onClick={() => {
                onClose();
                onConnectService();
              }}
            >
              Connect service
            </button>
          </>
        ) : (
          <>
            <div className="form-grid">
              <label>
                PLATFORM
                <select
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  <option value="docker">Docker</option>
                  <option value="kubernetes">Kubernetes</option>
                </select>
              </label>
              <label>
                SERVICE
                <select
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                >
                  {services.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              {platform === "docker"
                ? "Requires Node.js 22+ and a Docker CLI connected to the monitored daemon."
                : "Requires Node.js 22+ and kubectl with read access to pods and workloads in one namespace. A namespace-scoped deployment is included in deploy/kubernetes."}
            </p>
            <pre>{command}</pre>
            <button
              className="secondary-button"
              disabled={user.role === "viewer"}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command);
                  setCopyState("Setup commands copied");
                } catch {
                  setCopyState(
                    "Copy failed. Select the commands above to copy manually.",
                  );
                }
              }}
            >
              <Copy size={15} /> Copy setup commands
            </button>
            <button
              className="secondary-button"
              disabled={!services.find((s) => s.id === serviceId)?.ingestKey}
              onClick={async () => {
                const key = services.find((s) => s.id === serviceId)?.ingestKey;
                if (!key) return;
                try {
                  await navigator.clipboard.writeText(key);
                  setCopyState("Service key copied. Paste it at the prompt.");
                } catch {
                  setCopyState(
                    "Key copy failed. Retry from a browser with clipboard access.",
                  );
                }
              }}
            >
              <Copy size={15} /> Copy service ingest key
            </button>
            {user.role === "viewer" && (
              <p>
                Ask an administrator or responder to configure the service
                ingest key.
              </p>
            )}
            <small role="status">{copyState}</small>
          </>
        )}
      </div>
    </Dialog>
  );
}
