"""Train, calibrate, export and evaluate the HTTP latency Isolation Forest."""
import csv
import hashlib
import json
import math
import platform
import statistics
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, confusion_matrix, precision_recall_fscore_support, precision_recall_curve

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts"
OUT.mkdir(exist_ok=True)
MIN_BASELINE, WINDOW, SEED = 20, 60, 112
FEATURES = ["log_latency_ratio", "log_robust_excess"]


def features(latency, history):
    values = history[-WINDOW:]
    median = statistics.median(values)
    mad = statistics.median([abs(v - median) for v in values])
    scale = max(mad * 1.4826, median * 0.1, 1.0)
    return [math.log(max(1.0, latency / median)), math.log1p(max(0.0, (latency - median) / scale))]


def main():
    groups = defaultdict(list)
    digest = hashlib.sha256()
    for file in ["operational.csv", "controlled.csv"]:
        raw = (ROOT / "data" / file).read_bytes()
        digest.update(file.encode() + raw)
        for row in csv.DictReader(raw.decode().splitlines()):
            groups[row["series_id"]].append(row)
    samples = []
    for name, rows in sorted(groups.items()):
        rows.sort(key=lambda r: int(r["sequence"]))
        history = []
        for i, row in enumerate(rows):
            value, label = int(row["latency_ms"]), int(row["label"])
            if len(history) >= MIN_BASELINE:
                if row["source"] == "operational":
                    fraction = i / len(rows)
                    split = "train" if fraction < 0.6 else "validation" if fraction < 0.8 else "test"
                else:
                    # Entire controlled runs held out; no adjacent-row random split.
                    split = "validation" if name in ["controlled-1", "controlled-2", "controlled-3"] else "test"
                samples.append({**row, "split": split, "features": features(value, history)})
            # Historical bootstrap windows do not consult ground-truth labels.
            history.append(value)
            history = history[-WINDOW:]
    train = [s for s in samples if s["split"] == "train"]
    validation = [s for s in samples if s["split"] == "validation"]
    test = [s for s in samples if s["split"] == "test"]
    if len(train) < 200 or not validation or not test:
        raise ValueError("Insufficient independent measurements for training and evaluation.")
    model = IsolationForest(n_estimators=128, max_samples=256, random_state=SEED, contamination="auto", n_jobs=1)
    model.fit(np.asarray([s["features"] for s in train], dtype=np.float32))
    calibration = [s for s in validation if s["source"] == "operational"]
    calibration_scores = -model.score_samples(np.asarray([s["features"] for s in calibration], dtype=np.float32))
    # Set the threshold with validation normal observations only; test is untouched.
    threshold = float(np.quantile(calibration_scores, 0.99, method="higher"))
    # Comparisons use >=; move the boundary past ties at the calibration quantile.
    threshold = float(np.nextafter(threshold, math.inf))
    # Reproduce deployed baseline updates on held-out observations: only prior
    # *predicted-normal* responses enter the baseline. Evaluation labels are never
    # consulted for features, baseline updates, fitting or threshold calibration.
    lookup = {(s["series_id"], s["sequence"]): s for s in samples}
    for name, rows in sorted(groups.items()):
        history = []
        for row in rows:
            value = int(row["latency_ms"])
            item = lookup.get((name, row["sequence"]))
            online = row["source"] == "controlled_http" or (item and item["split"] == "test")
            anomaly = False
            if online and len(history) >= MIN_BASELINE and item:
                item["features"] = features(value, history)
                score = float(-model.score_samples(np.asarray([item["features"]], dtype=np.float32))[0])
                anomaly = score >= threshold
            if not anomaly:
                history.append(value)
                history = history[-WINDOW:]
    val_scores = -model.score_samples(np.asarray([s["features"] for s in validation], dtype=np.float32))

    def metrics(rows, scores):
        y = np.asarray([int(s["label"]) for s in rows])
        predicted = scores >= threshold
        p, r, f, _ = precision_recall_fscore_support(y, predicted, average="binary", zero_division=0)
        tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel().tolist()
        return {"samples": len(rows), "normal": int(sum(y == 0)), "anomalous": int(sum(y == 1)),
                "precision": float(p), "recall": float(r), "f1": float(f), "falsePositiveRate": fp / max(1, tn + fp),
                "averagePrecision": float(average_precision_score(y, scores)) if sum(y) else None,
                "confusion": {"tn": tn, "fp": fp, "fn": fn, "tp": tp}}

    test_scores = -model.score_samples(np.asarray([s["features"] for s in test], dtype=np.float32))
    controlled_indices = [i for i, s in enumerate(test) if s["source"] == "controlled_http"]
    controlled_rows = [test[i] for i in controlled_indices]
    report = {"algorithm": "Isolation Forest", "scope": "HTTP latency anomaly detection", "seed": SEED,
              "trainedAt": datetime.now(timezone.utc).isoformat(), "datasetSha256": digest.hexdigest(),
              "versions": {"python": platform.python_version(), "sklearn": sklearn.__version__, "numpy": np.__version__},
              "features": FEATURES, "trainingSamples": len(train), "validationSamples": len(validation),
              "calibrationSamples": len(calibration), "validation": metrics(validation, val_scores), "test": metrics(test, test_scores),
              "controlledTest": metrics(controlled_rows, test_scores[controlled_indices]),
              "threshold": threshold,
              "limitations": [
                  "Successful operational checks are assumed normal, not independently labelled ground truth.",
                  "Anomaly recall is measured on owned HTTP fixtures with injected response delays, not production outages.",
                  "Only HTTP latency is modelled; Docker/Kubernetes state detection remains rule-based.",
                  "A service needs 20 successful baseline observations; scores are not probabilities or root-cause proof.",
                  "Time-ordered operational splits and disjoint controlled runs prevent random adjacent-row leakage.",
                  "Held-out baseline updates use prior model predictions; ground-truth fault labels never prepare features."]}
    trees = []
    for estimator in model.estimators_:
        t = estimator.tree_
        trees.append({"left": t.children_left.tolist(), "right": t.children_right.tolist(), "feature": t.feature.tolist(),
                      "threshold": t.threshold.tolist(), "samples": t.n_node_samples.tolist()})
    fingerprint = hashlib.sha256(json.dumps({"trees": trees, "threshold": threshold, "data": digest.hexdigest(), "features": FEATURES}, sort_keys=True).encode()).hexdigest()
    model_version = "latency-iforest-" + fingerprint[:12]
    report["version"] = model_version
    report["modelSha256"] = fingerprint
    bundle = {"format": 1, "version": model_version, "algorithm": "IsolationForest", "featureNames": FEATURES,
              "baselineMinimum": MIN_BASELINE, "baselineWindow": WINDOW, "maxSamples": int(model.max_samples_),
              "threshold": threshold, "datasetSha256": digest.hexdigest(), "trees": trees}
    (OUT / "model.json").write_text(json.dumps(bundle, separators=(",", ":")) + "\n")
    joblib.dump(model, OUT / "isolation_forest.joblib")
    (OUT / "metrics.json").write_text(json.dumps(report, indent=2) + "\n")
    parity_indices = list(range(min(50, len(test)))) + controlled_indices
    parity = [{"features": test[i]["features"], "score": float(test_scores[i])} for i in parity_indices]
    feature_cases = []
    for rows in groups.values():
        if len(rows) >= 25:
            baseline = [int(r["latency_ms"]) for r in rows[:20]]
            latency = int(rows[24]["latency_ms"])
            feature_cases.append({"latencyMs": latency, "history": baseline, "features": features(latency, baseline)})
    (OUT / "feature-parity.json").write_text(json.dumps(feature_cases) + "\n")
    (OUT / "parity.json").write_text(json.dumps(parity, separators=(",", ":")) + "\n")
    with (ROOT / "data" / "features.csv").open("w", newline="") as file:
        writer = csv.writer(file, lineterminator="\n")
        writer.writerow(["series_id", "sequence", "source", "split", *FEATURES, "label", "label_basis"])
        for s in samples:
            writer.writerow([s["series_id"], s["sequence"], s["source"], s["split"], *s["features"], s["label"], s["label_basis"]])
    provenance = {"dataset": "Incident Command HTTP Latency Measurements", "sha256": digest.hexdigest(),
                  "sources": {"operational": "Anonymized successful project health checks; no URLs, identifiers, credentials, messages or absolute timestamps.",
                              "controlled_http": "Measured HTTP 200 responses from an owned local fixture; explicit delays supply independent evaluation labels."},
                  "featureSchema": FEATURES, "baseline": {"minimum": MIN_BASELINE, "window": WINDOW},
                  "split": "Operational 60/20/20 chronological per series; controlled sessions 1-3 validation, 4-6 test; no controlled faults in training.",
                  "calibration": "99th percentile of successful operational validation scores; controlled labels and test data do not select the threshold.",
                  "limitations": report["limitations"]}
    (ROOT / "data" / "manifest.json").write_text(json.dumps(provenance, indent=2) + "\n")
    with zipfile.ZipFile(OUT / "IncidentCommand_ML_Dataset.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in ["operational.csv", "controlled.csv", "features.csv", "manifest.json"]:
            archive.write(ROOT / "data" / name, name)
    fig, axes = plt.subplots(1, 2, figsize=(10, 4))
    y = np.asarray([int(s["label"]) for s in controlled_rows])
    scores = test_scores[controlled_indices]
    for label, caption in [(0, "Controlled normal"), (1, "Injected delay")]:
        axes[0].hist(scores[y == label], bins=20, alpha=.7, label=caption)
    axes[0].axvline(threshold, color="black", linestyle="--", label="Validation threshold")
    axes[0].set(xlabel="Anomaly score", ylabel="Observations", title="Independent controlled test runs")
    axes[0].legend(fontsize=8)
    p, r, _ = precision_recall_curve(y, scores)
    axes[1].plot(r, p, color="#c46522")
    axes[1].set(xlabel="Recall", ylabel="Precision", title="Controlled test precision–recall", xlim=(0, 1.01), ylim=(0, 1.01))
    fig.tight_layout()
    fig.savefig(OUT / "evaluation.png", dpi=180)
    plt.close(fig)
    print(json.dumps({k: report[k] for k in ["version", "trainingSamples", "validation", "test", "controlledTest"]}, indent=2))


if __name__ == "__main__":
    main()
