import { useEffect, useState } from "react";
import { Activity, Download, FlaskConical, RefreshCw } from "lucide-react";
import { api, mlDatasetUrl, mlEvaluationUrl } from "./api";
import { Dialog } from "./Operations";
import type { MlModel, MlResult, Service, User } from "./types";

import { MlSignal } from "./MlSignal";
export function TrainedMlPanel({
  services,
  user,
  onRefresh,
}: {
  services: Service[];
  user: User;
  onRefresh: () => Promise<void>;
}) {
  const [model, setModel] = useState<MlModel | null>(null);
  const [error, setError] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [latency, setLatency] = useState("1000");
  const [preview, setPreview] = useState<MlResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState<Service | null>(null);
  const http = services.filter((s) => s.healthUrl);
  const selected = http.find((s) => s.id === serviceId) || http[0];
  async function load() {
    try {
      setModel(await api.mlModel());
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to load the trained model.",
      );
    }
  }
  // Fetch model provenance from the authenticated backend when this surface opens.
  useEffect(() => {
    void Promise.resolve().then(load);
  }, []);
  async function testPreview() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      setPreview(await api.mlPreview(selected.id, Number(latency)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not score the preview.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="panel trained-ml-panel">
      <div className="ml-panel-heading">
        <div>
          <span className="runtime-kicker">TRAINED MACHINE LEARNING</span>
          <h2>Spot unusual response times.</h2>
          <p>
            The backend scores successful HTTP checks using a trained Isolation
            Forest. Two consecutive anomalies open a latency incident; two
            scored normal checks verify recovery.
          </p>
        </div>
        <Activity size={32} />
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>
      )}
      {!model ? (
        <p role="status">Loading model information…</p>
      ) : (
        <>
          <div className="ml-model-facts">
            <div>
              <small>ALGORITHM</small>
              <b>{model.algorithm}</b>
            </div>
            <div>
              <small>TRAINING OBSERVATIONS</small>
              <b>{model.trainingSamples.toLocaleString()}</b>
            </div>
            <div>
              <small>CALIBRATED THRESHOLD</small>
              <b>{model.threshold.toFixed(3)}</b>
            </div>
            <div>
              <small>TRAINED</small>
              <b>{new Date(model.trainedAt).toLocaleDateString()}</b>
            </div>
          </div>
          <p className="ml-scope-note">
            HTTP latency model · anomaly scores are not probabilities or proof
            of root cause. Docker and Kubernetes state detection continues
            through their runtime observations.
          </p>
          <div className="ml-service-grid">
            {http.map((s) => (
              <div className="ml-service-state" key={s.id}>
                <div>
                  <b>{s.name}</b>
                  {s.ml ? (
                    <MlSignal value={s.ml} />
                  ) : (
                    <small>Awaiting the next health check</small>
                  )}
                </div>
                {s.ml && <p>{s.ml.explanation}</p>}
                {s.ml?.score !== undefined && (
                  <small>
                    Score {s.ml.score.toFixed(3)} / threshold{" "}
                    {s.ml.threshold.toFixed(3)} · last response {s.ml.latencyMs}{" "}
                    ms · baseline median {s.ml.baselineMedianMs} ms
                  </small>
                )}
                {["owner", "admin"].includes(user.role) && (
                  <button
                    className="ml-text-action"
                    onClick={() => setReset(s)}
                  >
                    Relearn baseline
                  </button>
                )}
              </div>
            ))}
          </div>
          {!http.length && (
            <p className="ml-scope-note">
              Connect an HTTP health endpoint in Services to begin. Each service
              needs {model.baselineMinimum} prior successful observations before
              it can be scored.
            </p>
          )}
          {http.length > 0 && user.role !== "viewer" && (
            <form
              className="ml-preview-form"
              onSubmit={(e) => {
                e.preventDefault();
                void testPreview();
              }}
            >
              <div>
                <FlaskConical size={18} />
                <b>Preview a response time</b>
                <p>
                  Uses the service's recorded baseline. Preview values are not
                  saved and create no incidents.
                </p>
              </div>
              <label>
                Service
                <select
                  aria-label="ML preview service"
                  value={selected?.id || ""}
                  onChange={(e) => {
                    setServiceId(e.target.value);
                    setPreview(null);
                  }}
                >
                  {http.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Latency in milliseconds
                <input
                  aria-label="ML preview latency"
                  type="number"
                  min="0"
                  max="600000"
                  required
                  value={latency}
                  onChange={(e) => {
                    setLatency(e.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <button className="primary-button compact" disabled={busy}>
                <RefreshCw size={14} />
                {busy ? "Scoring…" : "Run ML preview"}
              </button>
              {preview && (
                <div className="ml-preview-result" role="status">
                  <MlSignal value={preview} />
                  <p>{preview.explanation}</p>
                  {preview.score !== undefined && (
                    <b>
                      Score {preview.score.toFixed(3)} · threshold{" "}
                      {preview.threshold.toFixed(3)}
                    </b>
                  )}
                </div>
              )}
            </form>
          )}
          <details className="ml-validation">
            <summary>Model training, dataset and measured evaluation</summary>
            <p>
              Model version: <code>{model.version}</code>. Trained on anonymized
              successful HTTP check measurements. Controlled fault observations
              were held out from training.
            </p>
            <div className="ml-validation-results">
              <p>
                <b>Controlled held-out HTTP trials</b>
                <span>
                  {model.controlledTest.confusion.tp}/
                  {model.controlledTest.confusion.tp +
                    model.controlledTest.confusion.fn}{" "}
                  injected delays detected · {model.controlledTest.confusion.fp}{" "}
                  baseline responses flagged.
                </span>
              </p>
              <p>
                <b>Combined held-out measurements</b>
                <span>
                  Precision {(model.test.precision * 100).toFixed(1)}% · recall{" "}
                  {(model.test.recall * 100).toFixed(1)}%. Successful
                  operational checks are assumed normal, not independently
                  labelled.
                </span>
              </p>
            </div>
            <ul>
              {model.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <a className="ml-download" href={mlDatasetUrl}>
              <Download size={15} /> Download training dataset ZIP
            </a>
            <img
              src={mlEvaluationUrl}
              loading="lazy"
              alt="Held-out controlled HTTP latency score distributions and precision-recall evaluation"
            />
          </details>
        </>
      )}
      {reset && (
        <Dialog
          title="Relearn latency baseline"
          onClose={() => {
            if (!busy) setReset(null);
          }}
        >
          <div className="command-form">
            <p>
              Start a new baseline for {reset.name}? The next 20 successful
              checks establish its reference. Existing latency incidents stay
              open until scored checks verify recovery.
            </p>
            <button
              className="primary-button compact"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api.resetMlBaseline(reset.id);
                  setReset(null);
                  await onRefresh();
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not reset the baseline.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Start new baseline
            </button>
          </div>
        </Dialog>
      )}
    </article>
  );
}
