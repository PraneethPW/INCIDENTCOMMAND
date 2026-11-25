import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("collector CLI sends sanitized complete inventories and does not submit failed or oversized reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "incident-collector-"));
  const received = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push({
      path: req.url,
      key: req.headers["x-ingest-key"],
      body: JSON.parse(raw),
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end('{"accepted":true}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const fixture = join(dir, "fixture.json");
    for (const cli of ["docker", "kubectl"])
      await writeFile(
        join(dir, cli),
        `#!/bin/sh
if [ -n "$CLI_FAIL" ]; then echo 'sensitive CLI output' >&2; exit 1; fi
if [ "$1" = 'ps' ]; then echo 'container-id'; else /bin/cat "$CLI_FIXTURE"; fi
`,
        { mode: 0o755 },
      );
    const env = {
      ...process.env,
      PATH: dir + ":" + process.env.PATH,
      CLI_FIXTURE: fixture,
      INCIDENT_API_URL: `http://127.0.0.1:${server.address().port}`,
      INCIDENT_SERVICE_ID: "11111111-1111-4111-8111-111111111111",
      INCIDENT_INGEST_KEY: "test-key",
      RUNTIME_CLUSTER: "fixture-scope",
      RUNTIME_PLATFORM: "docker",
    };
    delete env.NODE_TEST_CONTEXT;
    const run = (extra) =>
      exec(
        process.execPath,
        [resolve("scripts/runtime-collector.mjs"), "--once"],
        { env: { ...env, ...extra } },
      );
    await writeFile(
      fixture,
      JSON.stringify([
        {
          Id: "container-id",
          Name: "/orders",
          Image: "sha256:123",
          State: { Status: "exited", ExitCode: 137, OOMKilled: true },
          Config: { Env: ["SECRET=sensitive"] },
        },
      ]),
    );
    await run({}).catch((e) => {
      throw new Error("Docker fixture run failed: " + e.stderr);
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].key, "test-key");
    assert.equal(received[0].body.resources[0].reason, "OOMKilled");
    assert.ok(!JSON.stringify(received).includes("sensitive"));
    await writeFile(
      fixture,
      JSON.stringify({
        items: [
          {
            kind: "Pod",
            metadata: { uid: "pod-id", name: "api", namespace: "orders" },
            spec: { containers: [{}] },
            status: {
              phase: "Running",
              containerStatuses: [
                { state: { waiting: { reason: "CrashLoopBackOff" } } },
              ],
            },
          },
        ],
      }),
    );
    await run({
      RUNTIME_PLATFORM: "kubernetes",
      KUBE_NAMESPACE: "orders",
    }).catch((e) => {
      throw new Error("Kubernetes fixture run failed: " + e.stderr);
    });
    assert.equal(received.length, 2);
    assert.equal(received[1].body.resources[0].status, "down");
    await assert.rejects(
      () => run({ CLI_FAIL: "1" }),
      (e) => {
        assert.ok(!e.stderr.includes("sensitive"));
        return true;
      },
    );
    await writeFile(fixture, "invalid JSON containing sensitive data");
    await assert.rejects(
      () => run({ RUNTIME_PLATFORM: "kubernetes" }),
      (e) => {
        assert.ok(!e.stderr.includes("sensitive"));
        return true;
      },
    );
    await writeFile(fixture, JSON.stringify({ items: Array(201).fill({}) }));
    await assert.rejects(() => run({ RUNTIME_PLATFORM: "kubernetes" }));
    assert.equal(received.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
