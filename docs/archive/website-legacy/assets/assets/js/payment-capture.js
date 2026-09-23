// Direct browser-to-Wompi capture. Never persist or send card fields to MotorBaldi.
class PaymentError extends Error {}
const encoder = new TextEncoder();
const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

export async function encryptCard(card, pem) {
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")),
    (c) => c.charCodeAt(0),
  );
  const rsa = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM" })),
  );
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const wrapped = await crypto.subtle.encrypt("RSA-OAEP", rsa, cek);
  cek.fill(0);
  const plain = encoder.encode(JSON.stringify(card));
  try {
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(header),
          tagLength: 128,
        },
        aes,
        plain,
      ),
    );
    return [
      header,
      base64url(wrapped),
      base64url(iv),
      base64url(encrypted.slice(0, -16)),
      base64url(encrypted.slice(-16)),
    ].join(".");
  } finally {
    plain.fill(0);
  }
}

export function createPaymentCapture(form, dialog, status, validateCustomer) {
  const get = (id) => form.querySelector(`#${id}`);
  const button = get("payment-continue");
  const methods = [...form.querySelectorAll("[data-payment-method]")];
  const sensitive = [
    "card-number",
    "card-expiry",
    "card-cvc",
    "card-holder",
    "nequi-phone",
  ];
  get("card-expiry").addEventListener("input", (event) => {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
    event.target.value =
      digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  });
  let publicKey = "",
    method = "CARD",
    controller,
    busy = false,
    pendingNequi = null;
  const clear = () =>
    sensitive.forEach((id) => {
      get(id).value = "";
    });
  function select(value) {
    method = value;
    methods.forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.paymentMethod === value)),
    );
    get("card-fields").hidden = value !== "CARD";
    get("nequi-fields").hidden = value !== "NEQUI";
  }
  function lock(value) {
    busy = value;
    button.disabled = value || !publicKey;
    form.setAttribute("aria-busy", String(value));
    methods.forEach((b) => (b.disabled = value));
    form
      .querySelectorAll('input:not([type="hidden"])')
      .forEach((i) => (i.disabled = value));
    button.textContent = value ? "Procesando…" : "Continuar al pago";
  }
  function error(id, message) {
    get(id).setAttribute("aria-invalid", String(Boolean(message)));
    get(`${id}-error`).textContent = message;
    return !message;
  }
  function validate() {
    if (method === "NEQUI")
      return error(
        "nequi-phone",
        /^3\d{9}$/.test(get("nequi-phone").value.trim())
          ? ""
          : "Ingresa los 10 dígitos de tu celular.",
      );
    const number = get("card-number").value.replace(/[\s-]/g, "");
    let sum = 0;
    [...number].reverse().forEach((digit, index) => {
      let n = Number(digit);
      if (index % 2) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    });
    const expiry = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(get("card-expiry").value);
    const now = new Date();
    const validExpiry =
      expiry &&
      (2000 + Number(expiry[2])) * 12 + Number(expiry[1]) >=
        now.getFullYear() * 12 + now.getMonth() + 1;
    return [
      error(
        "card-number",
        /^\d{13,19}$/.test(number) && !/^0+$/.test(number) && sum % 10 === 0
          ? ""
          : "Revisa el número de tarjeta.",
      ),
      error(
        "card-expiry",
        validExpiry ? "" : "Ingresa una fecha vigente (MM/AA).",
      ),
      error(
        "card-cvc",
        /^\d{3,4}$/.test(get("card-cvc").value) ? "" : "Ingresa 3 o 4 dígitos.",
      ),
      error(
        "card-holder",
        /\p{L}/u.test(get("card-holder").value) &&
          get("card-holder").value.trim().length >= 3 &&
          !/[@:/]/.test(get("card-holder").value)
          ? ""
          : "Ingresa el nombre del titular.",
      ),
    ].every(Boolean);
  }
  async function request(path, body, signal) {
    const base = publicKey.startsWith("pub_prod_")
      ? "https://api.wompi.co/v1"
      : "https://api-sandbox.wompi.co/v1";
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${publicKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    // Provider errors may echo submitted fields: never display or log raw responses.
    if (!response.ok)
      throw new PaymentError(
        response.status === 401 || response.status === 403
          ? "Wompi no autorizó este medio. Contáctanos."
          : "Wompi no pudo autorizar el medio de pago. Revisa los datos e inténtalo de nuevo.",
      );
    const result = await response.json();
    if (!result.data)
      throw new PaymentError("Wompi no devolvió una autorización válida.");
    return result.data;
  }
  const pause = (signal) =>
    new Promise((resolve, reject) => {
      const cancel = () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelado", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", cancel);
        resolve();
      }, 2500);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
  methods.forEach((b) =>
    b.addEventListener("click", () => {
      if (!busy) {
        clear();
        pendingNequi = null;
        select(b.dataset.paymentMethod);
      }
    }),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !publicKey) return;
    if (!validateCustomer()) return;
    if (!validate()) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    lock(true);
    status.textContent = "Conectando de forma segura con Wompi…";
    let submitted = false;
    try {
      let token;
      if (method === "CARD") {
        const keyResponse = await fetch("/api/wompi-tokenization-key.php", {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        });
        if (!keyResponse.ok)
          throw new PaymentError(
            "No pudimos preparar el cifrado seguro. Inténtalo más tarde.",
          );
        const key = (await keyResponse.json()).data;
        const [exp_month, exp_year] = get("card-expiry").value.split("/");
        const card = {
          number: get("card-number").value.replace(/[\s-]/g, ""),
          cvc: get("card-cvc").value,
          exp_month,
          exp_year,
          card_holder: get("card-holder").value.trim(),
        };
        let payload;
        try {
          payload = await encryptCard(card, key.publicKey);
        } finally {
          Object.keys(card).forEach((k) => (card[k] = ""));
          clear();
        }
        token = (await request("/tokens/cards", { payload }, signal)).id;
      } else {
        const phone = get("nequi-phone").value.trim();
        let data =
          pendingNequi?.phone === phone
            ? pendingNequi.data
            : await request("/tokens/nequi", { phone_number: phone }, signal);
        if (!/^nequi_(test|prod)_[-\w]+$/.test(data.id || ""))
          throw new PaymentError("Wompi no devolvió una autorización válida.");
        pendingNequi = { phone, data };
        const deadline = Date.now() + 180000;
        while (data.status === "PENDING") {
          status.textContent =
            "Abre Nequi y aprueba la suscripción a MotorBaldi. Estamos esperando tu autorización…";
          if (Date.now() >= deadline)
            throw new PaymentError(
              "La aprobación sigue pendiente. Revisa Nequi y pulsa Continuar al pago para consultar de nuevo.",
            );
          await pause(signal);
          data = await request(
            `/tokens/nequi/${encodeURIComponent(pendingNequi.data.id)}`,
            null,
            signal,
          );
        }
        if (data.status !== "APPROVED") {
          pendingNequi = null;
          throw new PaymentError(
            "La suscripción no fue aprobada en Nequi. Puedes intentarlo de nuevo.",
          );
        }
        token = pendingNequi.data.id;
      }
      signal.throwIfAborted();
      const env = publicKey.startsWith("pub_prod_") ? "prod" : "test";
      if (
        !new RegExp(
          `^${method === "CARD" ? "tok" : "nequi"}_${env}_[-\\w]+$`,
        ).test(token || "")
      )
        throw new PaymentError(
          "Wompi no devolvió un token válido para este ambiente.",
        );
      clear();
      // An explicit allowlist prevents card fields from ever reaching our server.
      const outbound = document.createElement("form");
      outbound.method = "POST";
      outbound.action = form.action;
      for (const name of [
        "vehicle",
        "plan",
        "checkout_id",
        "full_name",
        "email",
        "accept_all",
      ]) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = form.elements.namedItem(name).value;
        outbound.append(input);
      }
      for (const [name, value] of Object.entries({
        payment_source_token: token,
        payment_source_type: method,
      })) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        outbound.append(input);
      }
      document.body.append(outbound);
      status.textContent = "Medio autorizado. Confirmando tu primer pago…";
      submitted = true;
      HTMLFormElement.prototype.submit.call(outbound);
    } catch (e) {
      if (!signal.aborted)
        status.textContent =
          e.name === "TimeoutError" || e instanceof TypeError
            ? "No pudimos conectar con Wompi. Revisa tu conexión e inténtalo de nuevo."
            : e instanceof PaymentError
              ? e.message
              : "No pudimos preparar el pago seguro. Revisa los datos e inténtalo de nuevo.";
    } finally {
      if (!submitted && controller?.signal === signal) lock(false);
    }
  });
  function reset() {
    controller?.abort();
    controller = null;
    publicKey = "";
    pendingNequi = null;
    clear();
    select("CARD");
    lock(false);
    sensitive.forEach((id) => error(id, ""));
  }
  dialog.addEventListener("close", reset);
  window.addEventListener("pagehide", reset);
  return {
    reset,
    configure(key) {
      publicKey = key;
      lock(false);
    },
  };
}
