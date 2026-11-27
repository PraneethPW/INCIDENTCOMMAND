import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

// Real HTTP round trips against an owned local fixture. Delays are intentionally
// controlled; this is evaluation data, never claimed to be production outages.
const server = createServer((req, res) => {
  const delay = Number(
    new URL(req.url, "http://fixture").searchParams.get("delay"),
  );
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  }, delay);
}).listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const rows = ["series_id,sequence,latency_ms,source,label,label_basis"];
try {
  for (let session = 0; session < 6; session++) {
    for (let n = 0; n < 100; n++) {
      const fault = n >= 30 && n % 5 === 0;
      const duration = fault
        ? 100 + (session % 3) * 60
        : 4 + ((n * 7 + session * 3) % 7);
      const start = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/?delay=${duration}`,
      );
      await response.arrayBuffer();
      const measured = Math.max(1, Math.round(performance.now() - start));
      rows.push(
        [
          `controlled-${session + 1}`,
          n,
          measured,
          "controlled_http",
          Number(fault),
          fault ? "injected_response_delay" : "baseline_response",
        ].join(","),
      );
    }
    console.log(`Measured controlled HTTP session ${session + 1}/6.`);
  }
  await writeFile(
    new URL("./data/controlled.csv", import.meta.url),
    rows.join("\n") + "\n",
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
