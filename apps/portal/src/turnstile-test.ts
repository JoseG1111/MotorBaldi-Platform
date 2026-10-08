const escapeAttribute = (value: string) =>
  value.replace(
    /[&"<>']/g,
    (character) =>
      ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;", "'": "&#39;" })[
        character
      ]!,
  );

export const turnstileTestCsp =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; base-uri 'none'; form-action 'self'";

// The development sitekey must belong to a Managed widget; Cloudflare sets widget mode at provisioning.
export function turnstileTestPage(siteKey: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prueba de Turnstile | MotorBaldi</title><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="/turnstile-test.js" defer></script></head><body><main><h1>Prueba de recepción de clientes potenciales</h1><p>Formulario de prueba de desarrollo. Se requiere correo electrónico o teléfono.</p><form id="lead-test-form"><label>Nombre <input name="givenName" maxlength="120"></label><br><label>Apellido <input name="familyName" maxlength="120"></label><br><label>Correo electrónico <input name="email" type="email" maxlength="320"></label><br><label>Teléfono <input name="phone" type="tel" maxlength="40"></label><br><label>Organización <input name="organizationName" maxlength="240"></label><br><label>Mensaje <textarea name="message" maxlength="2000"></textarea></label><br><label>Código de país <input name="countryCode" maxlength="2" pattern="[A-Za-z]{2}" placeholder="CO"></label><div class="cf-turnstile" data-sitekey="${escapeAttribute(siteKey)}" data-action="lead"></div><button type="submit">Enviar prueba</button></form><p id="lead-test-status" role="status" aria-live="polite"></p></main></body></html>`;
}

export const turnstileTestScript = `(() => {
  const form = document.getElementById('lead-test-form');
  const status = document.getElementById('lead-test-status');
  const fields = ['givenName', 'familyName', 'email', 'phone', 'organizationName', 'message', 'countryCode'];
  let retainedKey = null;
  let retainedRequest = null;
  let submitting = false;
  function lead() {
    const data = new FormData(form);
    const result = {};
    for (const field of fields) {
      const value = String(data.get(field) || '').trim();
      if (value) result[field] = field === 'countryCode' ? value.toUpperCase() : value;
    }
    return result;
  }
  form.addEventListener('input', () => {
    if (retainedRequest !== null && JSON.stringify(lead()) !== retainedRequest) {
      retainedKey = null;
      retainedRequest = null;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    try {
      const request = lead();
      if (!request.email && !request.phone) {
        status.textContent = 'Ingresa un correo electrónico o un teléfono.';
        return;
      }
      const token = window.turnstile?.getResponse() || '';
      if (!token) {
        status.textContent = 'Completa la verificación de Turnstile.';
        return;
      }
      const logicalRequest = JSON.stringify(request);
      if (logicalRequest !== retainedRequest) {
        retainedKey = crypto.randomUUID();
        retainedRequest = logicalRequest;
      }
      const response = await fetch('/api/v1/public/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': retainedKey },
        body: JSON.stringify({ ...request, turnstileToken: token }),
      });
      if (response.status === 202) {
        form.reset();
        retainedKey = null;
        retainedRequest = null;
        status.textContent = 'Solicitud recibida.';
      } else {
        status.textContent = 'No se pudo enviar la solicitud. Intenta de nuevo con una nueva verificación.';
      }
    } catch {
      status.textContent = 'No se pudo enviar la solicitud. Intenta de nuevo con una nueva verificación.';
    } finally {
      window.turnstile?.reset();
      submitting = false;
    }
  });
})();`;
