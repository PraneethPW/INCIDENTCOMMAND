import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createSecureContext } from "node:tls";
import { z } from "zod";
import { httpError, isPublicAddress } from "./security.js";
import { dockerResource, kubernetesResource } from "./runtime-normalize.mjs";
import type { RuntimeSnapshot } from "./runtime-ingest.js";

export const connectionInput = z
  .object({
    name: z.string().trim().min(2).max(64),
    serviceId: z.string().uuid().optional(),
    provider: z.enum(["docker", "portainer", "kubernetes"]),
    endpointUrl: z.string().trim().url().max(2048),
    namespace: z
      .string()
      .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
      .max(63)
      .default("default"),
    environmentId: z.number().int().min(1).max(2147483647).optional(),
    selector: z.string().trim().max(200).default(""),
    intervalSeconds: z.number().int().min(30).max(300).default(60),
    token: z
      .string()
      .trim()
      .max(16384)
      .refine((v) => !/[\r\n]/.test(v))
      .default(""),
    certificateAuthority: z.string().max(32768).default(""),
    clientCertificate: z.string().max(32768).default(""),
    clientKey: z.string().max(32768).default(""),
  })
  .strict();
export type ConnectionInput = z.infer<typeof connectionInput>;
export type ConnectionCredentials = Pick<
  ConnectionInput,
  "token" | "certificateAuthority" | "clientCertificate" | "clientKey"
>;

function credentialKey() {
  const secret =
    process.env.RUNTIME_CREDENTIALS_KEY || process.env.SESSION_SECRET || "";
  if (secret.length < 32)
    throw httpError(503, "Connection credential storage is not configured.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      "incident-command",
      "runtime-credentials-v1",
      32,
    ),
  );
}
export function encryptCredentials(
  value: ConnectionCredentials,
  scope: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(), iv);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}
export function decryptCredentials(
  value: string,
  scope: string,
): ConnectionCredentials {
  try {
    const [version, iv, tag, encrypted] = value.split(":");
    if (version !== "v1") throw Error("Unsupported credential version");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      credentialKey(),
      Buffer.from(iv, "base64"),
    );
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(encrypted, "base64")),
        cipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    throw httpError(
      400,
      "Saved credentials could not be opened. Reconnect with current credentials.",
    );
  }
}

export function remoteEndpoint(value: string, testLocal = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw httpError(400, "Enter a valid HTTPS API URL.");
  }
  const localTest =
    testLocal &&
    process.env.NODE_ENV === "test" &&
    url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(localTest && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw httpError(
      400,
      "Use an HTTPS API URL without embedded credentials, query parameters, or a fragment.",
    );
  return url;
}
export function checkCredentials(input: ConnectionInput) {
  if (Boolean(input.clientCertificate) !== Boolean(input.clientKey))
    throw httpError(
      400,
      "Upload both the client certificate and its private key.",
    );
  if (!input.token && !input.clientCertificate)
    throw httpError(
      400,
      "Provide an API token or client TLS credentials for this connection.",
    );
  if (input.provider === "portainer" && !input.token)
    throw httpError(400, "Provide your Portainer API access token.");
  try {
    createSecureContext({
      ca: input.certificateAuthority || undefined,
      cert: input.clientCertificate || undefined,
      key: input.clientKey || undefined,
    });
  } catch {
    throw httpError(
      400,
      "The TLS certificate or private key is invalid. Check the uploaded PEM files.",
    );
  }
}

export async function remoteJSON(
  input: ConnectionInput,
  path: string,
  signal = AbortSignal.timeout(25_000),
): Promise<any> {
  const url = remoteEndpoint(input.endpointUrl, true);
  url.pathname = url.pathname.replace(/\/$/, "") + path.split("?")[0];
  url.search = path.includes("?") ? path.slice(path.indexOf("?")) : "";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const dnsTimeout = new AbortController();
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    delay(5000, undefined, { signal: dnsTimeout.signal }).then(() => {
      throw Error("DNS timeout");
    }),
  ])
    .catch(() => {
      throw httpError(
        400,
        "Could not resolve the API host. Check the HTTPS address and DNS configuration.",
      );
    })
    .finally(() => dnsTimeout.abort());
  const localTest = process.env.NODE_ENV === "test" && host === "127.0.0.1";
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !isPublicAddress(a.address) &&
        !(localTest && a.address === "127.0.0.1"),
    )
  )
    throw httpError(
      400,
      "The API must be reachable on a public HTTPS address. Local-only Docker Desktop and private cluster addresses cannot be reached from the hosted app.",
    );
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "IncidentCommand-Runtime/1.0",
  };
  if (input.token)
    headers[input.provider === "portainer" ? "x-api-key" : "authorization"] =
      input.provider === "portainer" ? input.token : `Bearer ${input.token}`;
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? request : httpRequest)(
      url,
      {
        method: "GET",
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        ca: input.certificateAuthority || undefined,
        cert: input.clientCertificate || undefined,
        key: input.clientKey || undefined,
        rejectUnauthorized: true,
        lookup: (_host, options, callback) =>
          options.all
            ? callback(null, [addresses[0]])
            : callback(null, addresses[0].address, addresses[0].family),
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          reject(
            httpError(
              400,
              status >= 300 && status < 400
                ? "The API redirected the request. Enter its final HTTPS API URL."
                : status === 401 || status === 403
                  ? "The remote API rejected these credentials or permissions. Verify the token, TLS identity, and read access."
                  : `The remote API returned HTTP ${status}. Check its availability and API URL.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            response.destroy();
            reject(
              httpError(
                400,
                "Inventory is too large. Narrow the namespace or label selector.",
              ),
            );
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(
            httpError(
              400,
              "The remote API response was interrupted. Retry the connection test.",
            ),
          ),
        );
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(
              httpError(
                400,
                "The endpoint did not return JSON. Enter the API URL, rather than its login page.",
              ),
            );
          }
        });
      },
    );
    req.on("error", () =>
      reject(
        httpError(
          400,
          "Could not establish a verified connection. Check the HTTPS address, certificate trust, network access, and API availability.",
        ),
      ),
    );
    req.end();
  });
}

export async function discoverEnvironments(input: ConnectionInput) {
  checkCredentials(input);
  const data = await remoteJSON(input, "/api/endpoints");
  if (!Array.isArray(data) || data.length > 200)
    throw httpError(400, "Portainer returned an unsupported environment list.");
  return data
    .filter((d) => [1, 2, 4].includes(d.Type))
    .map((d) => ({ id: d.Id, name: String(d.Name).slice(0, 100) }));
}
export async function collectRemote(
  input: ConnectionInput,
): Promise<RuntimeSnapshot["resources"]> {
  checkCredentials(input);
  const signal = AbortSignal.timeout(25_000);
  if (input.provider === "kubernetes") {
    const ns = encodeURIComponent(input.namespace);
    const query = input.selector
      ? `?labelSelector=${encodeURIComponent(input.selector)}`
      : "";
    const paths = [
      `/api/v1/namespaces/${ns}/pods`,
      ...["deployments", "statefulsets", "daemonsets"].map(
        (kind) => `/apis/apps/v1/namespaces/${ns}/${kind}`,
      ),
    ];
    const responses = await Promise.all(
      paths.map((path) => remoteJSON(input, path + query, signal)),
    );
    if (responses.some((r) => !Array.isArray(r.items)))
      throw httpError(
        400,
        "The Kubernetes API returned an invalid workload inventory.",
      );
    const kinds = ["Pod", "Deployment", "StatefulSet", "DaemonSet"];
    const all = responses.flatMap((r, i) =>
      r.items.map((item: any) => ({ ...item, kind: kinds[i] })),
    );
    if (all.length > 200)
      throw httpError(
        400,
        "More than 200 workloads were returned. Narrow the namespace or label selector.",
      );
    return all.map(kubernetesResource);
  }
  if (input.provider === "portainer" && !input.environmentId)
    throw httpError(400, "Choose a Portainer environment first.");
  const base =
    input.provider === "portainer"
      ? `/api/endpoints/${input.environmentId}/docker`
      : "";
  const filters = input.selector
    ? `&filters=${encodeURIComponent(JSON.stringify({ label: [input.selector] }))}`
    : "";
  const containers = await remoteJSON(
    input,
    `${base}/containers/json?all=1${filters}`,
    signal,
  );
  if (!Array.isArray(containers) || containers.length > 200)
    throw httpError(
      400,
      "Inventory is invalid or exceeds 200 containers. Narrow the label selector.",
    );
  const output: RuntimeSnapshot["resources"] = [];
  for (let start = 0; start < containers.length; start += 4) {
    const batch = await Promise.all(
      containers.slice(start, start + 4).map(async (item) => {
        if (!/^[a-f0-9]{12,64}$/i.test(item.Id))
          throw httpError(
            400,
            "The Docker API returned an invalid container identity.",
          );
        const detail = await remoteJSON(
          input,
          `${base}/containers/${item.Id}/json`,
          signal,
        );
        if (!detail.Id || !String(detail.Id).startsWith(item.Id))
          throw httpError(
            400,
            "The Docker API returned an inconsistent inventory.",
          );
        return dockerResource(detail);
      }),
    );
    output.push(...batch);
  }
  return output;
}
