import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Paths follow the checkout, including when invoked from another working directory.
for (const app of ["backend", "frontend"]) {
  const destination = new URL(`../${app}/.env`, import.meta.url);
  const template = await readFile(
    new URL(`../${app}/.env.example`, import.meta.url),
  );
  try {
    await writeFile(destination, template, { flag: "wx", mode: 0o600 });
    console.log(`Created ${app}/.env.`);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log(`Kept existing ${app}/.env.`);
  }
}
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./ensure-session-secret.mjs", import.meta.url))],
  { stdio: "inherit" },
);
console.log(
  "Set DATABASE_URL and your optional OPENROUTER_API_KEY in backend/.env.",
);
console.log("For a local backend, leave VITE_API_URL= blank in frontend/.env.");
console.log("Then run: npm run db:setup --prefix backend");
console.log("Start both apps: npm run dev → http://localhost:5173");
