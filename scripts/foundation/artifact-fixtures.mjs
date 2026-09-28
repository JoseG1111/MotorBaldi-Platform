import { rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const dist = "dist";
const synthetic = join(dist, "synthetic-secret-fixture.js");
const secret = ["ghp", "_", "a".repeat(24)].join("");
function command(args) {
  const result = spawnSync("pnpm", args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0)
    throw new Error(
      `pnpm ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
}

rmSync(dist, { recursive: true, force: true });
const missing = spawnSync("pnpm", ["security:scan:dist"], {
  encoding: "utf8",
  stdio: "pipe",
});
assert.notEqual(missing.status, 0, "missing dist must fail scanning");
assert.match(
  missing.stderr,
  /Expected generated artifact directory is missing: dist/,
);
for (const app of ["portal", "admin", "api", "worker"])
  command([`build:${app}`]);
command(["build:environments"]);
command(["security:scan:dist"]);
try {
  writeFileSync(synthetic, `const credential = "${secret}";\n`);
  const result = spawnSync("pnpm", ["security:scan:dist"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.notEqual(result.status, 0, "a generated secret must fail scanning");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
} finally {
  unlinkSync(synthetic);
}
command(["security:scan:dist"]);
console.log("Clean artifact builds and secret scan fixtures passed");
