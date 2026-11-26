import "./env.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, transaction } from "./database.js";

if (!pool) throw new Error("DATABASE_URL is required in backend/.env");
const here = dirname(fileURLToPath(import.meta.url));
try {
  await transaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('incident-command-schema'))",
    );
    await db.query(await readFile(resolve(here, "../schema.sql"), "utf8"));
  });
} finally {
  await pool.end();
}
console.log(
  "PostgreSQL schema is ready. No sample or mock records were inserted.",
);
