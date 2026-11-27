import { Activity } from "lucide-react";
import type { MlResult } from "./types";
export function MlSignal({ value }: { value?: MlResult | null }) {
  if (!value) return null;
  return (
    <span className={`ml-signal ${value.state}`}>
      <Activity size={13} />{" "}
      {value.state === "anomaly"
        ? "ML · Unusual latency"
        : value.state === "normal"
          ? "ML · Normal latency"
          : value.state === "learning"
            ? `ML baseline · ${value.baselineCount}/${value.baselineMinimum}`
            : value.state === "disabled"
              ? "ML · Paused"
              : "ML · No latency score"}
    </span>
  );
}
