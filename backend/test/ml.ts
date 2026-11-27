import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  forestScore,
  latencyFeatures,
  evaluateLatency,
  modelDirectory,
  modelInfo,
} from "../src/ml.js";

test("backend inference matches scikit-learn scores and Python feature preparation", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("parity.json", modelDirectory), "utf8"),
  );
  assert.ok(vectors.length >= 50);
  for (const v of vectors)
    assert.ok(Math.abs(forestScore(v.features) - v.score) < 1e-11);
  const features = JSON.parse(
    readFileSync(new URL("feature-parity.json", modelDirectory), "utf8"),
  );
  for (const v of features) {
    const calculated = latencyFeatures(v.latencyMs, v.history)!;
    assert.ok(calculated);
    calculated.values.forEach((value, i) =>
      assert.ok(Math.abs(value - v.features[i]) < 1e-12),
    );
  }
});
test("latency detector warms up, scores healthy responses and never treats unavailable or disabled checks as recovery", () => {
  const baseline = Array.from({ length: 25 }, () => 5);
  assert.equal(evaluateLatency(5, baseline.slice(0, 19)).state, "learning");
  assert.equal(evaluateLatency(5, baseline).state, "normal");
  assert.equal(evaluateLatency(1000, baseline).state, "anomaly");
  assert.equal(evaluateLatency(1, baseline).state, "normal");
  assert.equal(evaluateLatency(1000, baseline, false).state, "unavailable");
  assert.equal(evaluateLatency(5, baseline, true, false).state, "disabled");
  assert.equal(evaluateLatency(NaN, baseline).state, "unavailable");
  assert.throws(() => forestScore([NaN, 1]));
  assert.throws(() => forestScore([1]));
  assert.ok(modelInfo.trainingSamples > 1000);
  assert.ok(modelInfo.test.confusion.tp + modelInfo.test.confusion.fn > 0);
});
