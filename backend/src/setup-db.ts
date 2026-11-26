import "./env.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./database.js";
import { applySchema } from "./schema-setup.js";

if (!pool) throw new Error("DATABASE_URL is required in backend/.env");
const here = dirname(fileURLToPath(import.meta.url));
try {
  await applySchema(await readFile(resolve(here, "../schema.sql"), "utf8"));
} finally {
  await pool.end();
}
console.log(
  "PostgreSQL schema is ready. No sample or mock records were inserted.",
);
