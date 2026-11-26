import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { analyzeIncident } from "../src/ai.js";

const originalFetch = globalThis.fetch;
const saved = {
  key: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL,
  fallbacks: process.env.OPENROUTER_FALLBACK_MODELS,
};
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries({
    OPENROUTER_API_KEY: saved.key,
    OPENROUTER_MODEL: saved.model,
    OPENROUTER_FALLBACK_MODELS: saved.fallbacks,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
function configure() {
  process.env.OPENROUTER_API_KEY = "test-only-provider-key";
  process.env.OPENROUTER_MODEL = "test/primary";
  delete process.env.OPENROUTER_FALLBACK_MODELS;
}
function success(evidence = ["Timeline records creating the failure marker."]) {
  return Response.json({
    model: "test/provider",
    choices: [{ message: { tool_calls: [{ function: {
      name: "submit_incident_analysis",
      arguments: JSON.stringify({
        summary: "The container health check failed.",
        probableCause: "The recorded test deliberately created the failure marker.",
        confidence: 85,
        evidence,
        recommendations: ["Verify the test context before removing the marker."],
      }),
    } }] } }],
  });
}

test("AI retries reasoning-only truncated output without requiring a fallback model", async () => {
  configure();
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? Response.json({ choices: [{ finish_reason: "length", message: { content: null, reasoning: "not a final analysis" } }] })
      : success();
  };
  const result = await analyzeIncident({ incident: { title: "Controlled failure" } });
  assert.equal(result.model, "test/provider");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, "test/primary");
  assert.ok(Number(requests[1].max_tokens) > Number(requests[0].max_tokens));
  assert.deepEqual(requests[0].reasoning, { effort: "low", exclude: true });
});

test("AI respects configured fallback order after a provider failure", async () => {
  configure();
  process.env.OPENROUTER_FALLBACK_MODELS = "test/secondary,test/third";
  const models: string[] = [];
  globalThis.fetch = async (_input, init) => {
    models.push(JSON.parse(String(init?.body)).model);
    return models.length === 1
      ? Response.json({ error: { message: "Temporarily busy" } }, { status: 503 })
      : success();
  };
  await analyzeIncident({});
  assert.deepEqual(models, ["test/primary", "test/secondary"]);
});

test("AI never treats reasoning as an analysis and stops after two attempts", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ choices: [{ finish_reason: "length", message: { reasoning: '{"summary":"unsupported internal thought"}' } }] });
  };
  await assert.rejects(analyzeIncident({}), { status: 502 });
  assert.equal(calls, 2);
});

test("AI rejects invalid structured evidence instead of persisting it", async () => {
  configure();
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"summary":"Missing all required evidence fields"}' } }] });
  await assert.rejects(analyzeIncident({}), { status: 502 });
});

test("AI accepts a complete evidence item over 500 characters without dropping the analysis", async () => {
  configure();
  const evidence = "Recorded timeline context. ".repeat(30);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return success([evidence]); };
  const result = await analyzeIncident({});
  assert.equal(result.evidence[0], evidence);
  assert.equal(calls, 1);
});
