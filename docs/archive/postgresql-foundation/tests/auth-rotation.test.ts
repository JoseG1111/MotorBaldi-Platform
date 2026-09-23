import { test } from "node:test";
import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { symmetricEncrypt, symmetricDecrypt } from "better-auth/crypto";
test("framework versioned keyring decrypts previous version and encrypts current", async () => {
  const previous = "fixture-previous-encryption-secret-32-characters";
  const current = "fixture-current-encryption-secret-32-characters";
  const old = await betterAuth({
    secrets: [{ version: 1, value: previous }],
    logger: { disabled: true },
  }).$context;
  const rotated = await betterAuth({
    secrets: [
      { version: 2, value: current },
      { version: 1, value: previous },
    ],
    logger: { disabled: true },
  }).$context;
  const encrypted = await symmetricEncrypt({
    key: old.secretConfig,
    data: "fixture-encrypted-mfa-data",
  });
  assert.equal(
    await symmetricDecrypt({ key: rotated.secretConfig, data: encrypted }),
    "fixture-encrypted-mfa-data",
  );
  const latest = await symmetricEncrypt({
    key: rotated.secretConfig,
    data: "fixture",
  });
  await assert.rejects(
    symmetricDecrypt({ key: old.secretConfig, data: latest }),
  );
});
