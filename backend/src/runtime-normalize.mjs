// Explicit field selection: never forward environment values, commands, logs or annotations.
const clean = (value, limit = 500) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, limit);
const count = (value) => Math.min(2147483647, Math.max(0, Number(value) || 0));
export function dockerResource(container) {
  const s = container.State || {};
  const health = s.Health?.Status;
  let status = "unknown",
    reason = `Container ${s.Status || "state unavailable"}`;
  if (s.Status === "running") {
    status =
      health === "unhealthy"
        ? "down"
        : health === "starting"
          ? "unknown"
          : "healthy";
    reason = health
      ? `Docker health: ${health}`
      : "Running; no Docker healthcheck configured";
  } else if (s.Status === "exited" && s.ExitCode === 0 && !s.OOMKilled) {
    status = "completed";
    reason = "Exited successfully (code 0)";
  } else if (
    s.OOMKilled ||
    ["exited", "dead", "restarting"].includes(s.Status)
  ) {
    status = "down";
    reason = s.OOMKilled
      ? "OOMKilled"
      : s.Status === "exited"
        ? `Exited with code ${s.ExitCode}`
        : `Container ${s.Status}`;
  } else if (s.Status === "paused") {
    status = "degraded";
    reason = "Container paused";
  }
  return {
    uid: clean(container.Id, 256),
    name: clean((container.Name || container.Id).replace(/^\//, ""), 200),
    namespace: clean(
      container.Config?.Labels?.["com.docker.compose.project"],
      100,
    ),
    kind: "Container",
    status,
    reason,
    image: clean(container.Image),
    restartCount: count(container.RestartCount),
    ready: null,
    desired: null,
  };
}

export function kubernetesResource(item) {
  const m = item.metadata || {},
    s = item.status || {},
    spec = item.spec || {};
  const base = {
    uid: clean(m.uid, 256),
    name: clean(m.name, 200),
    namespace: clean(m.namespace, 100),
    kind: item.kind,
    image: "",
    restartCount: 0,
    ready: null,
    desired: null,
    status: "unknown",
    reason: "Status unavailable",
  };
  if (m.deletionTimestamp)
    return { ...base, reason: "Terminating; awaiting replacement or removal" };
  if (item.kind === "Pod") {
    const containers = [
      ...(s.initContainerStatuses || []),
      ...(s.containerStatuses || []),
    ];
    const regular = s.containerStatuses || [];
    base.image = clean(
      (s.containerStatuses || [])
        .map((c) => c.imageID || c.image)
        .filter(Boolean)
        .join(", "),
    );
    base.restartCount = count(
      containers.reduce((n, c) => n + count(c.restartCount), 0),
    );
    base.ready = regular.filter((c) => c.ready).length;
    base.desired = (spec.containers || []).length;
    if (s.phase === "Succeeded")
      return {
        ...base,
        status: "completed",
        reason: "Pod completed successfully",
      };
    if (s.phase === "Failed")
      return {
        ...base,
        status: "down",
        reason: clean(s.reason || "Pod failed"),
      };
    const bad = containers.find(
      (c) =>
        [
          "CrashLoopBackOff",
          "ImagePullBackOff",
          "ErrImagePull",
          "CreateContainerConfigError",
          "RunContainerError",
        ].includes(c.state?.waiting?.reason) ||
        (c.state?.terminated && c.state.terminated.exitCode !== 0),
    );
    if (bad)
      return {
        ...base,
        status: "down",
        reason: clean(
          (bad.state?.waiting?.reason ||
            bad.state?.terminated?.reason ||
            `Exit ${bad.state?.terminated?.exitCode}`) +
            (bad.lastState?.terminated?.reason
              ? ` (last exit: ${bad.lastState.terminated.reason})`
              : ""),
        ),
      };
    const ready =
      s.conditions?.find((c) => c.type === "Ready")?.status === "True";
    const unscheduled = s.conditions?.find(
      (c) => c.type === "PodScheduled" && c.status === "False",
    );
    if (unscheduled)
      return {
        ...base,
        status: "degraded",
        reason: clean(unscheduled.reason || "Unschedulable"),
      };
    if (ready) return { ...base, status: "healthy", reason: "Pod Ready" };
    // Warm-up is unknown for 120s, avoiding incidents for ordinary startup.
    const old =
      m.creationTimestamp &&
      Date.now() - Date.parse(m.creationTimestamp) > 120_000;
    return {
      ...base,
      status: old ? "degraded" : "unknown",
      reason: old
        ? `Pod not Ready (${s.phase || "unknown"})`
        : "Pod starting (120s readiness grace)",
    };
  }
  base.image = clean(
    (spec.template?.spec?.containers || []).map((c) => c.image).join(", "),
  );
  base.ready = count(s.numberReady ?? s.readyReplicas);
  base.desired = count(
    item.kind === "DaemonSet" ? s.desiredNumberScheduled : (spec.replicas ?? 1),
  );
  if (base.desired === 0)
    return { ...base, status: "completed", reason: "Workload scaled to zero" };
  if ((s.observedGeneration ?? 0) < (m.generation ?? 0))
    return { ...base, reason: "Controller has not observed this generation" };
  const failed = s.conditions?.find(
    (c) =>
      (c.type === "Progressing" && c.status === "False") ||
      (c.type === "ReplicaFailure" && c.status === "True"),
  );
  if (failed)
    return {
      ...base,
      status: "down",
      reason: clean(failed.reason || "Workload rollout failed"),
    };
  if (
    base.ready < base.desired &&
    m.creationTimestamp &&
    Date.now() - Date.parse(m.creationTimestamp) < 120_000
  )
    return { ...base, reason: "Workload starting (120s readiness grace)" };
  return {
    ...base,
    status:
      base.ready >= base.desired
        ? "healthy"
        : base.ready === 0
          ? "down"
          : "degraded",
    reason: `${base.ready}/${base.desired} replicas Ready`,
  };
}
