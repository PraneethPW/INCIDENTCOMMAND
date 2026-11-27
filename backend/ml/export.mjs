import "../dist/env.js";
import { writeFile } from "node:fs/promises";
import { pool } from "../dist/database.js";

// Export numerical, successful check measurements only. No account data, URLs,
// service names, database IDs, keys, messages or absolute timestamps are retained.
try {
  const result =
    await pool.query(`SELECT c.service_id,c.latency_ms FROM service_checks c
    JOIN services s ON s.id=c.service_id WHERE NOT s.is_test AND c.status='healthy'
    AND c.latency_ms BETWEEN 1 AND 10000 ORDER BY c.service_id,c.checked_at,c.id LIMIT 50000`);
  const groups = new Map();
  const rows = ["series_id,sequence,latency_ms,source,label,label_basis"];
  for (const r of result.rows) {
    if (!groups.has(r.service_id))
      groups.set(r.service_id, {
        name: `operational-${groups.size + 1}`,
        n: 0,
      });
    const group = groups.get(r.service_id);
    rows.push(
      [
        group.name,
        group.n++,
        r.latency_ms,
        "operational",
        0,
        "successful_check_assumed_normal",
      ].join(","),
    );
  }
  await writeFile(
    new URL("./data/operational.csv", import.meta.url),
    rows.join("\n") + "\n",
  );
  console.log(
    `Exported ${rows.length - 1} anonymized successful observations in ${groups.size} series.`,
  );
} finally {
  await pool?.end();
}
