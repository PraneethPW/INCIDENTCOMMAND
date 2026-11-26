import { MotionPreference } from "./motion-context";
import { useContext, useState, type ReactNode } from "react";
import { MotionConfig, useReducedMotion } from "framer-motion";

export function MotionPreferences({ children }: { children: ReactNode }) {
  const systemReduced = useReducedMotion();
  const [manual, setManual] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem("incident-motion");
      return saved === "reduce" ? true : saved === "full" ? false : null;
    } catch {
      return null;
    }
  });
  const reduced = Boolean(systemReduced || manual);
  const toggle = () => {
    const next = !reduced;
    setManual(next);
    try {
      localStorage.setItem("incident-motion", next ? "reduce" : "full");
    } catch {
      /* Session preference remains available. */
    }
  };
  return (
    <MotionPreference.Provider value={{ reduced, toggle }}>
      <MotionConfig reducedMotion={reduced ? "always" : "user"}>
        <div data-motion={reduced ? "reduced" : "full"}>{children}</div>
      </MotionConfig>
    </MotionPreference.Provider>
  );
}
export function MotionToggle() {
  const { reduced, toggle } = useContext(MotionPreference);
  return (
    <button
      className="motion-toggle"
      aria-pressed={reduced}
      onClick={toggle}
      disabled={Boolean(useReducedMotion())}
    >
      {reduced ? "Reduced motion" : "Reduce motion"}
    </button>
  );
}
