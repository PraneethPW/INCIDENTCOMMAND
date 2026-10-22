import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import type { RequestHandler } from "express";

export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function healthUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw httpError(
      400,
      "Use a public HTTP or HTTPS health URL without credentials.",
    );
  return url;
}
// Resolve once and pin the socket to a vetted address. Redirects never bypass validation.
export async function probe(value: string): Promise<number> {
  const url = healthUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw httpError(400, "Health checks require a public internet address.");
  const target = addresses[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [target]);
          else callback(null, target.address, target.family);
        },
        headers: { "user-agent": "IncidentCommand-Health/1.0" },
      },
      (response) => {
        resolve(response.statusCode || 0);
        response.destroy();
      },
    );
    req.on("error", reject);
    req.end();
  });
}
export function rateLimit(max: number, windowMs: number): RequestHandler {
  const buckets = new Map<string, { count: number; reset: number }>();
  const timer = setInterval(() => {
    for (const [key, item] of buckets)
      if (item.reset < Date.now()) buckets.delete(key);
  }, windowMs);
  timer.unref();
  return (req, res, next) => {
    const key = req.user?.organizationId || req.ip || "unknown";
    const now = Date.now();
    let item = buckets.get(key);
    if (!item || item.reset <= now) {
      item = { count: 0, reset: now + windowMs };
      buckets.set(key, item);
    }
    if (++item.count > max) {
      res.setHeader("Retry-After", Math.ceil((item.reset - now) / 1000));
      res
        .status(429)
        .json({ error: "Too many requests. Please try again shortly." });
      return;
    }
    next();
  };
}
export const requireOperator: RequestHandler = (req, res, next) => {
  if (req.user?.role === "viewer") {
    res.status(403).json({ error: "Your viewer role is read-only." });
    return;
  }
  next();
};
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!["owner", "admin"].includes(req.user?.role || "")) {
    res.status(403).json({ error: "A workspace administrator is required." });
    return;
  }
  next();
};
