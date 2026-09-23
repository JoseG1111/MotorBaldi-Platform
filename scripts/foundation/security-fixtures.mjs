import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "motorbaldi-secret-fixtures-"));
try {
  const github = "github_pat_" + "A".repeat(24);
  const wompi = "prv_test_" + "B".repeat(24);
  const privateKey = "-----BEGIN PRIVATE KEY-----";
  writeFileSync(
    join(dir, "fixtures.txt"),
    [github, wompi, privateKey].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/foundation/security.mjs", dir],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Potential secrets in:"));
  assert.ok(!result.stderr.includes(github));
  assert.ok(!result.stderr.includes(wompi));
  assert.ok(!result.stderr.includes(privateKey));
  console.log("Synthetic secret fixtures detected without value disclosure");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
