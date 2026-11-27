# Trained HTTP latency detection

Incident Command trains a scikit-learn Isolation Forest on its own anonymized HTTP health-check measurements. The existing Node/Express backend runs the exported forest directly. Python is needed only to retrain or verify the model, not to install or run the application.

## Current model and data

The committed `artifacts/metrics.json` is the measured evaluation report, not a claimed accuracy target. It records the model version, dataset hash, library versions, training counts, validation threshold and held-out confusion matrices.

- `data/operational.csv`: 6,804 successful project health checks in seven anonymized series. These are assumed-normal observations, not independently labelled proof of normal latency.
- `data/controlled.csv`: 600 measured HTTP round trips across six owned local fixture sessions. The server returns HTTP 200 and deliberately delays selected responses. These are controlled experiments, not production Docker/Kubernetes faults.
- `data/features.csv`: prepared features, splits and evaluation labels. Short series and the first 20 baseline observations are excluded from model samples.
- `data/manifest.json`: collection provenance, feature schema, split rules and limitations.
- `artifacts/IncidentCommand_ML_Dataset.zip`: the four data/provenance files above, available from the Intelligence screen.
- `artifacts/isolation_forest.joblib`: trained scikit-learn weights for offline reproducibility.
- `artifacts/model.json`: exported tree parameters used by the backend.
- `artifacts/evaluation.png`: measured held-out controlled score distributions and precision–recall curve.

No external benchmark dataset is presented as application telemetry. No URLs, account identifiers, database IDs, credentials, messages or absolute timestamps are included in the exported measurements. Never add raw production logs or credentials to this package.

## Features and evaluation

For each observation, use up to 60 preceding successful baseline observations, with a minimum of 20. The two features are the positive log latency ratio to the baseline median and the positive log robust excess using median absolute deviation. Faster responses map to zero excess. Baseline computation never uses future observations or the current response.

Operational series use chronological 60/20/20 training/validation/test segments. All controlled observations are excluded from training. Controlled sessions 1–3 are used for validation and sessions 4–6 are held out for testing. Held-out baselines update using previous model predictions: predicted anomalies are excluded, just as in the deployed backend. Known fault labels do not select baseline observations or prepare features.

The 128-tree Isolation Forest uses a fixed seed and at most 256 training observations per tree. Its alert threshold is the 99th percentile of successful operational validation scores, moved past tied values. Controlled fault labels and test data do not select the threshold. The model version hashes its trees, threshold, feature schema and dataset hash.

The current combined held-out set has 1,597 observations, including 42 injected delays. It detected those 42 delays and flagged 14 assumed-normal operational observations: precision 75%, recall 100%, F1 approximately 85.7%. The separate 240-observation controlled test has 42 detected injected delays and zero flagged baseline observations. These results describe this dataset and deliberately injected delays; they do not establish real-world outage accuracy or root cause.

## Application behavior

Every HTTP health check records a versioned ML result alongside its availability result. Successful responses can be scored even when their HTTP status is expected. Availability failures remain governed by the original rules; they are not interpreted as normal ML recovery.

Two consecutive anomalous scored checks open one `ml-latency` incident per service. Two consecutive normal scored checks verify its recovery. Model changes reset evidence streaks. Warming up, disabled scoring, missing responses or a baseline reset do not resolve an incident. Anomaly observations are excluded from future baselines.

Changing a service's health URL or expected response status starts a new baseline. Administrators can toggle ML latency monitoring in service settings or select **Relearn baseline** in Intelligence. Baseline resets retain open incidents until new scored observations verify recovery. Preview requests are scoped to the workspace, use recorded service history, create no checks/incidents and never train the model.

Docker/Kubernetes runtime detection remains based on workload state. The LLM receives ML evidence as additional context; anomaly scores are neither calibrated probabilities nor verified root causes. The original visual theme, service availability state and manual incident workflows remain in place.

## Reproduce training

Normal installation remains `npm run install:all`, `npm run setup:local`, database setup and `npm run dev`. No extra environment file or Python service is needed.

For optional training, install Python 3.12, then from the repository root:

```bash
npm run ml:setup
npm run ml:train
npm run ml:verify
npm run build
```

The first command creates an ignored `backend/ml/.venv` and installs pinned training dependencies. `ML_PYTHON` may select an installed Python 3.12 executable; it is an optional process setting, not a new environment file. Training uses the committed frozen dataset. Review measured results and model differences before releasing new weights; the application does not retrain from untrusted incoming requests.

To deliberately refresh the dataset before retraining:

```bash
npm run ml:export
npm run ml:collect
npm run ml:train
npm run ml:verify
```

`ml:export` reads successful checks from the configured backend database, anonymizes series and caps the export at 50,000 observations. `ml:collect` executes actual HTTP requests to an owned temporary loopback fixture and closes it afterward. Existing snapshots are replaced by these explicit commands. Review exported data before committing.

Backend tests compare exported inference and feature preparation to Python reference values, test warmup and unavailable states, and exercise detection, deduplication, recovery and workspace permissions against an isolated PostgreSQL database. CI separately verifies the trained weights, dataset hashes, archive contents and held-out splits.
