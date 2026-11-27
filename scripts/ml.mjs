import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = fileURLToPath(new URL("../backend/ml/.venv", import.meta.url));
const python =
  env + (process.platform === "win32" ? "/Scripts/python.exe" : "/bin/python");
const [action] = process.argv.slice(2);
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
try {
  if (action === "setup") {
    let candidate;
    for (const name of [
      process.env.ML_PYTHON,
      "python3.12",
      "python3",
      "python",
    ].filter(Boolean)) {
      try {
        execFileSync(
          name,
          ["-c", "import sys; assert sys.version_info[:2] == (3,12)"],
          { stdio: "ignore" },
        );
        candidate = name;
        break;
      } catch {
        /* Try the next installed interpreter. */
      }
    }
    if (!candidate)
      throw Error(
        "Install Python 3.12 for optional ML training, or set ML_PYTHON to its executable path. Running the app does not require Python.",
      );
    run(candidate, ["-m", "venv", env]);
    run(python, ["-m", "pip", "install", "-r", "backend/ml/requirements.txt"]);
  } else {
    if (!existsSync(python))
      throw Error("Run npm run ml:setup before training or verifying weights.");
    if (!["train", "verify"].includes(action))
      throw Error("Use ml:setup, ml:train or ml:verify.");
    run(python, [`backend/ml/${action}.py`]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "ML command failed");
  process.exitCode = 1;
}
