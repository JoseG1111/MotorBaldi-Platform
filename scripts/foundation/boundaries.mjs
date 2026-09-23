import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const files = execFileSync(
  "rg",
  ["--files", "apps", "packages", "-g", "*.ts"],
  {
    encoding: "utf8",
  },
)
  .trim()
  .split("\n")
  .filter(Boolean);
const packageFiles = execFileSync(
  "find",
  [
    "apps",
    "packages",
    "-mindepth",
    "2",
    "-maxdepth",
    "2",
    "-name",
    "package.json",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
const workspaces = new Map();
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  workspaces.set(dirname(file), pkg);
}
function ownerOf(file) {
  return [...workspaces.keys()]
    .sort((a, b) => b.length - a.length)
    .find((root) => file.startsWith(root + "/"));
}
function exported(pkg, specifier) {
  const raw = specifier.replace(pkg.name, "");
  const suffix = raw ? "." + raw : ".";
  const exports = pkg.exports;
  if (!exports) return suffix === ".";
  if (typeof exports === "string") return suffix === ".";
  return Object.hasOwn(exports, suffix);
}
const edges = new Map([...workspaces.keys()].map((root) => [root, new Set()]));
const violations = [];
for (const file of files) {
  const root = ownerOf(file);
  if (!root) continue;
  const pkg = workspaces.get(root);
  const data = readFileSync(file, "utf8");
  const imports = [
    ...data.matchAll(/from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g),
  ].map((m) => m[1] ?? m[2]);
  for (const specifier of imports) {
    if (specifier.includes("packages/") || specifier.includes("apps/"))
      violations.push(`${file}: deep relative workspace import ${specifier}`);
    if (!specifier.startsWith("@motorbaldi/")) continue;
    const dependencyName =
      specifier.match(/^(@motorbaldi\/[^/]+)(?:\/.*)?$/)?.[1] ?? "";
    const depRoot = [...workspaces.entries()].find(
      ([, candidate]) => candidate.name === dependencyName,
    )?.[0];
    if (!depRoot) {
      violations.push(`${file}: unknown workspace import ${specifier}`);
      continue;
    }
    if (depRoot !== root) {
      const declared = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
      };
      if (declared[dependencyName] !== "workspace:*")
        violations.push(
          `${file}: ${dependencyName} missing workspace:* dependency`,
        );
      edges.get(root)?.add(depRoot);
    }
    const depPkg = workspaces.get(depRoot);
    if (!exported(depPkg, specifier))
      violations.push(
        `${file}: ${specifier} is not exported by ${dependencyName}`,
      );
  }
}
const visiting = new Set();
const visited = new Set();
function visit(root, stack = []) {
  if (visiting.has(root)) {
    violations.push(`workspace cycle: ${[...stack, root].join(" -> ")}`);
    return;
  }
  if (visited.has(root)) return;
  visiting.add(root);
  for (const next of edges.get(root) ?? []) visit(next, [...stack, root]);
  visiting.delete(root);
  visited.add(root);
}
for (const root of edges.keys()) visit(root);
for (const root of workspaces.keys())
  if (!existsSync(join(root, "package.json")))
    violations.push(`${root}: missing package.json`);
if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Workspace boundary checks passed");
