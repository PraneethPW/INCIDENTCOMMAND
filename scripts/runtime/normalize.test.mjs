import test from "node:test";
import assert from "node:assert/strict";
import { dockerResource, kubernetesResource } from "./normalize.mjs";
const pod = (extra = {}) => ({
  kind: "Pod",
  metadata: {
    uid: "uid",
    name: "api",
    namespace: "test",
    creationTimestamp: "2020-01-01T00:00:00Z",
  },
  spec: {
    containers: [
      { name: "api", env: [{ name: "PASSWORD", value: "do-not-transmit" }] },
    ],
  },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "True" }],
    containerStatuses: [
      {
        ready: true,
        restartCount: 3,
        imageID: "sha256:123",
        state: { running: {} },
      },
    ],
  },
  ...extra,
});
test("Docker classifies health, restart, OOM and successful one-shot completion without leaking config", () => {
  const c = {
    Id: "container",
    Name: "/api",
    Image: "sha256:digest",
    RestartCount: 2,
    Config: {
      Env: ["SECRET=do-not-transmit"],
      Labels: {
        "com.docker.compose.project": "orders",
        secret: "do-not-transmit",
      },
    },
    State: {
      Status: "running",
      Health: { Status: "unhealthy", Log: [{ Output: "do-not-transmit" }] },
    },
  };
  assert.equal(dockerResource(c).status, "down");
  assert.equal(dockerResource(c).namespace, "orders");
  assert.ok(!JSON.stringify(dockerResource(c)).includes("do-not-transmit"));
  assert.equal(
    dockerResource({
      ...c,
      State: { Status: "exited", ExitCode: 137, OOMKilled: true },
    }).reason,
    "OOMKilled",
  );
  assert.equal(
    dockerResource({ ...c, State: { Status: "restarting" } }).status,
    "down",
  );
  assert.equal(
    dockerResource({ ...c, State: { Status: "exited", ExitCode: 0 } }).status,
    "completed",
  );
  assert.equal(
    dockerResource({ ...c, State: { Status: "running" } }).status,
    "healthy",
  );
});
test("Pod readiness, crash loops, image failures, OOM, unschedulable and successful jobs", () => {
  assert.equal(kubernetesResource(pod()).status, "healthy");
  assert.ok(
    !JSON.stringify(kubernetesResource(pod())).includes("do-not-transmit"),
  );
  for (const reason of ["CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"])
    assert.equal(
      kubernetesResource(
        pod({
          status: {
            phase: "Running",
            containerStatuses: [{ state: { waiting: { reason } } }],
          },
        }),
      ).status,
      "down",
    );
  assert.equal(
    kubernetesResource(
      pod({
        status: {
          containerStatuses: [
            { state: { terminated: { reason: "OOMKilled", exitCode: 137 } } },
          ],
        },
      }),
    ).reason,
    "OOMKilled",
  );
  assert.equal(
    kubernetesResource(pod({ status: { phase: "Succeeded" } })).status,
    "completed",
  );
  assert.equal(
    kubernetesResource(
      pod({
        status: {
          phase: "Pending",
          conditions: [
            { type: "PodScheduled", status: "False", reason: "Unschedulable" },
          ],
        },
      }),
    ).status,
    "degraded",
  );
  assert.equal(
    kubernetesResource(
      pod({
        metadata: {
          uid: "a",
          name: "new",
          creationTimestamp: new Date().toISOString(),
        },
        status: { phase: "Pending" },
      }),
    ).status,
    "unknown",
  );
  assert.equal(
    kubernetesResource(pod({ status: { phase: "Running" } })).status,
    "degraded",
  );
  assert.equal(
    kubernetesResource(
      pod({
        metadata: {
          uid: "a",
          name: "old",
          deletionTimestamp: new Date().toISOString(),
        },
      }),
    ).status,
    "unknown",
  );
});
test("Workload replica loss, zero scale, delayed generations and failed rollouts", () => {
  const d = {
    kind: "Deployment",
    metadata: { uid: "d", name: "api", generation: 3 },
    spec: { replicas: 3 },
    status: { observedGeneration: 3, readyReplicas: 2 },
  };
  assert.equal(kubernetesResource(d).status, "degraded");
  assert.equal(
    kubernetesResource({
      ...d,
      status: { observedGeneration: 3, readyReplicas: 0 },
    }).status,
    "down",
  );
  assert.equal(
    kubernetesResource({ ...d, spec: { replicas: 0 } }).status,
    "completed",
  );
  assert.equal(
    kubernetesResource({ ...d, status: { observedGeneration: 2 } }).status,
    "unknown",
  );
  assert.equal(
    kubernetesResource({
      ...d,
      status: { observedGeneration: 3, readyReplicas: 3 },
    }).status,
    "healthy",
  );
  assert.equal(
    kubernetesResource({
      ...d,
      status: {
        observedGeneration: 3,
        conditions: [
          {
            type: "Progressing",
            status: "False",
            reason: "ProgressDeadlineExceeded",
          },
        ],
      },
    }).reason,
    "ProgressDeadlineExceeded",
  );
  const daemon = {
    ...d,
    kind: "DaemonSet",
    status: {
      observedGeneration: 3,
      numberReady: 2,
      desiredNumberScheduled: 2,
    },
  };
  assert.equal(kubernetesResource(daemon).status, "healthy");
});
