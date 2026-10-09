import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checker = join(
  dirname(fileURLToPath(import.meta.url)),
  "execution-state.mjs",
);
const root = mkdtempSync(join(tmpdir(), "motorbaldi-execution-state-"));
const checkpoint = (id, status, dependencies) =>
  `### ${id} — Fixture\n\n- **Status:** ${status}\n- **Dependencies:** ${dependencies}\n\n`;
const base = () => [
  checkpoint("MB-P1-001", "VERIFIED", "None"),
  checkpoint("MB-P1-002", "DEFERRED — OWNER APPROVED", "MB-P1-001"),
  checkpoint("MB-P2-001", "IN PROGRESS", "MB-P1-001 (MB-P1-002 is deferred)"),
  checkpoint("MB-P2-002", "NOT STARTED", "MB-P2-001"),
];
function run(
  parts,
  current = "MB-P2-001",
  status = "IN PROGRESS",
  lastVerified = "MB-P1-001",
) {
  writeFileSync(join(root, "docs/ai/EXECUTION_PLAN.md"), parts.join(""));
  writeFileSync(
    join(root, "docs/ai/CURRENT_CHECKPOINT.md"),
    `# Current checkpoint\n\n- **Current checkpoint:** ${current} — Fixture\n- **Status:** ${status}\n- **Last verified checkpoint:** ${lastVerified} — Fixture\n`,
  );
  return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
}
function rejects(parts, expected, current, status, lastVerified) {
  const result = run(parts, current, status, lastVerified);
  assert.equal(result.status, 1);
  assert.match(result.stderr, expected);
}
try {
  mkdirSync(join(root, "docs/ai"), { recursive: true });
  assert.equal(
    run(base()).status,
    0,
    "owner deferral with independent verified prerequisite should pass",
  );
  for (const status of [
    "READY",
    "IMPLEMENTED — NOT VERIFIED",
    "BLOCKED",
    "HUMAN ACTION REQUIRED",
  ]) {
    const parts = base();
    parts[2] = checkpoint("MB-P2-001", status, "MB-P1-001");
    assert.equal(
      run(parts, "MB-P2-001", status).status,
      0,
      `${status} cursor should pass`,
    );
  }
  rejects(
    base().map((part, index) =>
      index === 3 ? checkpoint("MB-P2-002", "NOT STARTED", "MB-P9-999") : part,
    ),
    /dangling dependency/,
  );
  rejects(
    base().map((part, index) =>
      index === 0 ? checkpoint("MB-P1-001", "VERIFIED", "MB-P2-001") : part,
    ),
    /dependency cycle/,
  );
  rejects(
    base().map((part, index) =>
      index === 2 ? checkpoint("MB-P2-001", "IN PROGRESS", "MB-P2-002") : part,
    ),
    /backward dependency progression/,
  );
  rejects(
    [...base(), checkpoint("MB-P1-001", "VERIFIED", "None")],
    /duplicate checkpoint ID/,
  );
  rejects(
    base().map((part, index) =>
      index === 1 ? checkpoint("MB-P1-002", "DEFERRED", "MB-P1-001") : part,
    ),
    /unsupported status/,
  );
  rejects(
    base().map((part, index) =>
      index === 2
        ? checkpoint("MB-P2-001", "VERIFIED", "MB-P1-002")
        : index === 3
          ? checkpoint("MB-P2-002", "IN PROGRESS", "MB-P2-001")
          : part,
    ),
    /prerequisite is not VERIFIED/,
    "MB-P2-002",
  );
  rejects(
    base().map((part, index) =>
      index === 2 ? checkpoint("MB-P2-001", "IN PROGRESS", "MB-P1-002") : part,
    ),
    /prerequisite is not VERIFIED/,
  );
  rejects(base(), /checkpoint\/status mismatch/, "MB-P1-001", "VERIFIED");
  rejects(base(), /checkpoint\/status mismatch/, "MB-P2-001", "READY");
  rejects(
    base().map((part, index) =>
      index === 3 ? checkpoint("MB-P2-002", "READY", "MB-P1-001") : part,
    ),
    /exactly one active\/boundary/,
  );
  rejects(
    base().map((part, index) =>
      index === 1 ? checkpoint("MB-P1-002", "NOT STARTED", "MB-P1-001") : part,
    ),
    /earliest eligible/,
  );
  rejects(
    base().map((part, index) =>
      index === 2
        ? part.replace(
            "- **Status:** IN PROGRESS",
            "- **Status:** IN PROGRESS\n- **Status:** READY",
          )
        : part,
    ),
    /expected one Status field/,
  );
  const complete = [
    checkpoint("MB-P1-001", "VERIFIED", "None"),
    checkpoint("MB-P1-002", "DEFERRED — OWNER APPROVED", "MB-P1-001"),
    checkpoint("MB-P2-001", "VERIFIED", "MB-P1-001"),
  ];
  assert.equal(
    run(complete, "MB-P2-001", "VERIFIED", "MB-P2-001").status,
    0,
    "completed executable registry with retained owner deferral should pass",
  );
  assert.equal(
    run([complete[0]], "MB-P1-001", "VERIFIED").status,
    0,
    "single verified terminal should pass",
  );
  rejects(
    base(),
    /unknown last verified checkpoint/,
    undefined,
    undefined,
    "MB-P9-999",
  );
  rejects(
    base(),
    /last verified checkpoint is not VERIFIED/,
    undefined,
    undefined,
    "MB-P1-002",
  );
  rejects(
    base(),
    /last verified checkpoint is not VERIFIED/,
    undefined,
    undefined,
    "MB-P2-001",
  );
  rejects(
    base(),
    /expected one Last verified checkpoint field/,
    undefined,
    undefined,
    "MB-P1-001 — Fixture\n- **Last verified checkpoint:** MB-P1-001",
  );
  rejects(
    base().map((part, index) =>
      index === 2 ? checkpoint("MB-P2-001", "NOT STARTED", "MB-P1-001") : part,
    ),
    /exactly one active\/boundary/,
    "MB-P1-001",
    "VERIFIED",
  );
  rejects(
    [
      complete[0],
      complete[1],
      checkpoint("MB-P2-001", "NOT STARTED", "MB-P1-002"),
    ],
    /exactly one active\/boundary/,
    "MB-P1-001",
    "VERIFIED",
  );
  rejects(complete, /VERIFIED terminal checkpoint/, "MB-P1-001", "VERIFIED");
  rejects(
    complete,
    /VERIFIED terminal checkpoint/,
    "MB-P1-002",
    "DEFERRED — OWNER APPROVED",
  );
  rejects(complete, /VERIFIED terminal checkpoint/, "MB-P2-001", "READY");
  console.log(
    "Execution state fixtures passed (deferral/boundary/completion states and 21 rejection scenarios).",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
