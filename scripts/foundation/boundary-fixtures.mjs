import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const checker = resolve("scripts/foundation/boundaries.mjs");
const root = mkdtempSync(join(tmpdir(), "motorbaldi-boundaries-"));

function workspace(folder, name, dependencies = {}) {
  const dir = join(root, folder);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: `@motorbaldi/${name}`,
      exports: { ".": "./src/index.js", "./openapi": "./src/openapi.js" },
      dependencies,
    }),
  );
  writeFileSync(join(dir, "src/index.ts"), "export {};\n");
  return dir;
}

try {
  const testing = workspace("packages/testing", "testing");
  const db = workspace("packages/db", "db");
  const api = workspace("apps/api", "api", { "@motorbaldi/db": "workspace:*" });
  const run = () =>
    spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
  const source = (dir, value) =>
    writeFileSync(join(dir, "src/index.ts"), value);
  const pkg = (dir, name, dependencies) =>
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `@motorbaldi/${name}`,
        exports: { ".": "./src/index.js", "./openapi": "./src/openapi.js" },
        dependencies,
      }),
    );

  source(api, 'import "@motorbaldi/db";\n');
  assert.equal(run().status, 0, "app to public package API should pass");

  pkg(testing, "testing", { "@motorbaldi/api": "workspace:*" });
  source(testing, 'import "@motorbaldi/api/openapi";\n');
  assert.match(run().stderr, /packages cannot depend on apps/);
  pkg(testing, "testing", {});
  source(testing, "export {};\n");

  pkg(db, "db", { "@motorbaldi/api": "workspace:*" });
  source(db, 'import "@motorbaldi/api";\n');
  assert.match(run().stderr, /packages cannot depend on apps/);
  pkg(db, "db", {});
  source(db, "export {};\n");

  source(api, 'import "@motorbaldi/db/src/private";\n');
  assert.match(run().stderr, /not exported/);
  source(api, 'import "@motorbaldi/db";\n');

  pkg(db, "db", { "@motorbaldi/testing": "workspace:*" });
  pkg(testing, "testing", { "@motorbaldi/db": "workspace:*" });
  assert.match(run().stderr, /workspace cycle/);
  console.log("Workspace boundary fixtures passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
