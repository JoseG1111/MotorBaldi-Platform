import { getAutomationFetch } from "../development/automation-client.mjs";
import { runSmoke, formatSmokeFailure } from "./smoke-runtime.mjs";
const args = process.argv.slice(2);
if (
  args.some((arg) => !["--anonymous", "--verify-only"].includes(arg)) ||
  (args.includes("--anonymous") && args.includes("--verify-only"))
) {
  process.stderr.write("FAIL step=configuration code=INVALID_CONFIGURATION\n");
  process.exitCode = 1;
} else {
  const anonymous = args.includes("--anonymous");
  Promise.resolve()
    .then(() =>
      runSmoke({
        anonymous,
        verifyOnly: args.includes("--verify-only"),
        automation: !anonymous,
        fetch: getAutomationFetch(),
      }),
    )
    .catch((error) => {
      process.stderr.write(formatSmokeFailure(error) + "\n");
      process.exitCode = 1;
    });
}
