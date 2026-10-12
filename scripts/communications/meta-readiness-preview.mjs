export default {
  async fetch(_request, env) {
    if (env.ENVIRONMENT !== "development")
      return Response.json({ unavailable: true });
    const result = {
      version_matches: env.META_WHATSAPP_API_VERSION === "v26.0",
      template_matches:
        env.META_WHATSAPP_APPROVED_TEMPLATE ===
        "motorbaldi_recordatorio_vencimiento",
      language_matches: env.META_WHATSAPP_TEMPLATE_LANGUAGE === "es",
      general_delivery_disabled:
        env.NOTIFICATION_EXTERNAL_DELIVERY_ENABLED !== "true",
      token_present: !!env.META_WHATSAPP_ACCESS_TOKEN,
      phone_present: !!env.META_WHATSAPP_PHONE_NUMBER_ID,
    };
    const get = async (path, query = {}) => {
      try {
        const url = new URL("https://graph.facebook.com/v26.0/" + path);
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        const r = await fetch(url, {
          headers: {
            Authorization: "Bearer " + env.META_WHATSAPP_ACCESS_TOKEN,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(12000),
        });
        const b = await r.json();
        if (!r.ok || b.error) {
          const tag = path.includes("debug_token")
            ? "token"
            : path.endsWith("phone_numbers")
              ? "phone"
              : path.endsWith("subscribed_apps")
                ? "subscription"
                : "template";
          result[tag + "_http_status"] = r.status;
          if (Number.isInteger(b.error?.code))
            result[tag + "_error_code"] = b.error.code;
          return null;
        }
        return b;
      } catch (error) {
        result.fetch_error_type = [
          "TypeError",
          "Error",
          "TimeoutError",
          "AbortError",
        ].includes(error?.name)
          ? error.name
          : "OTHER";
        result.timeout_api_available =
          typeof AbortSignal.timeout === "function";
        result.invalid_header_detected = /header|newline/i.test(
          error?.message ?? "",
        );
        return null;
      }
    };
    const debug = await get("debug_token", {
      input_token: env.META_WHATSAPP_ACCESS_TOKEN,
    });
    const data = debug?.data;
    result.token_inspection_available = !!data;
    if (data) {
      result.token_valid = data.is_valid === true;
      result.correct_app = data.app_id === "2211755326884841";
      result.system_user = data.type === "SYSTEM_USER";
      result.messaging_permission =
        Array.isArray(data.scopes) &&
        data.scopes.includes("whatsapp_business_messaging");
      result.management_permission =
        Array.isArray(data.scopes) &&
        data.scopes.includes("whatsapp_business_management");
    }
    const phones = await get("3073715739631435/phone_numbers", {
      fields: "id",
      limit: "100",
    });
    result.phone_in_waba =
      Array.isArray(phones?.data) &&
      phones.data.some((p) => p.id === env.META_WHATSAPP_PHONE_NUMBER_ID);
    const apps = await get("3073715739631435/subscribed_apps", {
      limit: "100",
    });
    result.app_subscribed =
      Array.isArray(apps?.data) &&
      apps.data.some(
        (a) => a.whatsapp_business_api_data?.id === "2211755326884841",
      );
    const templates = await get("3073715739631435/message_templates", {
      name: "motorbaldi_recordatorio_vencimiento",
      fields: "name,language,status,category,components",
      limit: "100",
    });
    const rows = templates?.data?.filter(
      (t) =>
        t.name === "motorbaldi_recordatorio_vencimiento" && t.language === "es",
    );
    result.template_read_available = Array.isArray(templates?.data);
    result.template_found = rows?.length === 1;
    if (rows?.length === 1) {
      const t = rows[0];
      result.template_status = [
        "APPROVED",
        "PENDING",
        "REJECTED",
        "PAUSED",
        "DISABLED",
      ].includes(t.status)
        ? t.status
        : "OTHER";
      result.utility_template = t.category === "UTILITY";
      const body = t.components?.filter((c) => c.type === "BODY");
      result.body_parameters =
        body?.length === 1 &&
        JSON.stringify(
          [...body[0].text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1]),
        ) === JSON.stringify(["1", "2", "3"]);
    }
    try {
      await fetch("https://graph.facebook.com/v26.0/", { redirect: "error" });
      result.error_redirect_supported = true;
    } catch (e) {
      result.error_redirect_supported = false;
      result.unsupported_redirect_error = /redirect/i.test(e?.message ?? "");
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  },
};
