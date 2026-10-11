import { getAutomationFetch } from "../development/automation-client.mjs";
import { runSmoke, formatSmokeFailure } from "./smoke-runtime.mjs";
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--anonymous") || args.length > 1) {
  process.stderr.write("FAIL step=configuration code=INVALID_CONFIGURATION\n");
  process.exitCode = 1;
} else {
  runSmoke({
    anonymous: args.includes("--anonymous"),
    fetch: getAutomationFetch(),
  }).catch((error) => {
    process.stderr.write(formatSmokeFailure(error) + "\n");
    process.exitCode = 1;
  });
}
