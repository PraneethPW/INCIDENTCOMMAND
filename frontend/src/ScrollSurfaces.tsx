import { useAppReducedMotion } from "./motion-context";
import {
  motion,
  useMotionValueEvent,
  useScroll,
  useSpring,
  useTransform,
} from "framer-motion";
import { useRef, useState, type ReactNode } from "react";

export function ScrollSection({
  id,
  className,
  children,
}: {
  id?: string;
  className: string;
  children: ReactNode;
}) {
  const target = useRef<HTMLElement>(null);
  const reduced = useAppReducedMotion();
  const { scrollYProgress } = useScroll({
    target,
    offset: ["start end", "end start"],
  });
  const glowX = useTransform(scrollYProgress, [0, 1], ["-15%", "30%"]);
  return (
    <motion.section
      ref={target}
      id={id}
      className={`${className} scroll-surface`}
      initial={reduced ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
    >
      <motion.div
        className="surface-ember"
        aria-hidden="true"
        style={reduced ? undefined : { x: glowX }}
      />
      {children}
    </motion.section>
  );
}

const steps = [
  [
    "01",
    "Connect your world.",
    "Bring health endpoints, Docker containers, and Kubernetes workloads into a private workspace.",
  ],
  [
    "02",
    "Listen to the signals.",
    "Health checks and authenticated collectors turn observed failures into actionable incidents.",
  ],
  [
    "03",
    "Give the response an owner.",
    "Assign responders, preserve the timeline, and keep everyone aligned through the live stream.",
  ],
  [
    "04",
    "Follow the evidence.",
    "AI investigates stored observations and suggests verification steps, with uncertainty visible.",
  ],
  [
    "05",
    "Verify the recovery.",
    "Confirm a healthy observation and retain the complete response history for the next incident.",
  ],
];
export function WorkflowStory() {
  const ref = useRef<HTMLElement>(null);
  const reduced = useAppReducedMotion();
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 28 });
  const [active, setActive] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", (value) =>
    setActive(Math.min(4, Math.floor(value * 5))),
  );
  return (
    <section
      id="workflow"
      ref={ref}
      className={`workflow-story ${reduced ? "static-story" : ""}`}
    >
      <div className="workflow-sticky">
        <div className="workflow-story-heading">
          <div className="section-kicker">THE OPERATING LOOP</div>
          <h2>
            From the first signal
            <br />
            <span>to the next clear move.</span>
          </h2>
          <p>One continuous response. Scroll through the journey.</p>
          <div className="story-progress" aria-hidden="true">
            <motion.i style={{ scaleX: reduced ? 1 : progress }} />
          </div>
          <span className="story-counter" aria-hidden="true">
            0{active + 1} / 05
          </span>
        </div>
        <ol className="workflow-steps">
          {steps.map(([number, title, text], index) => (
            <li
              key={number}
              className={reduced || index === active ? "is-current" : ""}
            >
              <span className="step-number">{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
