import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const apps = ["api", "worker", "portal", "admin"];
const environments = ["development", "staging", "production"];
const args = process.argv.slice(2);
if (
  args.length !== 1 ||
  (args[0] !== "--environments" && !apps.includes(args[0]))
) {
  console.error(
    "Usage: node scripts/foundation/build.mjs <app|--environments>",
  );
  process.exit(2);
}
const targets =
  args[0] === "--environments"
    ? apps.flatMap((app) =>
        environments.map((environment) => [app, environment]),
      )
    : [[args[0], null]];
for (const [app, environment] of targets) {
  // Wrangler resolves relative outdirs from the manifest directory. Explicit absolute
  // paths keep every executable inside the same root inventory that security scans.
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      resolve(root, "apps", app, "wrangler.jsonc"),
      ...(environment ? ["--env", environment] : []),
      "--dry-run",
      "--outdir",
      resolve(root, "dist", app + (environment ? "-" + environment : "")),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_HIDE_BANNER: "true",
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true",
      },
    },
  );
  if (result.error || result.status !== 0) {
    console.error(
      "Local dry-run build failed for " +
        app +
        (environment ? "-" + environment : ""),
    );
    process.exit(1);
  }
}
