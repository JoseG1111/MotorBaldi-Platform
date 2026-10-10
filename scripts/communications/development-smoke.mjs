// Development only: credentials enter through stdin and are never persisted.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runSmoke, formatSmokeFailure } from "./smoke-runtime.mjs";
export { runSmoke, formatSmokeFailure } from "./smoke-runtime.mjs";
export async function cli(
  args = process.argv.slice(2),
  readCookie = () => readFileSync(0, "utf8").trim(),
) {
  const anonymous = args.includes("--anonymous"),
    verifyOnly = args.includes("--verify-only");
  if (
    args.some((arg) => !["--anonymous", "--verify-only"].includes(arg)) ||
    (anonymous && verifyOnly)
  ) {
    console.error(
      "Choose --anonymous, --verify-only, or authenticated smoke without flags.",
    );
    return 1;
  }
  try {
    const cookie = anonymous ? "" : readCookie();
    if (!anonymous && (!cookie || /[\r\n]/.test(cookie))) {
      console.error(
        "Existing assured Development session cookie required through stdin only.",
      );
      return 1;
    }
    await runSmoke({ cookie, anonymous, verifyOnly });
    return 0;
  } catch (error) {
    console.error(formatSmokeFailure(error));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await cli();
