import { getAutomationFetch } from "../development/automation-client.mjs";
import { runSmoke, formatSmokeFailure } from "./smoke-runtime.mjs";
import { compareRemoteEvidence } from "./consistency-runtime.mjs";
if (process.argv.length !== 2) {
  process.stderr.write(
    "FAIL step=configuration status=none code=INVALID_CONFIGURATION\n",
  );
  process.exitCode = 1;
} else {
  runSmoke({
    fetch: getAutomationFetch(),
    compare: compareRemoteEvidence,
  }).catch((error) => {
    process.stderr.write(formatSmokeFailure(error) + "\n");
    process.exitCode = 1;
  });
}
