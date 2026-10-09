import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const statuses = new Set([
  "NOT STARTED",
  "READY",
  "IN PROGRESS",
  "IMPLEMENTED — NOT VERIFIED",
  "VERIFIED",
  "BLOCKED",
  "HUMAN ACTION REQUIRED",
  "SKIPPED — WITH REASON",
  "DEFERRED — OWNER APPROVED",
]);
const activeStatuses = new Set([
  "READY",
  "IN PROGRESS",
  "IMPLEMENTED — NOT VERIFIED",
  "BLOCKED",
  "HUMAN ACTION REQUIRED",
]);
const errors = [];
const fail = (message) => errors.push(message);
// Read only structural fields; never echo arbitrary document contents.
function field(body, name, context) {
  const matches = [
    ...body.matchAll(new RegExp(`^- \\*\\*${name}:\\*\\* (.*)$`, "gm")),
  ];
  if (matches.length !== 1) fail(`${context}: expected one ${name} field`);
  return matches[0]?.[1].trim() ?? "";
}

try {
  const plan = readFileSync(join(root, "docs/ai/EXECUTION_PLAN.md"), "utf8");
  const cursor = readFileSync(
    join(root, "docs/ai/CURRENT_CHECKPOINT.md"),
    "utf8",
  );
  const headings = [...plan.matchAll(/^### (MB-[A-Z0-9]+-\d{3}) — .+$/gm)];
  if (!headings.length) fail("registry: no checkpoints found");
  const checkpoints = headings.map((heading, index) => {
    const id = heading[1];
    const body = plan.slice(
      heading.index + heading[0].length,
      headings[index + 1]?.index ?? plan.length,
    );
    const status = field(body, "Status", id);
    if (!statuses.has(status)) fail(`${id}: unsupported status`);
    // Parenthetical explanations can mention other checkpoints without declaring dependencies.
    const dependencyField = field(body, "Dependencies", id)
      .split("(")[0]
      .trim();
    const dependencies =
      dependencyField === "None"
        ? []
        : dependencyField.split(",").map((part) => part.trim());
    if (dependencies.some((dep) => !/^MB-[A-Z0-9]+-\d{3}$/.test(dep)))
      fail(`${id}: malformed dependencies`);
    if (new Set(dependencies).size !== dependencies.length)
      fail(`${id}: duplicate dependency`);
    return { id, index, status, dependencies };
  });
  const byId = new Map();
  for (const checkpoint of checkpoints) {
    if (byId.has(checkpoint.id))
      fail(`${checkpoint.id}: duplicate checkpoint ID`);
    byId.set(checkpoint.id, checkpoint);
  }
  for (const checkpoint of checkpoints) {
    for (const dependency of checkpoint.dependencies) {
      const prerequisite = byId.get(dependency);
      if (!prerequisite) fail(`${checkpoint.id}: dangling dependency`);
      else {
        if (prerequisite.index >= checkpoint.index)
          fail(`${checkpoint.id}: backward dependency progression`);
        if (
          (checkpoint.status === "VERIFIED" ||
            activeStatuses.has(checkpoint.status)) &&
          prerequisite.status !== "VERIFIED"
        ) {
          fail(`${checkpoint.id}: prerequisite is not VERIFIED`);
        }
      }
    }
  }
  const visited = new Set();
  const visiting = new Set();
  function visit(checkpoint) {
    if (visiting.has(checkpoint.id)) {
      fail(`${checkpoint.id}: dependency cycle`);
      return;
    }
    if (visited.has(checkpoint.id)) return;
    visiting.add(checkpoint.id);
    for (const dependency of checkpoint.dependencies)
      if (byId.has(dependency)) visit(byId.get(dependency));
    visiting.delete(checkpoint.id);
    visited.add(checkpoint.id);
  }
  checkpoints.forEach(visit);
  const currentField = field(cursor, "Current checkpoint", "cursor");
  const currentId = /^([A-Z0-9]+-[A-Z0-9]+-\d{3})(?: — .+)?$/.exec(
    currentField,
  )?.[1];
  const cursorStatus = field(cursor, "Status", "cursor");
  const lastVerifiedField = field(cursor, "Last verified checkpoint", "cursor");
  const lastVerifiedId = /^(MB-[A-Z0-9]+-\d{3})(?: — .+)?$/.exec(
    lastVerifiedField,
  )?.[1];
  if (!lastVerifiedId || !byId.has(lastVerifiedId))
    fail("cursor: unknown last verified checkpoint");
  else if (byId.get(lastVerifiedId).status !== "VERIFIED")
    fail("cursor: last verified checkpoint is not VERIFIED");
  const active = checkpoints.filter((checkpoint) =>
    activeStatuses.has(checkpoint.status),
  );
  const completed =
    active.length === 0 &&
    checkpoints.length > 0 &&
    checkpoints.every((checkpoint) =>
      [
        "VERIFIED",
        "SKIPPED — WITH REASON",
        "DEFERRED — OWNER APPROVED",
      ].includes(checkpoint.status),
    );
  if (active.length !== 1 && !completed)
    fail("registry: expected exactly one active/boundary checkpoint");
  if (!currentId || !byId.has(currentId)) fail("cursor: unknown checkpoint");
  else if (completed) {
    if (
      cursorStatus !== "VERIFIED" ||
      byId.get(currentId).status !== "VERIFIED" ||
      checkpoints.some((checkpoint) =>
        checkpoint.dependencies.includes(currentId),
      )
    )
      fail(
        "cursor: completed registry requires a VERIFIED terminal checkpoint",
      );
  } else if (
    active[0]?.id !== currentId ||
    byId.get(currentId).status !== cursorStatus
  )
    fail("cursor: checkpoint/status mismatch");
  const earliestEligible = checkpoints.find(
    (checkpoint) =>
      (checkpoint.status === "NOT STARTED" ||
        activeStatuses.has(checkpoint.status)) &&
      checkpoint.dependencies.every(
        (dependency) => byId.get(dependency)?.status === "VERIFIED",
      ),
  );
  if (earliestEligible && earliestEligible.id !== currentId)
    fail("cursor: not the earliest eligible checkpoint");
} catch {
  fail("execution state: unable to read or parse required Markdown files");
}

if (errors.length) {
  console.error(
    `Execution state invalid (${errors.length} issue(s)):\n${errors
      .slice(0, 20)
      .map((error) => `- ${error}`)
      .join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Execution state valid.");
}
