import {
  AnimatePresence,
  motion,
  useScroll,
  useTransform,
} from "framer-motion";
import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  Command,
  Menu,
  Network,
  Play,
  Radar,
  X,
  Zap,
} from "lucide-react";
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from "react";
const ProductApp = lazy(() => import("./ProductApp"));
const OrbitalScene = lazy(() => import("./OrbitalScene"));
class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="orbital-fallback" />
    ) : (
      this.props.children
    );
  }
}
import "./index.css";

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

function Landing({ onEnter }: { onEnter: () => void }) {
  const { scrollYProgress } = useScroll();
  const heroY = useTransform(scrollYProgress, [0, 0.35], [0, 180]);
  const heroOpacity = useTransform(scrollYProgress, [0, 0.3], [1, 0.12]);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="landing-shell">
      <motion.div
        className="scroll-progress"
        style={{ scaleX: scrollYProgress }}
      />
      <header className="landing-nav">
        <Logo />
        <nav className={menuOpen ? "nav-links open" : "nav-links"}>
          <a href="#capabilities">Capabilities</a>
          <a href="#system">System</a>
          <a href="#workflow">Workflow</a>
        </nav>
        <button className="nav-cta" onClick={onEnter}>
          Open cockpit <ArrowRight />
        </button>
        <button
          className="mobile-menu"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle navigation"
        >
          {menuOpen ? <X /> : <Menu />}
        </button>
      </header>
      <section className="hero">
        <motion.div
          className="hero-bg"
          style={{ y: heroY, opacity: heroOpacity }}
        />
        <div className="hero-grid" />
        <motion.div
          className="hero-copy"
          initial={{ opacity: 0, y: 36 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="eyebrow">
            <span className="live-dot" /> Real-time incident operations
          </div>
          <h1>
            See the failure.
            <br />
            <span>Command the recovery.</span>
          </h1>
          <p>
            Connect production services, detect real failures, coordinate
            responders, and turn live evidence into safe recovery decisions.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={onEnter}>
              <Play fill="currentColor" /> Enter command center
            </button>
            <a className="ghost-button" href="#workflow">
              See the operating loop <ArrowRight />
            </a>
          </div>
          <div className="hero-stats">
            <div>
              <strong>LIVE</strong>
              <span>organization stream</span>
            </div>
            <div>
              <strong>30s</strong>
              <span>health checks</span>
            </div>
            <div>
              <strong>0</strong>
              <span>invented signals</span>
            </div>
          </div>
        </motion.div>
        <div className="hero-radar">
          <SceneBoundary>
            <Suspense fallback={<div className="orbital-fallback" />}>
              <OrbitalScene />
            </Suspense>
          </SceneBoundary>
          <div className="radar-chip radar-chip-a">
            <span /> authenticated <b>operators</b>
          </div>
          <div className="radar-chip radar-chip-b">
            <span /> service checks <b>live</b>
          </div>
          <div className="radar-chip radar-chip-c">
            <span /> telemetry <b>ingest</b>
          </div>
        </div>
        <div className="scroll-cue">
          <span>SCROLL TO EXPLORE</span>
          <i />
        </div>
      </section>
      <section id="capabilities" className="narrative-section">
        <div className="section-kicker">THE REAL OPERATIONS LAYER</div>
        <div className="section-heading">
          <h2>
            Every surface is connected
            <br />
            to production truth.
          </h2>
          <p>
            No canned alerts. No random graphs. Your organization starts empty
            and becomes alive only through user actions, health checks, and
            authenticated telemetry.
          </p>
        </div>
        <div className="capability-grid">
          {[
            [
              Radar,
              "Detect",
              "Scheduled health probes and keyed telemetry ingest declare real incidents when production crosses the line.",
              "Source-backed detection",
            ],
            [
              BrainCircuit,
              "Diagnose",
              "AI receives the actual incident timeline, health checks, and telemetry—with uncertainty preserved.",
              "Evidence-bound analysis",
            ],
            [
              Zap,
              "Resolve",
              "Every status transition becomes a persistent timeline event and broadcasts to connected operators.",
              "Realtime coordination",
            ],
          ].map(([Icon, title, text, metric], index) => {
            const C = Icon as typeof Radar;
            return (
              <motion.article
                className="capability-card"
                key={String(title)}
                initial={{ opacity: 0, y: 40 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.12 }}
              >
                <div className="card-index">0{index + 1}</div>
                <C />
                <h3>{String(title)}</h3>
                <p>{String(text)}</p>
                <span>
                  {String(metric)} <ChevronRight />
                </span>
              </motion.article>
            );
          })}
        </div>
      </section>
      <section id="system" className="system-section">
        <div className="system-visual">
          <div className="system-orbit orbit-one" />
          <div className="system-orbit orbit-two" />
          <div className="system-core">
            <Network />
            <span>
              COMMAND
              <br />
              GRAPH
            </span>
          </div>
          {[
            "Health",
            "Telemetry",
            "Users",
            "Incidents",
            "Neon",
            "OpenRouter",
          ].map((item, index) => (
            <span className={`system-node node-${index + 1}`} key={item}>
              {item}
            </span>
          ))}
        </div>
        <div className="system-copy">
          <div className="section-kicker">
            ONE ORGANIZATION, ONE SOURCE OF TRUTH
          </div>
          <h2>Context follows every incident.</h2>
          <p>
            Services, responders, events, checks, telemetry, and analyses are
            isolated to the signed-in organization and persist in Neon.
          </p>
          <ul>
            <li>
              <CheckCircle2 /> Secure HTTP-only user sessions
            </li>
            <li>
              <CheckCircle2 /> Organization-scoped queries and broadcasts
            </li>
            <li>
              <CheckCircle2 /> Automatic health-check incidents and recovery
            </li>
          </ul>
          <button className="text-button" onClick={onEnter}>
            Open your workspace <ArrowRight />
          </button>
        </div>
      </section>
      <section id="workflow" className="workflow-section">
        <div>
          <div className="section-kicker">CLEAR END-CLIENT JOURNEY</div>
          <h2>
            Connect. Observe.
            <br />
            Respond. Learn.
          </h2>
        </div>
        <div className="workflow-line">
          {[
            "Create private workspace",
            "Connect production service",
            "Stream telemetry or health checks",
            "Coordinate the incident",
            "Analyze and verify recovery",
          ].map((item, index) => (
            <div key={item}>
              <span>{index + 1}</span>
              <strong>{item}</strong>
              <small>STEP 0{index + 1}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="final-cta">
        <div className="cta-glow" />
        <div className="section-kicker">
          REAL SYSTEMS. REAL SIGNALS. REAL RESPONSE.
        </div>
        <h2>
          Put your production
          <br />
          inside the cockpit.
        </h2>
        <button className="primary-button" onClick={onEnter}>
          Create command workspace <ArrowRight />
        </button>
      </section>
      <footer>
        <Logo />
        <p>Intelligent operations grounded in production evidence.</p>
        <span>© 2026 Incident Command</span>
      </footer>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<"landing" | "product">(() =>
    window.location.hash.startsWith("#/app") ? "product" : "landing",
  );
  useEffect(() => {
    window.scrollTo(0, 0);
    if (view === "product") window.history.replaceState(null, "", "#/app");
    else if (window.location.hash.startsWith("#/app"))
      window.history.replaceState(null, "", window.location.pathname);
  }, [view]);
  return (
    <AnimatePresence mode="wait">
      {view === "landing" ? (
        <motion.div
          key="landing"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <Landing onEnter={() => setView("product")} />
        </motion.div>
      ) : (
        <motion.div
          key="product"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <Suspense
            fallback={
              <div className="product-loader">Loading command center…</div>
            }
          >
            <ProductApp onExit={() => setView("landing")} />
          </Suspense>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
