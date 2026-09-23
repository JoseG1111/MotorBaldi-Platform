import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const php = process.env.PHP_BINARY || "php";
const extensions = process.env.PHP_EXTENSION_DIR;
const args = [
  "-n",
  ...(extensions ? ["-d", `extension_dir=${extensions}`] : []),
  "-d",
  "extension=pdo",
  "-d",
  "extension=pdo_sqlite",
];
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "motorbaldi-payments-"));
const fixturePath = path.join(temp, "provider.json");
const db = path.join(temp, "payments.sqlite");
const env = {
  ...process.env,
  WOMPI_DB_PATH: db,
  WOMPI_PUBLIC_KEY: "pub_test_local",
  WOMPI_PRIVATE_KEY: "prv_test_local",
  WOMPI_INTEGRITY_SECRET: "test_integrity_local",
  WOMPI_EVENTS_SECRET: "test_events_local",
  WOMPI_CRON_SECRET: "local-test-cron-secret-123456789",
  WOMPI_FIXTURE_PATH: fixturePath,
};
const state = {
  sources: 0,
  charges: 0,
  next_status: "PENDING",
  transactions: {},
};
await fs.writeFile(fixturePath, JSON.stringify(state));
const sql = (query) =>
  JSON.parse(
    execFileSync(
      php,
      [
        ...args,
        "-r",
        '$db = new PDO("sqlite:" . getenv("WOMPI_DB_PATH")); echo json_encode($db->query($argv[1])->fetchAll(PDO::FETCH_ASSOC));',
        query,
      ],
      { env, encoding: "utf8" },
    ),
  );
execFileSync(php, [...args, "tests/wompi-state.php"], {
  env,
  stdio: "inherit",
});
// Keep state tests separate from endpoint scenarios.
env.WOMPI_DB_PATH = path.join(temp, "endpoint.sqlite");
const server = spawn(
  php,
  [
    ...args,
    "-d",
    `auto_prepend_file=${path.resolve("tests/wompi-provider-fixture.php")}`,
    "-S",
    "127.0.0.1:5189",
    "-t",
    ".",
  ],
  { env, stdio: ["ignore", "ignore", "pipe"] },
);
let serverLog = "";
server.stderr.on("data", (data) => {
  serverLog += data;
});
const base = "http://127.0.0.1:5189/api/";
const post = (endpoint, body, headers = {}) =>
  fetch(base + endpoint, { method: "POST", headers, body });
const checkout = async (vehicle = "car", plan = "mensual") => {
  const response = await post(
    "wompi-checkout.php",
    JSON.stringify({ vehicle, plan }),
    { "Content-Type": "application/json" },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
const subscribe = (order, token = "card-test-token", overrides = {}) =>
  post(
    "wompi-subscribe.php",
    new URLSearchParams({
      vehicle: "car",
      plan: "mensual",
      full_name: "Cliente de prueba",
      email: "test@example.com",
      accept_all: "1",
      checkout_id: order.checkoutId,
      payment_source_token: token,
      payment_source_type: "CARD",
      ...overrides,
    }),
  );
const readState = async () =>
  JSON.parse(await fs.readFile(fixturePath, "utf8"));
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(base + "wompi-checkout.php");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal((await fetch(base + "wompi-checkout.php")).status, 405);
  const encryptionKey = await fetch(base + "wompi-tokenization-key.php");
  assert.equal(encryptionKey.status, 200);
  assert.deepEqual(Object.keys((await encryptionKey.json()).data), [
    "publicKey",
  ]);
  assert.equal((await post("wompi-tokenization-key.php", "")).status, 405);
  assert.equal(
    (await post("wompi-checkout.php", '{"vehicle":"truck","plan":"free"}'))
      .status,
    400,
  );
  const order = await checkout();
  assert.equal((await checkout("car", "mensual")).amountInCents, 9990000);
  assert.equal((await checkout("car", "anual")).amountInCents, 95900000);
  assert.equal((await checkout("moto", "mensual")).amountInCents, 2990000);
  assert.equal((await checkout("moto", "anual")).amountInCents, 28800000);
  for (const vehicle of ["car", "moto"]) {
    for (const plan of ["bimestral", "trimestral", "semestral"]) {
      assert.equal(
        (await post("wompi-checkout.php", JSON.stringify({ vehicle, plan })))
          .status,
        400,
      );
    }
  }
  assert.equal(order.amountInCents, 9990000);
  assert.ok(order.checkoutId);
  assert.match(order.reference, /^REF-CAR-MENSUAL-[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(order).includes("prv_"), false);
  assert.equal(
    (
      await subscribe(order, "invalid-name-token", {
        full_name: "test@example.com",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await subscribe(order, "invalid-email-token", {
        email: "correo-invalido",
      })
    ).status,
    400,
  );
  assert.equal(
    (await subscribe(order, "missing-consent-token", { accept_all: "0" }))
      .status,
    400,
  );
  assert.equal((await subscribe(order)).status, 200);
  assert.equal((await subscribe(order)).status, 409);
  assert.equal((await subscribe(await checkout())).status, 409);
  assert.equal((await readState()).charges, 1);
  const firstTransaction = (await readState()).transactions["test-1"];
  assert.equal(firstTransaction.amount_in_cents, 9990000);
  assert.equal(firstTransaction.currency, "COP");
  assert.equal(firstTransaction.reference, order.reference);
  assert.equal(firstTransaction.recurrent, true);
  assert.deepEqual(firstTransaction.payment_method, { installments: 1 });
  assert.equal(
    firstTransaction.signature,
    createHash("sha256")
      .update(order.reference + "9990000COP" + env.WOMPI_INTEGRITY_SECRET)
      .digest("hex"),
  );
  assert.equal(sql("SELECT status FROM subscriptions")[0].status, "pending");
  console.log("OK: primer cobro y protección contra reenvío / token duplicado");
  assert.equal((await post("wompi-renew.php", "")).status, 401);
  assert.equal((await post("wompi-webhook.php", "{}")).status, 400);
  const provider = await readState();
  provider.transactions["test-1"].status = "APPROVED";
  await fs.writeFile(fixturePath, JSON.stringify(provider));
  const transaction = provider.transactions["test-1"];
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = createHash("sha256")
    .update(
      transaction.id +
        transaction.status +
        transaction.amount_in_cents +
        timestamp +
        env.WOMPI_EVENTS_SECRET,
    )
    .digest("hex");
  const event = {
    event: "transaction.updated",
    timestamp,
    data: { transaction },
    signature: {
      properties: [
        "transaction.id",
        "transaction.status",
        "transaction.amount_in_cents",
      ],
      checksum,
    },
  };
  const badEvent = structuredClone(event);
  badEvent.signature.checksum = "invalid";
  assert.equal(
    (await post("wompi-webhook.php", JSON.stringify(badEvent))).status,
    401,
  );
  assert.equal(
    (await post("wompi-webhook.php", JSON.stringify(event))).status,
    200,
  );
  assert.equal(sql("SELECT status FROM subscriptions")[0].status, "active");
  assert.equal(
    (await post("wompi-webhook.php", JSON.stringify(event))).status,
    200,
  );
  console.log("OK: webhook firmado activa el plan; firma inválida rechazada");
  sql("UPDATE subscriptions SET next_charge_at = '2020-01-01 00:00:00'");
  const cronHeaders = { "X-Cron-Secret": env.WOMPI_CRON_SECRET };
  assert.equal((await post("wompi-renew.php", "", cronHeaders)).status, 200);
  assert.equal(sql("SELECT status FROM subscriptions")[0].status, "processing");
  await post("wompi-renew.php", "", cronHeaders);
  assert.equal((await readState()).charges, 2);
  const renewed = await readState();
  renewed.transactions["test-2"].status = "APPROVED";
  await fs.writeFile(fixturePath, JSON.stringify(renewed));
  assert.equal((await post("wompi-renew.php", "", cronHeaders)).status, 200);
  assert.equal(sql("SELECT status FROM subscriptions")[0].status, "active");
  assert.equal((await readState()).charges, 2);
  console.log(
    "OK: renovación pendiente sin duplicados y recuperación de webhook perdido",
  );
  const interrupted = await readState();
  interrupted.fail_after_charge = true;
  interrupted.next_status = "APPROVED";
  await fs.writeFile(fixturePath, JSON.stringify(interrupted));
  const interruptedOrder = await checkout();
  const interruptedResponse = await subscribe(
    interruptedOrder,
    "card-second-token",
  );
  assert.equal(interruptedResponse.status, 503);
  assert.match(await interruptedResponse.text(), /antes de volver a pagar/);
  assert.equal(
    (await subscribe(interruptedOrder, "card-second-token")).status,
    409,
  );
  assert.equal((await readState()).charges, 3);
  const recovered = (await readState()).transactions["test-3"];
  const recoveryEvent = structuredClone(event);
  recoveryEvent.data.transaction = recovered;
  recoveryEvent.signature.checksum = createHash("sha256")
    .update(
      recovered.id +
        recovered.status +
        recovered.amount_in_cents +
        timestamp +
        env.WOMPI_EVENTS_SECRET,
    )
    .digest("hex");
  assert.equal(
    (await post("wompi-webhook.php", JSON.stringify(recoveryEvent))).status,
    200,
  );
  assert.equal(
    sql("SELECT status FROM subscriptions ORDER BY id DESC LIMIT 1")[0].status,
    "active",
  );
  assert.equal((await readState()).charges, 3);
  console.log(
    "OK: conexión interrumpida tras cobrar se recupera por webhook sin repetir el cobro",
  );
  const declinedState = await readState();
  declinedState.fail_after_charge = false;
  declinedState.next_status = "DECLINED";
  await fs.writeFile(fixturePath, JSON.stringify(declinedState));
  assert.equal(
    (await subscribe(await checkout(), "card-declined-token")).status,
    422,
  );
  assert.equal(
    sql("SELECT status FROM subscriptions ORDER BY id DESC LIMIT 1")[0].status,
    "past_due",
  );
  const approvedState = await readState();
  approvedState.next_status = "APPROVED";
  await fs.writeFile(fixturePath, JSON.stringify(approvedState));
  assert.equal(
    (await subscribe(await checkout(), "card-approved-token")).status,
    200,
  );
  assert.equal(
    sql("SELECT status FROM subscriptions ORDER BY id DESC LIMIT 1")[0].status,
    "active",
  );
  const nequiState = await readState();
  nequiState.next_status = "PENDING";
  await fs.writeFile(fixturePath, JSON.stringify(nequiState));
  assert.equal(
    (
      await subscribe(await checkout(), "nequi-approved-token", {
        payment_source_type: "NEQUI",
      })
    ).status,
    200,
  );
  const nequiTransaction = (await readState()).transactions["test-6"];
  assert.equal(nequiTransaction.recurrent, undefined);
  assert.equal(nequiTransaction.payment_method, undefined);
  console.log(
    "OK: respuestas aprobada, rechazada y pendiente; fuente Nequi válida",
  );
  const motoState = await readState();
  motoState.next_status = "APPROVED";
  await fs.writeFile(fixturePath, JSON.stringify(motoState));
  for (const [plan, amount] of [
    ["mensual", 2990000],
    ["anual", 28800000],
  ]) {
    const motoOrder = await checkout("moto", plan);
    assert.equal(
      (
        await subscribe(motoOrder, `card-moto-${plan}`, {
          vehicle: "moto",
          plan,
        })
      ).status,
      200,
    );
    const first = Object.values((await readState()).transactions).find(
      (t) => t.reference === motoOrder.reference,
    );
    assert.equal(first.amount_in_cents, amount);
    assert.equal(first.currency, "COP");
    assert.ok(first.payment_source_id);
    assert.equal(first.recurrent, true);
    const subscription = sql(
      "SELECT * FROM subscriptions ORDER BY id DESC LIMIT 1",
    )[0];
    sql(
      `UPDATE subscriptions SET next_charge_at = '2020-01-01 00:00:00' WHERE id = ${subscription.id}`,
    );
    assert.equal((await post("wompi-renew.php", "", cronHeaders)).status, 200);
    const renewal = Object.values((await readState()).transactions)
      .filter((t) => t.payment_source_id === first.payment_source_id)
      .at(-1);
    assert.notEqual(renewal.reference, first.reference);
    assert.equal(renewal.amount_in_cents, amount);
    assert.equal(renewal.recurrent, true);
  }
  console.log(
    "OK: Moto mensual y anual conservan monto, fuente y recurrencia en primer cobro y renovación",
  );
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  server.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
