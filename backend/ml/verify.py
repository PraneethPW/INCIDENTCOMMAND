"""Validate the committed model, dataset provenance, splits and evaluation."""
import csv
import hashlib
import json
import zipfile
from pathlib import Path
import joblib
import numpy as np

root = Path(__file__).resolve().parent
out = root / "artifacts"
report = json.loads((out / "metrics.json").read_text())
model = joblib.load(out / "isolation_forest.joblib")
vectors = json.loads((out / "parity.json").read_text())
scores = -model.score_samples(np.asarray([v["features"] for v in vectors], dtype=np.float32))
assert np.max(np.abs(scores - [v["score"] for v in vectors])) < 1e-12
digest = hashlib.sha256()
for name in ["operational.csv", "controlled.csv"]:
    digest.update(name.encode() + (root / "data" / name).read_bytes())
assert digest.hexdigest() == report["datasetSha256"]
rows = list(csv.DictReader((root / "data" / "features.csv").open()))
assert sum(r["split"] == "train" for r in rows) == report["trainingSamples"]
assert all(r["source"] == "operational" and r["label"] == "0" for r in rows if r["split"] == "train")
validation_runs = {r["series_id"] for r in rows if r["source"] == "controlled_http" and r["split"] == "validation"}
test_runs = {r["series_id"] for r in rows if r["source"] == "controlled_http" and r["split"] == "test"}
assert not validation_runs.intersection(test_runs)
for run in {r["series_id"] for r in rows if r["source"] == "operational"}:
    order = [r["split"] for r in rows if r["series_id"] == run]
    assert order == sorted(order, key={"train": 0, "validation": 1, "test": 2}.get)
with zipfile.ZipFile(out / "IncidentCommand_ML_Dataset.zip") as archive:
    for name in ["operational.csv", "controlled.csv", "features.csv", "manifest.json"]:
        assert archive.read(name) == (root / "data" / name).read_bytes()
assert report["controlledTest"]["samples"] == 240
heldout = [r for r in rows if r["split"] == "test"]
x = np.asarray([[float(r["log_latency_ratio"]), float(r["log_robust_excess"])] for r in heldout], dtype=np.float32)
y = np.asarray([int(r["label"]) for r in heldout])
predicted = -model.score_samples(x) >= report["threshold"]
actual = {"tp": int(sum(predicted & (y == 1))), "fp": int(sum(predicted & (y == 0))),
          "tn": int(sum(~predicted & (y == 0))), "fn": int(sum(~predicted & (y == 1)))}
assert actual == report["test"]["confusion"]
print("Verified trained weights, reference scores, dataset hash, archive contents and held-out splits.")
