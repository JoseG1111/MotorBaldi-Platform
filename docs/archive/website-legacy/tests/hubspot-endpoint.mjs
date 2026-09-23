import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

const phpBinary = process.env.PHP_BIN;
const curlExtension = process.env.PHP_CURL_EXTENSION;
if (!phpBinary || !curlExtension) {
  throw new Error("Define PHP_BIN and PHP_CURL_EXTENSION to run this test.");
}

const hubspotRequests = [];
let contactExists = false;
const mockHubspot = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = body ? JSON.parse(body) : null;
  hubspotRequests.push({ method: request.method, url: request.url, payload });
  assert.equal(request.headers.authorization, "Bearer test-token");

  if (request.method === "GET" && request.url.includes("/contacts/")) {
    response.writeHead(contactExists ? 200 : 404, {
      "Content-Type": "application/json",
    });
    response.end(contactExists ? JSON.stringify({ id: "contact-1" }) : "{}");
    return;
  }
  if (request.method === "POST" && request.url.endsWith("/contacts")) {
    contactExists = true;
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "contact-1" }));
    return;
  }
  if (request.method === "PATCH" && request.url.endsWith("/contact-1")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "contact-1" }));
    return;
  }
  if (request.method === "POST" && request.url.endsWith("/deals")) {
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "deal-1" }));
    return;
  }
  response.writeHead(404).end();
});
mockHubspot.listen(0, "127.0.0.1");
await once(mockHubspot, "listening");
const hubspotPort = mockHubspot.address().port;

const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const phpPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const php = spawn(
  phpBinary,
  ["-d", `extension=${curlExtension}`, "-S", `127.0.0.1:${phpPort}`, "-t", "."],
  {
    env: {
      ...process.env,
      MOTORBALDI_HUBSPOT_TOKEN: "test-token",
      MOTORBALDI_HUBSPOT_PIPELINE: "default",
      MOTORBALDI_HUBSPOT_STAGE: "1433840728",
      MOTORBALDI_HUBSPOT_API_BASE: `http://127.0.0.1:${hubspotPort}`,
      TMPDIR: process.env.PHP_TEST_TMP || process.env.TMPDIR,
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
let phpErrors = "";
php.stderr.on("data", (chunk) => {
  phpErrors += chunk;
});

try {
  const endpoint = `http://127.0.0.1:${phpPort}/api/hubspot.php`;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(endpoint);
      if (response.status === 405) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const validPayload = {
    name: "Ana Motor",
    email: "ana@example.com",
    phone: "+57 300 123 4567",
    vehicle: "Automóvil",
    service: "Mantenimiento",
    details: "Quiero programar mantenimiento preventivo.",
    consent: true,
    company_website: "",
  };
  const submit = () =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${phpPort}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(validPayload),
    });

  const created = await submit();
  const createdText = await created.text();
  let createdPayload;
  try {
    createdPayload = JSON.parse(createdText);
  } catch {
    throw new Error(`${createdText}\n${phpErrors}`);
  }
  assert.equal(created.status, 201, JSON.stringify(createdPayload));
  assert.deepEqual(createdPayload, { ok: true });
  assert.equal(hubspotRequests[0].method, "GET");
  assert.equal(hubspotRequests[1].method, "POST");
  assert.equal(hubspotRequests[2].method, "POST");
  assert.equal(hubspotRequests[2].payload.properties.pipeline, "default");
  assert.equal(hubspotRequests[2].payload.properties.dealstage, "1433840728");
  assert.match(
    hubspotRequests[2].payload.properties.description,
    /Consentimiento de privacidad: aceptado/,
  );
  assert.equal(
    hubspotRequests[2].payload.associations[0].types[0].associationTypeId,
    3,
  );

  const updated = await submit();
  assert.equal(updated.status, 201);
  assert.equal(hubspotRequests[3].method, "GET");
  assert.equal(hubspotRequests[4].method, "PATCH");
  assert.equal(hubspotRequests[5].method, "POST");

  const beforeInvalid = hubspotRequests.length;
  const invalid = await fetch(endpoint, {
    method: "POST",
    headers: {
      Origin: `http://127.0.0.1:${phpPort}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...validPayload, email: "incorrecto" }),
  });
  assert.equal(invalid.status, 422);
  assert.equal(hubspotRequests.length, beforeInvalid);

  const forbidden = await fetch(endpoint, {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(validPayload),
  });
  assert.equal(forbidden.status, 403);
  console.log(
    "Endpoint HubSpot: creación, actualización, negocio y validación correctos.",
  );
} finally {
  php.kill();
  mockHubspot.close();
}
