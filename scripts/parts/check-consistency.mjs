import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assessConsistency } from "./consistency-result.mjs";
const args = process.argv.slice(2);
const baseline = args.length === 1 && args[0] === "--baseline";
try {
  if (args.length && !baseline) throw new Error();
  const queries = readFileSync(
    new URL("./consistency.sql", import.meta.url),
    "utf8",
  )
    .replace(/^--[^\n]*$/gm, "")
    .trim();
  const output = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "motorbaldi-core-dev",
      "--remote",
      "--config",
      "apps/api/wrangler.jsonc",
      "--env",
      "development",
      "--command",
      queries,
      "--json",
    ],
    { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
  );
  process.stdout.write(assessConsistency(JSON.parse(output), baseline) + "\n");
} catch (error) {
  const failure = {
    INCONSISTENT_PARTS_STATE: "d1-queue-consistency",
    PARTS_EVENTS_REQUIRED: "parts-positive-evidence",
    CONSISTENCY_CHECK_UNAVAILABLE: "d1-query",
  };
  const code = Object.hasOwn(failure, error?.message)
    ? error.message
    : "CONSISTENCY_CHECK_UNAVAILABLE";
  process.stderr.write(`FAIL step=${failure[code]} code=${code}\n`);
  process.exitCode = 1;
}
