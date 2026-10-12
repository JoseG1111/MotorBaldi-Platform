"""Read-only Meta preflight. Hidden input, fixed Graph host, no sends/raw responses."""
import getpass
import hashlib
import json
import re
import sys
import urllib.parse
import urllib.request

APP_ID = "2211755326884841"
WABA_ID = "3073715739631435"
VERSION = "v26.0"
TEMPLATE = "motorbaldi_recordatorio_vencimiento"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Redirect denied")


def evaluate_token(data):
    scopes = data.get("scopes", [])
    return {
        "valid": data.get("is_valid") is True,
        "correct_app": data.get("app_id") == APP_ID,
        "system_user": data.get("type") == "SYSTEM_USER",
        "messaging_permission": "whatsapp_business_messaging" in scopes,
        "management_permission": "whatsapp_business_management" in scopes,
    }


def evaluate_template(rows):
    selected = [r for r in rows if r.get("name") == TEMPLATE and r.get("language") == "es"]
    if len(selected) != 1:
        return {"found": False, "approved": False, "body_parameters": False}
    row = selected[0]
    bodies = [c for c in row.get("components", []) if c.get("type") == "BODY"]
    params = re.findall(r"\{\{\s*(\d+)\s*\}\}", bodies[0].get("text", "")) if len(bodies) == 1 else []
    return {"found": True, "approved": row.get("status") == "APPROVED",
            "utility": row.get("category") == "UTILITY",
            "body_parameters": params == ["1", "2", "3"]}


def main():
    if not sys.stdin.isatty():
        raise RuntimeError("Interactive local terminal required")
    token = getpass.getpass("Development system-user token (hidden): ")
    app_secret = getpass.getpass("Same Development app secret (hidden, for token inspection): ")
    phone_id = input("Development test phone-number ID (not a telephone number): ").strip()
    recipient = getpass.getpass("Opted-in Meta-allowlisted test recipient in +E164 (hidden): ")
    if not token or not app_secret or not re.fullmatch(r"[1-9][0-9]{0,31}", phone_id) or not re.fullmatch(r"\+[1-9][0-9]{7,14}", recipient):
        raise RuntimeError("Invalid input; no requests made")
    opener = urllib.request.build_opener(NoRedirect())

    def read(path, params, credential=token):
        query = urllib.parse.urlencode(params)
        request = urllib.request.Request(f"https://graph.facebook.com/{VERSION}/{path}?{query}",
                                         headers={"Authorization": "Bearer " + credential}, method="GET")
        with opener.open(request, timeout=15) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise RuntimeError("Response too large")
            body = json.loads(raw)
            if not isinstance(body, dict) or "error" in body:
                raise RuntimeError("Read failed")
            return body

    debug = read("debug_token", {"input_token": token}, APP_ID + "|" + app_secret)
    permissions = evaluate_token(debug.get("data", {}))
    print(json.dumps({"token": permissions}))
    if not all(permissions.values()):
        raise RuntimeError("Token type/app/permissions not verified")
    phones = read(WABA_ID + "/phone_numbers", {"fields": "id", "limit": 100})
    if not any(p.get("id") == phone_id for p in phones.get("data", [])):
        raise RuntimeError("Configured phone not confirmed in WABA")
    subscriptions = read(WABA_ID + "/subscribed_apps", {"limit": 100})
    subscribed = any(p.get("whatsapp_business_api_data", {}).get("id") == APP_ID for p in subscriptions.get("data", []))
    templates = read(WABA_ID + "/message_templates", {"name": TEMPLATE, "fields": "name,language,status,category,components", "limit": 100})
    template = evaluate_template(templates.get("data", []))
    print(json.dumps({"phone_in_waba": True, "app_subscribed": subscribed, "template": template,
                      "recipient_sha256": hashlib.sha256(recipient.encode()).hexdigest(),
                      "recipient_consent_and_meta_allowlisting": "REQUIRE_SEPARATE_EVIDENCE",
                      "message_requests": 0}))
    # Never follow provider pagination URLs or send to prove permissions/allowlisting.
    if not subscribed or not all(template.values()):
        raise RuntimeError("Subscription/template approval or parameter contract remains blocked")


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print("Preflight not verified. No messages sent; no raw provider errors or credentials displayed.", file=sys.stderr)
        sys.exit(1)
