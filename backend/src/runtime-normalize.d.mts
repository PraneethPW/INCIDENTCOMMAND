import type { RuntimeSnapshot } from "./runtime-ingest.js";
export function dockerResource(
  value: any,
): RuntimeSnapshot["resources"][number];
export function kubernetesResource(
  value: any,
): RuntimeSnapshot["resources"][number];
