#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { dockerResource, kubernetesResource } from "./runtime/normalize.mjs";
const stopController = new AbortController();
const exec = promisify(execFile);
const run = async (file, args) =>
  (
    await exec(file, args, {
      timeout: 25_000,
      maxBuffer: 16 * 1024 * 1024,
      signal: stopController.signal,
    })
  ).stdout;
if (process.argv.includes("--help")) {
  console.log(
    "Set RUNTIME_PLATFORM=docker|kubernetes, RUNTIME_CLUSTER (stable unique host/namespace name), INCIDENT_API_URL, INCIDENT_SERVICE_ID and INCIDENT_INGEST_KEY. Optional: RUNTIME_INTERVAL_SECONDS=30, RUNTIME_SELECTOR, KUBE_NAMESPACE=default, KUBE_CONTEXT. Pass --once for a single inventory.",
  );
  process.exit(0);
}
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Runtime CLI returned invalid JSON");
  }
};
const env = process.env;
const platform = env.RUNTIME_PLATFORM || "docker";
const interval = Number(env.RUNTIME_INTERVAL_SECONDS || 30);
const cluster =
  env.RUNTIME_CLUSTER || (platform === "docker" ? hostname() : "");
const url = new URL(env.INCIDENT_API_URL || "http://localhost:8787");
if (
  !["http:", "https:"].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !["", "/"].includes(url.pathname)
)
  throw new Error("INCIDENT_API_URL must be an HTTP(S) origin");
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
)
  throw new Error("Use HTTPS for remote API connections");
if (
  !["docker", "kubernetes"].includes(platform) ||
  !cluster ||
  cluster.length > 100 ||
  !Number.isInteger(interval) ||
  interval < 15 ||
  interval > 300
)
  throw new Error(
    "Set a platform, unique RUNTIME_CLUSTER, and an integer interval from 15 to 300 seconds",
  );
if (
  !/^[0-9a-f-]{36}$/i.test(env.INCIDENT_SERVICE_ID || "") ||
  !env.INCIDENT_INGEST_KEY
)
  throw new Error(
    "Set INCIDENT_SERVICE_ID and INCIDENT_INGEST_KEY from a connected service",
  );
let stopped = false;
process.once("SIGTERM", () => {
  stopped = true;
  stopController.abort();
});
process.once("SIGINT", () => {
  stopped = true;
  stopController.abort();
});
async function inventory() {
  if (platform === "docker") {
    const args = ["ps", "--all", "--quiet", "--no-trunc"];
    if (env.RUNTIME_SELECTOR)
      args.push("--filter", `label=${env.RUNTIME_SELECTOR}`);
    const ids = (await run("docker", args)).trim().split(/\s+/).filter(Boolean);
    if (ids.length > 200)
      throw new Error(
        "Inventory exceeds 200 resources; narrow RUNTIME_SELECTOR. Nothing was submitted.",
      );
    if (!ids.length) return [];
    // Inspect only; no Docker socket is passed to the web API.
    return parse(
      await run("docker", ["inspect", "--type", "container", ...ids]),
    ).map(dockerResource);
  }
  const namespace = env.KUBE_NAMESPACE || "default";
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))
    throw new Error("Set one explicit KUBE_NAMESPACE");
  const args = [
    "get",
    "pods,deployments.apps,statefulsets.apps,daemonsets.apps",
    "--namespace",
    namespace,
    "--output",
    "json",
    "--request-timeout=20s",
    "--cache-dir=/tmp/incident-kube-cache",
  ];
  if (env.KUBE_CONTEXT) args.push("--context", env.KUBE_CONTEXT);
  if (env.RUNTIME_SELECTOR) args.push("--selector", env.RUNTIME_SELECTOR);
  const items = parse(await run("kubectl", args)).items;
  if (!Array.isArray(items) || items.length > 200)
    throw new Error(
      "Inventory invalid or exceeds 200 resources; narrow RUNTIME_SELECTOR. Nothing was submitted.",
    );
  return items.map(kubernetesResource);
}
do {
  try {
    const observedAt = new Date().toISOString();
    const resources = await inventory();
    const payload = {
      platform,
      cluster,
      observedAt,
      intervalSeconds: interval,
      resources,
    };
    const r = await fetch(
      new URL(`/api/ingest/${env.INCIDENT_SERVICE_ID}/runtime`, url),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(20_000),
          stopController.signal,
        ]),
        headers: {
          "content-type": "application/json",
          "x-ingest-key": env.INCIDENT_INGEST_KEY,
        },
        body: JSON.stringify(payload),
      },
    );
    if (!r.ok) throw new Error(`Runtime ingest returned HTTP ${r.status}`);
    console.log(
      `${new Date().toISOString()} ${platform}: submitted ${resources.length} resources`,
    );
  } catch (error) {
    // CLI stderr can contain private workload configuration. Keep it local and out of logs.
    console.error(
      `Collector failed: ${error.code ? "runtime CLI unavailable or request failed" : error.message}. Previous observations remain; missing heartbeats become stale.`,
    );
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
  if (process.argv.includes("--once") || stopped) break;
  await sleep(interval * 1000, undefined, {
    signal: stopController.signal,
  }).catch(() => undefined);
} while (!stopped);
