import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionInput,
  remoteEndpoint,
  remoteJSON,
  collectRemote,
  discoverEnvironments,
  encryptCredentials,
  decryptCredentials,
} from "../src/runtime-remote.js";

test("credential encryption authenticates organization and connection scope and detects tampering", () => {
  const value = {
    token: "private",
    certificateAuthority: "",
    clientCertificate: "",
    clientKey: "",
  };
  const encrypted = encryptCredentials(value, "org:connection");
  assert.deepEqual(decryptCredentials(encrypted, "org:connection"), value);
  assert.notEqual(encrypted, encryptCredentials(value, "org:connection"));
  assert.throws(
    () => decryptCredentials(encrypted, "other:connection"),
    /could not be opened/,
  );
  assert.throws(() =>
    decryptCredentials(encrypted.replace(/^v1:/, "v2:"), "org:connection"),
  );
  const parts = encrypted.split(":");
  parts[2] = Buffer.alloc(16).toString("base64");
  assert.throws(() => decryptCredentials(parts.join(":"), "org:connection"));
});
test("remote endpoints reject insecure URLs, embedded credentials, query strings, private networks and redirects", async () => {
  for (const url of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com?token=x",
    "https://example.com#x",
  ])
    assert.throws(() => remoteEndpoint(url));
  const input = connectionInput.parse({
    name: "Policy test",
    provider: "docker",
    endpointUrl: "https://127.0.0.2",
    token: "secret",
  });
  await assert.rejects(remoteJSON(input, "/"), /public HTTPS/);
  assert.throws(() =>
    connectionInput.parse({ ...input, token: "token\r\nx-secret: leak" }),
  );
});
test("Portainer discovery and Docker proxy inventory send only API-token GETs and never forward inspect secrets", async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    assert.equal(req.method, "GET");
    assert.equal(req.headers["x-api-key"], "test-api-token");
    assert.equal(req.headers.authorization, undefined);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/endpoints"
          ? [
              { Id: 4, Name: "Production", Type: 1 },
              { Id: 5, Name: "K8s", Type: 2 },
            ]
          : req.url!.includes("/containers/json")
            ? [{ Id: "b".repeat(64) }]
            : {
                Id: "b".repeat(64),
                Name: "/orders",
                State: { Status: "running" },
                Config: { Env: ["SECRET=hidden"] },
                Mounts: [{ Source: "/private" }],
                Image: "demo:v1",
              },
      ),
    );
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const input = connectionInput.parse({
      name: "Portainer test",
      provider: "portainer",
      endpointUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "test-api-token",
      environmentId: 4,
      selector: "app=orders",
    });
    assert.equal((await discoverEnvironments(input))[0].name, "Production");
    assert.equal((await collectRemote(input))[0].status, "healthy");
    assert.ok(
      paths.some((p) =>
        p.startsWith("/api/endpoints/4/docker/containers/json"),
      ),
    );
    assert.ok(!JSON.stringify(await collectRemote(input)).includes("SECRET"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("Kubernetes API lists the selected namespace and labels, normalizes all supported kinds and fails the whole snapshot on denied reads", async () => {
  let deny = false;
  const server = createServer((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.headers.authorization, "Bearer kube-read-token");
    assert.ok(req.url!.includes("/namespaces/orders/"));
    assert.ok(req.url!.includes("labelSelector=app%3Dorders"));
    if (deny) {
      res.writeHead(403).end("{}");
      return;
    }
    const pod = req.url!.includes("/pods?");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "orders",
              uid: pod ? "pod-1" : req.url!.split("/").pop(),
              namespace: "orders",
              generation: 1,
            },
            spec: { replicas: 2, containers: [{}] },
            status: pod
              ? {
                  phase: "Running",
                  conditions: [{ type: "Ready", status: "True" }],
                  containerStatuses: [{ ready: true, restartCount: 0 }],
                }
              : {
                  readyReplicas: 1,
                  numberReady: 1,
                  desiredNumberScheduled: 2,
                  observedGeneration: 1,
                },
          },
        ],
      }),
    );
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const input = connectionInput.parse({
      name: "Kube test",
      provider: "kubernetes",
      endpointUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "kube-read-token",
      namespace: "orders",
      selector: "app=orders",
    });
    const resources = await collectRemote(input);
    assert.deepEqual(
      resources.map((r) => r.kind),
      ["Pod", "Deployment", "StatefulSet", "DaemonSet"],
    );
    assert.equal(resources[0].status, "healthy");
    assert.equal(resources[1].status, "degraded");
    deny = true;
    await assert.rejects(collectRemote(input), /rejected these credentials/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("remote inventory rejects redirects, oversized bodies, interrupted responses and non-JSON pages", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "https://example.com" }).end();
      return;
    }
    if (req.url === "/large") {
      res.end("x".repeat(2 * 1024 * 1024 + 1));
      return;
    }
    if (req.url === "/partial") {
      res.writeHead(200, { "content-length": 200 });
      res.write("{");
      res.destroy();
      return;
    }
    res.end("<html>login</html>");
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const input = connectionInput.parse({
      name: "Response policy",
      provider: "docker",
      endpointUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "test",
    });
    await assert.rejects(remoteJSON(input, "/redirect"), /redirected/);
    await assert.rejects(remoteJSON(input, "/large"), /too large/);
    await assert.rejects(remoteJSON(input, "/partial"));
    await assert.rejects(remoteJSON(input, "/html"), /did not return JSON/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("TLS server identity is verified; explicitly trusted CA supports a private certificate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ic-runtime-tls-"));
  let server: ReturnType<typeof httpsServer> | undefined;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    const ca = readFileSync(join(dir, "cert.pem"), "utf8");
    server = httpsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: ca },
      (_req, res) => res.end('{"ok":true}'),
    ).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", r));
    const input = connectionInput.parse({
      name: "TLS test",
      provider: "docker",
      endpointUrl: `https://127.0.0.1:${(server.address() as { port: number }).port}`,
      token: "test",
    });
    await assert.rejects(remoteJSON(input, "/"), /verified connection/);
    assert.deepEqual(
      await remoteJSON({ ...input, certificateAuthority: ca }, "/"),
      { ok: true },
    );
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
