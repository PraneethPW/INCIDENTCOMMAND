import { MotionToggle } from "./MotionPreferences";
import { TrainedMlPanel } from "./TrainedMl";
import { MlSignal } from "./MlSignal";
import { InfrastructurePanel } from "./Infrastructure";
import { RuntimeWorkspace } from "./RuntimeWorkspace";
import {
  Dialog,
  ServiceControls,
  IncidentCollaboration,
  TeamPanel,
} from "./Operations";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Boxes,
  AlertCircle,
  ArrowLeft,
  BellRing,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Command,
  Copy,
  Globe2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError, subscribe, ingestUrl } from "./api";
import type {
  Analysis,
  AppConfig,
  Incident,
  Infrastructure,
  IncidentStatus,
  LiveEvent,
  Overview,
  Service,
  Severity,
  User,
} from "./types";

const severityLabel: Record<Severity, string> = {
  critical: "SEV 1",
  high: "SEV 2",
  medium: "SEV 3",
  low: "SEV 4",
};
const severityColors: Record<Severity, string> = {
  critical: "#ff5f57",
  high: "#ffad55",
  medium: "#e88543",
  low: "#7b6658",
};
const emptyOverview: Overview = {
  metrics: {
    active: 0,
    critical: 0,
    mttrMinutes: 0,
    servicesTotal: 0,
    servicesHealthy: 0,
    alertVelocity: 0,
    availability: null,
  },
  trends: [],
  severity: [],
  recent: [],
};

function timeAgo(date?: string) {
  if (!date) return "never";
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(date).getTime()) / 60_000),
  );
  if (minutes < 1) return "now";
  if (minutes > 59) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function Logo() {
  return (
    <div className="logo-lockup">
      <span className="logo-mark">
        <Command size={17} />
      </span>
      <span>
        INCIDENT<span>COMMAND</span>
      </span>
    </div>
  );
}

function ProductLoader() {
  return (
    <div className="product-loader">
      <div className="scan-orb">
        <Radar />
      </div>
      <strong>Establishing command link</strong>
      <span>Authenticating operator · loading organization state</span>
    </div>
  );
}

function SetupRequired({
  config,
  onExit,
}: {
  config: AppConfig;
  onExit: () => void;
}) {
  const items = [
    {
      ok: config.databaseConfigured,
      label: "PostgreSQL connection string",
      value: "DATABASE_URL",
    },
    {
      ok: config.databaseReady,
      label: "Database availability",
      value: "Check connection, capacity, and pending schema migrations",
    },
    {
      ok: config.sessionConfigured,
      label: "Secure session signing",
      value: "SESSION_SECRET (32+ characters)",
    },
    {
      ok: config.aiConfigured,
      label: "Live AI analysis",
      value: "OPENROUTER_API_KEY",
      optional: true,
    },
  ];
  return (
    <div className="access-shell">
      <div className="access-art">
        <Logo />
        <div>
          <span className="access-kicker">DEPLOYMENT CHECK</span>
          <h1>Connect the real systems.</h1>
          <p>
            This cockpit will not manufacture operational data. Complete the
            required connections and it will run entirely on your organization’s
            users, services, checks, incidents, and telemetry.
          </p>
        </div>
        <button onClick={onExit}>
          <ArrowLeft /> Return to landing
        </button>
      </div>
      <div className="setup-card">
        <div className="setup-icon">
          <Settings2 />
        </div>
        <span className="access-kicker">BACKEND CONFIGURATION</span>
        <h2>Command center is waiting</h2>
        <p>
          Configure these values in <code>backend/.env</code>, initialize the
          database, then restart the application.
        </p>
        <div className="setup-list">
          {items.map((item) => (
            <div key={item.value} className={item.ok ? "done" : ""}>
              <span>{item.ok ? <Check /> : <AlertCircle />}</span>
              <p>
                <b>
                  {item.label}
                  {item.optional ? " (optional)" : ""}
                </b>
                <code>{item.value}</code>
              </p>
            </div>
          ))}
        </div>
        <div className="setup-command">
          <span>STARTUP</span>
          <code>npm run db:setup --prefix backend{`\n`}npm run dev</code>
        </div>
      </div>
    </div>
  );
}

function AuthScreen({
  onAuth,
  onExit,
}: {
  onAuth: (user: User) => void;
  onExit: () => void;
}) {
  const [mode, setMode] = useState<"register" | "login">("register");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const user =
        mode === "register"
          ? await api.register({
              name: String(form.get("name")),
              organization: String(form.get("organization")),
              email: String(form.get("email")),
              password: String(form.get("password")),
            })
          : await api.login({
              email: String(form.get("email")),
              password: String(form.get("password")),
            });
      onAuth(user);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Authentication failed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="access-shell">
      <div className="access-art">
        <Logo />
        <div>
          <span className="access-kicker">OPERATOR ACCESS</span>
          <h1>
            Your systems.
            <br />
            Your command graph.
          </h1>
          <p>
            Create a private workspace for your team, then connect production
            services through health checks or the telemetry ingest API.
          </p>
          <div className="access-features">
            <span>
              <ShieldCheck /> Organization-isolated data
            </span>
            <span>
              <Activity /> Real-time incident stream
            </span>
            <span>
              <BrainCircuit /> Evidence-grounded AI analysis
            </span>
          </div>
        </div>
        <button onClick={onExit}>
          <ArrowLeft /> Return to landing
        </button>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-tabs">
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => setMode("register")}
          >
            Create workspace
          </button>
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => setMode("login")}
          >
            Sign in
          </button>
        </div>
        <span className="access-kicker">
          {mode === "register" ? "NEW COMMAND WORKSPACE" : "WELCOME BACK"}
        </span>
        <h2>
          {mode === "register"
            ? "Set up your response team."
            : "Resume operations."}
        </h2>
        {mode === "register" && (
          <>
            <label>
              YOUR NAME
              <input
                name="name"
                required
                minLength={2}
                placeholder="Alex Morgan"
              />
            </label>
            <label>
              ORGANIZATION
              <input
                name="organization"
                required
                minLength={2}
                placeholder="Acme Infrastructure"
              />
            </label>
          </>
        )}
        <label>
          WORK EMAIL
          <input
            name="email"
            type="email"
            required
            placeholder="operator@company.com"
          />
        </label>
        <label>
          PASSWORD
          <input
            name="password"
            type="password"
            required
            minLength={mode === "register" ? 8 : 1}
            placeholder="Minimum 8 characters"
          />
        </label>

        {error && (
          <div className="form-error">
            <AlertCircle /> {error}
          </div>
        )}
        <button className="primary-button auth-submit" disabled={busy}>
          {busy ? <RefreshCw className="spin" /> : <KeyRound />}{" "}
          {busy
            ? "Establishing session…"
            : mode === "register"
              ? "Create command workspace"
              : "Enter command center"}
        </button>
        <p className="auth-note">
          Session credentials are stored in a secure, HTTP-only cookie.
        </p>
      </form>
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: typeof Server;
  title: string;
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="product-empty">
      <Icon />
      <strong>{title}</strong>
      <p>{text}</p>
      {action && (
        <button className="primary-button compact" onClick={onAction}>
          <Plus /> {action}
        </button>
      )}
    </div>
  );
}

function IncidentList({
  incidents,
  selected,
  onSelect,
}: {
  incidents: Incident[];
  selected?: Incident | null;
  onSelect: (incident: Incident) => void;
}) {
  if (!incidents.length)
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No incidents recorded"
        text="Incidents created by operators, health monitors, or critical telemetry will appear here in real time."
      />
    );
  return (
    <div className="incident-list">
      {incidents.map((incident) => (
        <button
          key={incident.id}
          className={
            selected?.id === incident.id
              ? "incident-row selected"
              : "incident-row"
          }
          onClick={() => onSelect(incident)}
        >
          <span className={`severity-pip ${incident.severity}`} />
          <div>
            <div className="incident-row-top">
              <b>{incident.code}</b>
              <span className={`status ${incident.status}`}>
                {incident.status}
              </span>
            </div>
            <strong>{incident.title}</strong>
            <small>
              {incident.service} · {incident.region}
            </small>
          </div>
          <div className="incident-time">
            <b>{timeAgo(incident.startedAt)}</b>
            <span>ago</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose}>
      {children}
    </Dialog>
  );
}

function CreateServiceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (service: Service) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      onCreated(
        await api.createService({
          name: form.get("name"),
          description: form.get("description"),
          region: form.get("region"),
          healthUrl: form.get("healthUrl"),
          expectedStatus: Number(form.get("expectedStatus")),
          checkIntervalSeconds: Number(form.get("checkIntervalSeconds")),
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to add service",
      );
      setBusy(false);
    }
  }
  return (
    <Modal title="Connect a production service" onClose={onClose}>
      <form className="command-form" onSubmit={submit}>
        <label>
          SERVICE NAME
          <input name="name" required placeholder="Payments API" />
        </label>
        <label>
          DESCRIPTION
          <textarea
            name="description"
            placeholder="Handles card authorization and settlement"
          />
        </label>
        <div className="form-grid">
          <label>
            REGION
            <input name="region" required defaultValue="global" />
          </label>
          <label>
            CHECK INTERVAL
            <select name="checkIntervalSeconds" defaultValue="60">
              <option value="30">30 seconds</option>
              <option value="60">1 minute</option>
              <option value="300">5 minutes</option>
            </select>
          </label>
        </div>
        <label>
          HEALTH CHECK URL <span>optional</span>
          <input
            name="healthUrl"
            type="url"
            placeholder="https://api.company.com/health"
          />
        </label>
        <label>
          EXPECTED HTTP STATUS
          <input
            name="expectedStatus"
            type="number"
            min="100"
            max="599"
            defaultValue="200"
          />
        </label>
        {error && (
          <div className="form-error">
            <AlertCircle /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button compact" disabled={busy}>
            <Network /> {busy ? "Connecting…" : "Connect service"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateIncidentModal({
  services,
  onClose,
  onCreated,
}: {
  services: Service[];
  onClose: () => void;
  onCreated: (incident: Incident) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const selected = services.find(
      (service) => service.id === form.get("serviceId"),
    );
    try {
      onCreated(
        await api.createIncident({
          title: form.get("title"),
          serviceId: selected?.id || null,
          service:
            selected?.slug || String(form.get("service") || "unassigned"),
          severity: form.get("severity"),
          region: selected?.region || String(form.get("region") || "global"),
          description: form.get("description"),
          impact: form.get("impact"),
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to create incident",
      );
      setBusy(false);
    }
  }
  return (
    <Modal title="Declare an incident" onClose={onClose}>
      <form className="command-form" onSubmit={submit}>
        <label>
          INCIDENT TITLE
          <input
            name="title"
            required
            minLength={4}
            placeholder="Checkout authorization failures"
          />
        </label>
        <div className="form-grid">
          <label>
            SERVICE
            <select name="serviceId" defaultValue="">
              <option value="">Unassigned</option>
              {services.map((service) => (
                <option value={service.id} key={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            SEVERITY
            <select name="severity" defaultValue="high">
              <option value="critical">SEV 1 — Critical</option>
              <option value="high">SEV 2 — High</option>
              <option value="medium">SEV 3 — Medium</option>
              <option value="low">SEV 4 — Low</option>
            </select>
          </label>
        </div>
        <label>
          SERVICE NAME <span>used when unassigned</span>
          <input name="service" placeholder="unknown-service" />
        </label>
        <label>
          REGION
          <input name="region" defaultValue="global" />
        </label>
        <label>
          OBSERVED SYMPTOMS
          <textarea
            name="description"
            required
            minLength={4}
            placeholder="What is failing, and what signals triggered the response?"
          />
        </label>
        <label>
          CUSTOMER IMPACT
          <textarea name="impact" defaultValue="Impact assessment pending." />
        </label>
        {error && (
          <div className="form-error">
            <AlertCircle /> {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button compact" disabled={busy}>
            <TriangleAlert /> {busy ? "Declaring…" : "Declare incident"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AnalysisResult({
  analysis,
  loading,
  aiConfigured,
  canAnalyze,
  onRun,
}: {
  analysis?: Analysis | null;
  loading: boolean;
  aiConfigured: boolean;
  canAnalyze: boolean;
  onRun: () => void;
}) {
  if (loading)
    return (
      <div className="analysis-loader">
        <div className="scan-orb">
          <BrainCircuit />
        </div>
        <strong>Correlating live evidence</strong>
        <span>Reviewing timeline · health checks · telemetry</span>
        <span>Analysis may take up to a minute when the provider is busy.</span>
        <div className="loader-bar">
          <i />
        </div>
      </div>
    );
  if (!aiConfigured && !analysis)
    return (
      <EmptyState
        icon={BrainCircuit}
        title="Connect OpenRouter for live analysis"
        text="Add OPENROUTER_API_KEY to backend/.env. The system will analyze only evidence stored for this incident—no simulated answer is substituted."
      />
    );
  if (!analysis)
    return (
      <div className="analysis-empty">
        <BrainCircuit />
        <strong>Evidence is ready for analysis</strong>
        <span>
          OpenRouter will receive this incident’s actual timeline, health
          checks, and telemetry.
        </span>
        <button
          className="primary-button compact"
          disabled={!canAnalyze}
          onClick={onRun}
        >
          <Sparkles /> Analyze evidence
        </button>
      </div>
    );
  return (
    <div className="analysis-result">
      <div className="analysis-score">
        <div style={{ "--score": `${analysis.confidence}%` } as CSSProperties}>
          <strong>{analysis.confidence}%</strong>
          <span>confidence</span>
        </div>
        <p>
          <small>PROBABLE ROOT CAUSE</small>
          <b>{analysis.probableCause}</b>
        </p>
      </div>
      <p className="analysis-summary">{analysis.summary}</p>
      <div className="evidence-grid">
        <div>
          <h4>EVIDENCE CHAIN</h4>
          {analysis.evidence.map((item, index) => (
            <p key={`${item}-${index}`}>
              <span>{index + 1}</span>
              {item}
            </p>
          ))}
        </div>
        <div>
          <h4>RECOVERY SEQUENCE</h4>
          {analysis.recommendations.map((item, index) => (
            <p key={`${item}-${index}`}>
              <CheckCircle2 />
              {item}
              <small>0{index + 1}</small>
            </p>
          ))}
        </div>
      </div>
      <div className="analysis-meta">
        <Sparkles size={13} />{" "}
        {analysis.stale
          ? "Last persisted analysis"
          : analysis.cached
            ? "Evidence unchanged · persisted analysis"
            : "Live analysis"}{" "}
        via {analysis.model}
        {analysis.createdAt &&
          ` · ${new Date(analysis.createdAt).toLocaleString()}`}
      </div>
    </div>
  );
}

type View =
  | "overview"
  | "incidents"
  | "intelligence"
  | "services"
  | "team"
  | "infrastructure";

function CommandCenter({
  user,
  config,
  onLogout,
  onWorkspaceChanged,
}: {
  user: User;
  config: AppConfig;
  onLogout: () => void;
  onWorkspaceChanged: () => void;
}) {
  const [view, setView] = useState<View>("overview");
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentScope, setIncidentScope] = useState("live");
  const [services, setServices] = useState<Service[]>([]);
  const [infrastructure, setInfrastructure] = useState<Infrastructure>({
    sources: [],
    resources: [],
  });
  const [selected, setSelected] = useState<Incident | null>(null);
  const [activity, setActivity] = useState<LiveEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [modal, setModal] = useState<"service" | "incident" | null>(null);
  const [toast, setToast] = useState("");
  const refreshVersion = useRef(0);
  const selectedId = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [showActivity, setShowActivity] = useState(false);
  const [checking, setChecking] = useState<string[]>([]);
  const [statusBusy, setStatusBusy] = useState(false);
  const operatorControlsReady = Boolean(config.capabilities?.operatorControls);
  const runtimeTrackingReady = Boolean(config.capabilities?.runtimeTracking);
  const canWrite = user.role !== "viewer";
  const canManage = ["owner", "admin"].includes(user.role);
  const filteredIncidents = incidents.filter(
    (item) =>
      (statusFilter === "all" ||
        (statusFilter === "active"
          ? item.status !== "resolved"
          : item.status === statusFilter)) &&
      (severityFilter === "all" || item.severity === severityFilter) &&
      `${item.code} ${item.title} ${item.service}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const [nextOverview, nextIncidents, nextServices, nextInfrastructure] =
        await Promise.all([
          api.overview(),
          api.incidents(incidentScope),
          api.services(),
          runtimeTrackingReady
            ? api.infrastructure()
            : Promise.resolve({ sources: [], resources: [] }),
        ]);
      if (version !== refreshVersion.current) return;
      setOverview(nextOverview);
      setIncidents(nextIncidents);
      setServices(nextServices);
      setInfrastructure(nextInfrastructure);
      setError("");
      const id = selectedId.current || nextIncidents[0]?.id;
      if (id) {
        const detail = await api.incident(id);
        if (
          version === refreshVersion.current &&
          (!selectedId.current || selectedId.current === id)
        ) {
          selectedId.current = id;
          setSelected(detail);
        }
      } else {
        setSelected(null);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onWorkspaceChanged();
        return;
      }
      if (version === refreshVersion.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to load organization data",
        );
    } finally {
      if (version === refreshVersion.current) setLoading(false);
    }
  }, [onWorkspaceChanged, runtimeTrackingReady, incidentScope]);
  // oxlint-disable-next-line react/set-state-in-effect -- initial state comes from authenticated API resources.
  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);
  // Synchronize the screen with external events and reconnect snapshots.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnect = subscribe((event) => {
      setActivity((items) => [event, ...items].slice(0, 40));
      if (event.type === "team.updated") {
        onWorkspaceChanged();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(
        () => void refresh(),
        event.type === "connected" ? 0 : 350,
      );
    }, setConnected);
    const fallback = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 60_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      disconnect();
      clearTimeout(timer);
      clearInterval(fallback);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, onWorkspaceChanged]);

  async function selectIncident(
    incident: Incident,
    target: View = "incidents",
  ) {
    setView(target);
    if (selectedId.current !== incident.id) setAnalysisError("");
    selectedId.current = incident.id;
    setSelected(incident);
    try {
      const detail = await api.incident(incident.id);
      if (selectedId.current === incident.id) setSelected(detail);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to load incident",
      );
    }
  }
  async function openIntelligence() {
    setView("intelligence");
    const target = selected || incidents[0];
    if (!target) return;
    await selectIncident(target, "intelligence");
  }
  async function changeStatus(status: IncidentStatus) {
    if (!selected || statusBusy) return;
    setStatusBusy(true);
    try {
      await api.updateStatus(selected.id, status);
      setToast(`Incident moved to ${status}`);
      setTimeout(() => setToast(""), 2200);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Status update failed");
    } finally {
      setStatusBusy(false);
    }
  }
  async function runAnalysis() {
    if (!selected || analysisLoading || !canWrite) return;
    const incidentId = selected.id;
    setAnalysisLoading(true);
    setAnalysisError("");
    setView("intelligence");
    setError("");
    try {
      const result = await api.analyze(incidentId);
      if (result.stale && selectedId.current === incidentId)
        setAnalysisError(
          result.warning ||
            "The AI provider is unavailable. Showing the last saved analysis; newer evidence has not been analyzed.",
        );
      setSelected((current) =>
        current?.id === incidentId ? { ...current, analysis: result } : current,
      );
      setToast(
        result.stale
          ? "Live provider unavailable · showing persisted analysis"
          : result.cached
            ? "Evidence unchanged · persisted analysis restored"
            : "Evidence analysis completed and persisted",
      );
      setTimeout(() => setToast(""), 3200);
    } catch (cause) {
      const message =
        cause instanceof ApiError && cause.setup
          ? `${cause.message}. ${cause.setup}`
          : cause instanceof Error
            ? cause.message
            : "Analysis failed";
      if (selectedId.current === incidentId) setAnalysisError(message);
    } finally {
      setAnalysisLoading(false);
    }
  }
  function serviceCreated(service: Service) {
    setServices((items) => [...items, service]);
    setModal(null);
    setView("services");
    setToast(`${service.name} connected`);
    setTimeout(() => setToast(""), 2200);
    void refresh();
  }
  function incidentCreated(incident: Incident) {
    setIncidents((items) => [incident, ...items]);
    selectedId.current = incident.id;
    setSelected(incident);
    setModal(null);
    setView("incidents");
    setToast(`${incident.code} declared`);
    setTimeout(() => setToast(""), 2200);
    void refresh();
  }
  async function checkNow(service: Service) {
    if (checking.includes(service.id)) return;
    setChecking((items) => [...items, service.id]);
    try {
      await api.checkService(service.id);
      setToast(`Health check completed for ${service.name}`);
      setTimeout(() => setToast(""), 2200);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Health check failed");
    } finally {
      setChecking((items) => items.filter((id) => id !== service.id));
    }
  }
  async function copyIngest(service: Service) {
    const sample = `curl -X POST ${ingestUrl(service.id)} -H "Content-Type: application/json" -H "x-ingest-key: ${service.ingestKey}" -d '{"eventType":"error-rate","severity":"critical","message":"Error rate exceeded production threshold","errorRate":12.8}'`;
    try {
      await navigator.clipboard.writeText(sample);
    } catch {
      setError(
        "Clipboard unavailable. Use a secure browser connection and allow clipboard access.",
      );
      return;
    }
    setToast("Telemetry ingest command copied");
    setTimeout(() => setToast(""), 2200);
  }

  const severityData = useMemo(
    () =>
      (["critical", "high", "medium", "low"] as Severity[]).map((name) => ({
        name,
        value: overview.severity.find((item) => item.name === name)?.value || 0,
        color: severityColors[name],
      })),
    [overview.severity],
  );
  if (loading) return <ProductLoader />;

  return (
    <div className="dashboard-shell">
      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            className="toast"
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -30, opacity: 0 }}
          >
            <CheckCircle2 /> {toast}
          </motion.div>
        )}
        {modal === "service" && (
          <CreateServiceModal
            onClose={() => setModal(null)}
            onCreated={serviceCreated}
          />
        )}
        {modal === "incident" && (
          <CreateIncidentModal
            services={services}
            onClose={() => setModal(null)}
            onCreated={incidentCreated}
          />
        )}
      </AnimatePresence>
      <aside className="sidebar">
        <Logo />
        <div className="org-chip">
          <span>{user.organizationName.slice(0, 2).toUpperCase()}</span>
          <div>
            <b>{user.organizationName}</b>
            <small>{user.role} workspace</small>
          </div>
        </div>
        <div className="sidebar-label">COMMAND</div>
        <nav>
          <button
            className={view === "overview" ? "active" : ""}
            onClick={() => setView("overview")}
          >
            <LayoutDashboard /> Overview
          </button>
          <button
            className={view === "incidents" ? "active" : ""}
            onClick={() => setView("incidents")}
          >
            <TriangleAlert /> Incidents{" "}
            {overview.metrics.active > 0 && (
              <span>{overview.metrics.active}</span>
            )}
          </button>
          <button
            className={view === "intelligence" ? "active" : ""}
            onClick={() => void openIntelligence()}
          >
            <BrainCircuit /> Intelligence
          </button>
          <button
            className={view === "services" ? "active" : ""}
            onClick={() => setView("services")}
          >
            <Network /> Services
          </button>
          {config.capabilities?.runtimeTracking && (
            <button
              className={view === "infrastructure" ? "active" : ""}
              onClick={() => setView("infrastructure")}
            >
              <Boxes /> Infrastructure
            </button>
          )}
          {operatorControlsReady && (
            <>
              <button
                className={view === "team" ? "active" : ""}
                onClick={() => setView("team")}
              >
                <ShieldCheck /> Team & access
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-label">LIVE LINK</div>
        <div className="system-health">
          <span>
            <i className={connected ? "" : "red"} />{" "}
            {connected ? "Realtime stream connected" : "Stream reconnecting"}
          </span>
          <span>
            <i className={config.aiConfigured ? "" : "amber"} />{" "}
            {config.aiConfigured ? config.model : "AI key not configured"}
          </span>
          <span>
            <i /> {config.databaseProvider || "PostgreSQL"} persistence active
          </span>
        </div>
        <MotionToggle />
        <button className="return-button logout" onClick={onLogout}>
          <LogOut /> Sign out
        </button>
      </aside>
      <motion.main
        id="main-content"
        tabIndex={-1}
        className="dashboard-main"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
      >
        <header className="command-bar">
          <div>
            <div className="eyebrow">
              <span className={connected ? "live-dot" : "live-dot offline"} />{" "}
              {connected
                ? "LIVE ORGANIZATION STREAM"
                : "RECONNECTING LIVE STREAM"}
            </div>
            <h1>
              {view === "overview"
                ? "Operational overview"
                : view === "incidents"
                  ? "Incident operations"
                  : view === "intelligence"
                    ? "Root-cause intelligence"
                    : view === "infrastructure"
                      ? "Container & cluster operations"
                      : view === "team"
                        ? "Team & workspace access"
                        : "Service command graph"}
            </h1>
          </div>
          <div className="command-actions">
            <button
              aria-label="Search incidents"
              onClick={() => {
                setView("incidents");
                setStatusFilter("all");
                setTimeout(
                  () => document.getElementById("incident-search")?.focus(),
                  0,
                );
              }}
            >
              <Search />
            </button>
            <button
              aria-label="Live activity"
              aria-expanded={showActivity}
              onClick={() => setShowActivity(!showActivity)}
            >
              <BellRing />
              {activity.length > 0 && <span />}
            </button>
            <div className="operator">
              <i>
                {user.name
                  .split(" ")
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase()}
              </i>
              <div>
                <b>{user.name}</b>
                <span>{user.email}</span>
              </div>
            </div>
          </div>
        </header>
        {!operatorControlsReady && (
          <div className="deployment-notice" role="status">
            The backend update is pending. Monitoring and existing incident
            operations are available. Refresh after the backend release to use
            team access and the new service controls.
          </div>
        )}
        {operatorControlsReady && view === "team" && (
          <TeamPanel user={user} onWorkspaceChanged={onWorkspaceChanged} />
        )}
        {view === "infrastructure" && config.capabilities?.runtimeWorkspace && (
          <RuntimeWorkspace
            data={infrastructure}
            services={services}
            user={user}
            onRefresh={refresh}
            onOpenIncident={async (id) => {
              try {
                const detail = await api.incident(id);
                setIncidentScope(detail.isTest ? "test" : "live");
                await selectIncident(detail);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Unable to load incident",
                );
              }
            }}
          />
        )}
        {view === "infrastructure" &&
          !config.capabilities?.runtimeWorkspace && (
            <InfrastructurePanel
              data={infrastructure}
              services={services}
              user={user}
              onConnectService={() => setModal("service")}
              onOpenIncident={async (id) => {
                try {
                  await selectIncident(await api.incident(id));
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Unable to load incident",
                  );
                }
              }}
            />
          )}
        {showActivity && (
          <Dialog
            title="Workspace activity"
            onClose={() => setShowActivity(false)}
          >
            <div className="signal-history">
              {activity.length ? (
                activity.map((item, i) => (
                  <div key={i}>
                    <b>{item.message}</b>
                    <small>{new Date(item.at).toLocaleString()}</small>
                  </div>
                ))
              ) : (
                <p>No activity received in this session yet.</p>
              )}
            </div>
          </Dialog>
        )}
        {error && (
          <div className="dashboard-error" role="alert">
            <AlertCircle />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X />
            </button>
          </div>
        )}
        {view === "overview" && (
          <>
            <div className="live-strip">
              <span>
                <Activity /> LIVE SIGNAL
              </span>
              <p>
                {activity[0]?.message ||
                  "Connected. Waiting for service checks, telemetry, or operator actions."}
              </p>
              <small>{activity[0] ? timeAgo(activity[0].at) : "now"}</small>
            </div>
            {services.length === 0 && (
              <div className="onboarding-banner">
                <div>
                  <span>01 / CONNECT YOUR FIRST SERVICE</span>
                  <h2>Give the command graph a real signal.</h2>
                  <p>
                    Add a health endpoint for active polling, then copy the
                    generated ingest command into your application or monitoring
                    pipeline.
                  </p>
                </div>
                <button
                  className="primary-button"
                  disabled={!canManage}
                  onClick={() => setModal("service")}
                >
                  <Plus /> Connect production service
                </button>
              </div>
            )}
            <section className="metrics-grid">
              <div className="metric-card tone-red">
                <div className="metric-head">
                  <span>ACTIVE INCIDENTS</span>
                  <TriangleAlert />
                </div>
                <strong>
                  {String(overview.metrics.active).padStart(2, "0")}
                </strong>
                <small>{overview.metrics.critical} critical</small>
                <div className="metric-scan" />
              </div>
              <div className="metric-card">
                <div className="metric-head">
                  <span>MEAN TIME TO RECOVER</span>
                  <Clock3 />
                </div>
                <strong>{overview.metrics.mttrMinutes}m</strong>
                <small>Resolved incidents · 30 days</small>
                <div className="metric-scan" />
              </div>
              <div className="metric-card tone-green">
                <div className="metric-head">
                  <span>CHECK AVAILABILITY</span>
                  <ShieldCheck />
                </div>
                <strong>
                  {overview.metrics.availability === null
                    ? "—"
                    : `${overview.metrics.availability}%`}
                </strong>
                <small>
                  {overview.metrics.servicesHealthy} /{" "}
                  {overview.metrics.servicesTotal} services healthy
                </small>
                <div className="metric-scan" />
              </div>
              <div className="metric-card tone-amber">
                <div className="metric-head">
                  <span>INCIDENT VELOCITY</span>
                  <Activity />
                </div>
                <strong>{overview.metrics.alertVelocity}/h</strong>
                <small>Created in the last hour</small>
                <div className="metric-scan" />
              </div>
            </section>
            <section className="dashboard-grid">
              <article className="panel trend-panel">
                <div className="panel-head">
                  <div>
                    <small>INCIDENT PRESSURE</small>
                    <h2>Last 24 hours</h2>
                  </div>
                  <span className="data-source">SUPABASE · LIVE</span>
                </div>
                {overview.trends.length ? (
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={overview.trends}>
                        <defs>
                          <linearGradient
                            id="liveArea"
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop
                              offset="0"
                              stopColor="#eb8846"
                              stopOpacity={0.34}
                            />
                            <stop
                              offset="1"
                              stopColor="#eb8846"
                              stopOpacity={0}
                            />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          stroke="#3c3530"
                          strokeDasharray="3 5"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="time"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "#928880", fontSize: 11 }}
                        />
                        <YAxis
                          allowDecimals={false}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "#928880", fontSize: 11 }}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#191614",
                            border: "1px solid #4e3220",
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="incidents"
                          stroke="#eb8846"
                          strokeWidth={2}
                          fill="url(#liveArea)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState
                    icon={Activity}
                    title="No trend data yet"
                    text="The chart will populate as real incidents enter this workspace."
                  />
                )}
              </article>
              <article className="panel severity-panel">
                <div className="panel-head">
                  <div>
                    <small>ACTIVE SEVERITY</small>
                    <h2>Current load</h2>
                  </div>
                </div>
                <div className="donut-wrap">
                  <ResponsiveContainer width="100%" height={190}>
                    <PieChart>
                      <Pie
                        data={severityData}
                        innerRadius={55}
                        outerRadius={78}
                        dataKey="value"
                        paddingAngle={overview.metrics.active ? 4 : 0}
                        stroke="none"
                      >
                        {severityData.map((item) => (
                          <Cell
                            key={item.name}
                            fill={item.value ? item.color : "#36302c"}
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="donut-center">
                    <strong>{overview.metrics.active}</strong>
                    <span>active</span>
                  </div>
                </div>
                <div className="severity-legend">
                  {severityData.map((item) => (
                    <span key={item.name}>
                      <i style={{ background: item.color }} />
                      {item.name}
                      <b>{item.value}</b>
                    </span>
                  ))}
                </div>
              </article>
            </section>
            <section className="panel active-panel">
              <div className="panel-head">
                <div>
                  <small>RECENT OPERATIONS</small>
                  <h2>Incident queue</h2>
                </div>
                <button onClick={() => setView("incidents")}>
                  View all <ChevronRight />
                </button>
              </div>
              <IncidentList
                incidents={overview.recent}
                selected={selected}
                onSelect={(incident) => void selectIncident(incident)}
              />
            </section>
          </>
        )}

        {view === "incidents" && (
          <section className="incident-workspace">
            <article className="panel incident-browser">
              <div className="panel-head">
                <div>
                  <small>ORGANIZATION QUEUE</small>
                  <h2>{incidents.length} incidents</h2>
                </div>
                <button
                  disabled={!canWrite}
                  onClick={() => setModal("incident")}
                >
                  <CircleDot /> Declare incident
                </button>
              </div>
              <div className="queue-filters">
                <label className="search-field">
                  <Search size={16} />
                  <input
                    id="incident-search"
                    aria-label="Search incidents"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search title, code, service…"
                  />
                </label>
                <div>
                  {config.capabilities?.runtimeWorkspace && (
                    <select
                      aria-label="Incident data scope"
                      value={incidentScope}
                      onChange={(e) => {
                        setIncidentScope(e.target.value);
                        selectedId.current = null;
                        setSelected(null);
                      }}
                    >
                      <option value="live">Live incidents</option>
                      <option value="test">Test lab incidents</option>
                      <option value="all">Live + test incidents</option>
                    </select>
                  )}
                  <select
                    aria-label="Filter by status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="active">Active incidents</option>
                    <option value="all">All statuses</option>
                    <option value="investigating">Investigating</option>
                    <option value="identified">Identified</option>
                    <option value="monitoring">Monitoring</option>
                    <option value="resolved">Resolved</option>
                  </select>
                  <select
                    aria-label="Filter by severity"
                    value={severityFilter}
                    onChange={(e) => setSeverityFilter(e.target.value)}
                  >
                    <option value="all">All severities</option>
                    <option value="critical">SEV 1 · Critical</option>
                    <option value="high">SEV 2 · High</option>
                    <option value="medium">SEV 3 · Medium</option>
                    <option value="low">SEV 4 · Low</option>
                  </select>
                </div>
                <small>
                  {filteredIncidents.length} matching incidents · latest 100
                  records
                </small>
              </div>
              <IncidentList
                incidents={filteredIncidents}
                selected={selected}
                onSelect={(incident) => void selectIncident(incident)}
              />
            </article>
            <article className="panel incident-detail">
              {selected ? (
                <>
                  <div className="detail-header">
                    <div>
                      <span className={`severity-badge ${selected.severity}`}>
                        {severityLabel[selected.severity]}
                      </span>
                      <span className={`status ${selected.status}`}>
                        {selected.status}
                      </span>
                      <small>
                        {selected.code} · {timeAgo(selected.startedAt)}
                      </small>
                    </div>
                    {selected.isTest && (
                      <p className="runtime-lab-notice">
                        TEST LAB · Controlled simulation. No live infrastructure
                        was changed.
                      </p>
                    )}
                    <h2>{selected.title}</h2>
                    {selected.mlEvidence && (
                      <div className="ml-incident-evidence">
                        <MlSignal value={selected.mlEvidence} />
                        <p>
                          Model {selected.mlEvidence.modelVersion} · score{" "}
                          {selected.mlEvidence.score?.toFixed(3)} / threshold{" "}
                          {selected.mlEvidence.threshold.toFixed(3)} · response{" "}
                          {selected.mlEvidence.latencyMs} ms.
                        </p>
                      </div>
                    )}
                    <p>{selected.description}</p>
                  </div>
                  <div className="detail-metrics">
                    <div>
                      <span>REPORTED LATENCY</span>
                      <strong>
                        {selected.runtimeResourceId
                          ? "—"
                          : (selected.latencyMs ?? "—")}
                        {!selected.runtimeResourceId && selected.latencyMs
                          ? " ms"
                          : ""}
                      </strong>
                    </div>
                    <div>
                      <span>ERROR RATE</span>
                      <strong>
                        {selected.runtimeResourceId
                          ? "—"
                          : (selected.errorRate ?? "—")}
                        {selected.errorRate ? "%" : ""}
                      </strong>
                    </div>
                    <div>
                      <span>REGION</span>
                      <strong>{selected.region}</strong>
                    </div>
                    <div>
                      <span>SOURCE</span>
                      <strong>{selected.source}</strong>
                    </div>
                  </div>
                  <div className="impact-box">
                    <TriangleAlert />
                    <div>
                      <span>CUSTOMER IMPACT</span>
                      <p>{selected.impact}</p>
                    </div>
                  </div>
                  <div className="detail-actions">
                    <select
                      aria-label="Incident status"
                      disabled={!canWrite || statusBusy}
                      value={selected.status}
                      onChange={(event) =>
                        void changeStatus(event.target.value as IncidentStatus)
                      }
                    >
                      <option value="investigating">Investigating</option>
                      <option value="identified">Cause identified</option>
                      <option value="monitoring">Monitoring</option>
                      <option value="resolved">Resolved</option>
                    </select>
                    <button
                      className="primary-button compact"
                      disabled={
                        !canWrite || analysisLoading || !config.aiConfigured
                      }
                      onClick={() => void runAnalysis()}
                    >
                      <BrainCircuit /> Analyze evidence
                    </button>
                  </div>
                  {operatorControlsReady && (
                    <IncidentCollaboration
                      key={selected.id}
                      incident={selected}
                      user={user}
                      onUpdated={() => void refresh()}
                    />
                  )}
                  <div className="timeline">
                    <h3>OPERATION TIMELINE</h3>
                    {selected.events?.length ? (
                      selected.events.map((event) => (
                        <div key={event.id}>
                          <i
                            className={
                              event.eventType === "detected" ? "critical" : ""
                            }
                          />
                          <p>
                            <b>{event.message}</b>
                            <span>
                              {event.actorName || "Automation"} ·{" "}
                              {new Date(event.createdAt).toLocaleString()}
                            </span>
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="timeline-empty">
                        Open the incident to load its persisted timeline.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={TriangleAlert}
                  title="Select or declare an incident"
                  text="The incident command surface will show its current signals, impact, ownership, and immutable event timeline."
                  action="Declare incident"
                  onAction={() => setModal("incident")}
                />
              )}
            </article>
          </section>
        )}

        {view === "intelligence" && (
          <section className="intelligence-layout">
            {config.capabilities?.trainedMl && (
              <TrainedMlPanel
                services={services}
                user={user}
                onRefresh={refresh}
              />
            )}
            <article className="panel intelligence-context">
              {selected ? (
                <>
                  <label className="field intelligence-picker">
                    <span>INCIDENT TO ANALYZE</span>
                    <select
                      aria-label="Incident to analyze"
                      value={selected.id}
                      disabled={analysisLoading}
                      onChange={(event) => {
                        const target = incidents.find(
                          (item) => item.id === event.target.value,
                        );
                        if (target) void selectIncident(target, "intelligence");
                      }}
                    >
                      {(incidents.some((i) => i.id === selected.id)
                        ? incidents
                        : [selected, ...incidents]
                      ).map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.code} · {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="panel-head">
                    <div>
                      <small>ANALYSIS TARGET</small>
                      <h2>{selected.code}</h2>
                    </div>
                    <span className={`severity-badge ${selected.severity}`}>
                      {severityLabel[selected.severity]}
                    </span>
                  </div>
                  {selected.isTest && (
                    <p className="runtime-lab-notice">
                      TEST LAB · Analysis uses simulated observations.
                    </p>
                  )}
                  <h3>{selected.title}</h3>
                  <p>{selected.description}</p>
                  <div className="context-source">
                    <Code2 />
                    <div>
                      <b>Evidence boundary</b>
                      <span>
                        Incident timeline, recent service checks, runtime
                        observations, and telemetry for {selected.service}.
                      </span>
                    </div>
                  </div>
                  <button
                    className="primary-button"
                    disabled={
                      !canWrite || analysisLoading || !config.aiConfigured
                    }
                    onClick={() => void runAnalysis()}
                  >
                    <BrainCircuit />{" "}
                    {analysisLoading
                      ? "Analyzing evidence…"
                      : "Run live analysis"}
                  </button>
                </>
              ) : (
                <EmptyState
                  icon={BrainCircuit}
                  title="No incidents to analyze yet"
                  text="Intelligence investigates recorded incidents. A service or container failure creates one automatically, or you can declare an incident with the symptoms you observed."
                  action={canWrite ? "Declare incident" : "View incidents"}
                  onAction={() =>
                    canWrite ? setModal("incident") : setView("incidents")
                  }
                />
              )}
            </article>
            <article className="panel analysis-panel">
              {analysisError && (
                <div className="analysis-warning" role="alert">
                  <AlertCircle /> <span>{analysisError}</span>
                </div>
              )}
              {selected ? (
                <AnalysisResult
                  analysis={
                    analysisError && selected.analysis
                      ? { ...selected.analysis, stale: true }
                      : selected.analysis
                  }
                  loading={analysisLoading}
                  aiConfigured={config.aiConfigured}
                  canAnalyze={canWrite}
                  onRun={() => void runAnalysis()}
                />
              ) : (
                <EmptyState
                  icon={BrainCircuit}
                  title="Waiting for an incident"
                  text="Once an incident is recorded, choose it here and run an analysis of its actual timeline, health checks, telemetry, and runtime observations."
                />
              )}
            </article>
          </section>
        )}

        {view === "services" && (
          <section className="services-layout">
            <div className="services-toolbar">
              <div>
                <span>PRODUCTION TOPOLOGY</span>
                <h2>{services.length} connected services</h2>
              </div>
              <button
                className="primary-button compact"
                disabled={!canManage}
                onClick={() => setModal("service")}
              >
                <Plus /> Connect service
              </button>
            </div>
            {services.length === 0 ? (
              <article className="panel service-empty">
                <EmptyState
                  icon={Server}
                  title="No services connected"
                  text="Connect a health endpoint or telemetry source. Real checks and ingest events will become the source of truth for this dashboard."
                  action="Connect first service"
                  onAction={() => setModal("service")}
                />
              </article>
            ) : (
              <div className="service-grid">
                {services.map((service) => (
                  <article className="service-card" key={service.id}>
                    <div className="service-card-head">
                      <span
                        className={`service-state ${service.currentStatus}`}
                      >
                        <i /> {service.currentStatus}
                      </span>
                      <Globe2 />
                    </div>
                    <h3>{service.name}</h3>
                    <code>{service.slug}</code>
                    <p>{service.description || "No description provided."}</p>
                    <div className="service-facts">
                      <span>
                        <b>REGION</b>
                        {service.region}
                      </span>
                      <span>
                        <b>LAST CHECK</b>
                        {timeAgo(service.lastCheckedAt)}
                      </span>
                      <span>
                        <b>INTERVAL</b>
                        {service.checkIntervalSeconds}s
                      </span>
                    </div>
                    {config.capabilities?.trainedMl && (
                      <MlSignal value={service.ml} />
                    )}
                    <div className="service-url">
                      <span>HEALTH ENDPOINT</span>
                      <code>
                        {service.healthUrl || "Telemetry ingest only"}
                      </code>
                    </div>
                    <div className="service-actions">
                      <button
                        disabled={
                          !canWrite ||
                          !service.healthUrl ||
                          checking.includes(service.id)
                        }
                        onClick={() => void checkNow(service)}
                      >
                        <RefreshCw
                          className={
                            checking.includes(service.id) ? "spin" : ""
                          }
                        />{" "}
                        {checking.includes(service.id)
                          ? "Checking…"
                          : "Check now"}
                      </button>
                      <button
                        disabled={!service.ingestKey}
                        onClick={() => void copyIngest(service)}
                      >
                        <Copy /> Copy ingest command
                      </button>
                    </div>
                    {operatorControlsReady && (
                      <ServiceControls
                        service={service}
                        user={user}
                        onUpdated={() => void refresh()}
                      />
                    )}
                  </article>
                ))}
              </div>
            )}
            <article className="ingest-guide">
              <div>
                <Zap />
                <span>REAL-TIME INGEST</span>
                <h3>Send production signals directly.</h3>
                <p>
                  Each service gets a unique ingest key. Critical telemetry
                  automatically declares an incident and broadcasts it to every
                  connected operator.
                </p>
              </div>
              <div className="ingest-flow">
                <span>YOUR APP</span>
                <ChevronRight />
                <span>INGEST API</span>
                <ChevronRight />
                <span>SUPABASE</span>
                <ChevronRight />
                <span>LIVE SSE</span>
              </div>
            </article>
          </section>
        )}
      </motion.main>
    </div>
  );
}

export default function ProductApp({ onExit }: { onExit: () => void }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  // Authentication bootstrap is intentionally synchronized with server state.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError("");
      try {
        const next = await api.config();
        if (!active) return;
        setConfig(next);
        if (next.databaseReady && next.sessionConfigured) {
          try {
            const session = await api.me();
            if (active) setUser(session);
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
              if (active) setUser(null);
            } else throw e;
          }
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "Connection failed");
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);
  async function logout() {
    try {
      await api.logout();
      setUser(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign out failed");
    }
  }
  if (loading) return <ProductLoader />;
  if (error || !config)
    return (
      <div className="product-loader">
        <AlertCircle />
        <h2>Command link interrupted</h2>
        <p role="alert">{error || "The server did not respond."}</p>
        <button className="primary-button" onClick={reload}>
          Retry connection
        </button>
        <button onClick={onExit}>Return to landing</button>
      </div>
    );
  if (!config.databaseReady || !config.sessionConfigured)
    return (
      <>
        <SetupRequired config={config} onExit={onExit} />
        <button className="retry-setup primary-button" onClick={reload}>
          Retry connection
        </button>
      </>
    );
  if (!user) return <AuthScreen onAuth={setUser} onExit={onExit} />;
  return (
    <CommandCenter
      key={user.organizationId + user.role}
      user={user}
      config={config}
      onWorkspaceChanged={reload}
      onLogout={() => void logout()}
    />
  );
}
