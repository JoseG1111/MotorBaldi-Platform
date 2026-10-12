"""Hidden local input only. No secret values in argv, environment, files or output."""
import getpass
import pathlib
import re
import subprocess
import sys


def main():
    root = pathlib.Path(__file__).resolve().parents[2]
    if not sys.stdin.isatty():
        raise SystemExit("Run from an interactive local terminal; never paste keys into chat.")
    bindings = {
        "WOMPI_PUBLIC_KEY": "pub_test_",
        "WOMPI_PRIVATE_KEY": "prv_test_",
        "WOMPI_INTEGRITY_SECRET": "test_integrity_",
        "WOMPI_EVENTS_SECRET": "test_events_",
    }
    values = {}
    try:
        for name, prefix in bindings.items():
            value = getpass.getpass(f"{name} (SANDBOX, hidden): ")
            if not re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9_-]{1,256}", value):
                raise SystemExit(f"{name}: Sandbox format required; no secrets were provisioned.")
            values[name] = value
        for name in bindings:
            result = subprocess.run(
                ["pnpm", "exec", "wrangler", "secret", "put", name,
                 "--config", "apps/api/wrangler.jsonc", "--env", "development"],
                cwd=root, input=values.pop(name) + "\n", text=True, capture_output=True,
            )
            if result.returncode:
                raise SystemExit(f"Could not provision {name}; check authorized Cloudflare access. Values are not displayed.")
            print(f"Provisioned {name} on Development API.")
        print("Configure the Sandbox event URL per docs/runbooks/wompi-development.md. No payment was made or verified.")
    finally:
        values.clear()


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        raise SystemExit("Provisioning cancelled; no secret values displayed.") from None
