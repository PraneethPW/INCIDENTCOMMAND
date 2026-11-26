import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("local setup bootstraps both app files, preserves configured values on repeat runs, and creates no root env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ic-local-setup-"));
  try {
    for (const dir of ["scripts", "backend", "frontend"])
      await mkdir(join(root, dir));
    for (const file of [
      "scripts/setup-local.mjs",
      "scripts/ensure-session-secret.mjs",
      "backend/.env.example",
      "frontend/.env.example",
    ])
      await copyFile(new URL("../" + file, import.meta.url), join(root, file));
    const run = () =>
      execFileSync(process.execPath, [join(root, "scripts/setup-local.mjs")], {
        cwd: tmpdir(),
        encoding: "utf8",
      });
    const output = run();
    let backend = await readFile(join(root, "backend/.env"), "utf8");
    assert.ok(/^SESSION_SECRET=[A-Za-z0-9_-]{64}$/m.test(backend));
    const frontend = await readFile(join(root, "frontend/.env"), "utf8");
    assert.ok(/^VITE_API_URL=$/m.test(frontend));
    assert.ok(!output.includes(/^SESSION_SECRET=(.*)$/m.exec(backend)[1]));
    backend =
      backend.replace(
        /^DATABASE_URL=.*$/m,
        "DATABASE_URL=preserve-my-database",
      ) + "\nCUSTOM_SETTING=preserve-me\n";
    const customizedFrontend = frontend + "\nVITE_CUSTOM_SETTING=preserve-me\n";
    await writeFile(join(root, "backend/.env"), backend);
    await writeFile(join(root, "frontend/.env"), customizedFrontend);
    run();
    assert.equal(await readFile(join(root, "backend/.env"), "utf8"), backend);
    assert.equal(
      await readFile(join(root, "frontend/.env"), "utf8"),
      customizedFrontend,
    );
    await assert.rejects(access(join(root, ".env")));
    await assert.rejects(access(join(root, ".env.example")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
