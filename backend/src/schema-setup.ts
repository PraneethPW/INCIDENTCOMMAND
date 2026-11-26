import { setTimeout as delay } from "node:timers/promises";
import { transaction } from "./database.js";

export async function applySchema(schema: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await transaction(async (db) => {
        await db.query("SET LOCAL lock_timeout = '2s'");
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtext('incident-command-schema'))",
        );
        await db.query(schema);
      });
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (attempt === 4 || !["40P01", "55P03"].includes(code || ""))
        throw error;
      // The failed transaction has rolled back. Retry the complete schema,
      // never continue from a partially applied statement.
      console.warn("Schema setup encountered a temporary database lock; retrying.");
      await delay(250 * (attempt + 1));
    }
  }
}
