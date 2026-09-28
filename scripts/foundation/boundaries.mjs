import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";

if (process.argv[2]) process.chdir(process.argv[2]);

const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  ".git",
  ".wrangler",
  "coverage",
]);
const sourceFile = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const workspaceRoots = ["apps", "packages"];
const relativePath = (...parts) =>
  join(...parts)
    .split(sep)
    .join("/");
const files = [];
const packageFiles = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        walk(relativePath(directory, entry.name));
    } else if (entry.isFile() && sourceFile.test(entry.name)) {
      files.push(relativePath(directory, entry.name));
    }
  }
}

for (const top of workspaceRoots) {
  for (const entry of readdirSync(top, { withFileTypes: true })) {
    if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
    const root = relativePath(top, entry.name);
    const manifest = relativePath(root, "package.json");
    if (existsSync(manifest)) packageFiles.push(manifest);
    walk(root);
  }
}
files.sort();
packageFiles.sort();
const workspaces = new Map();
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  workspaces.set(dirname(file), pkg);
}
const rootsByName = new Map(
  [...workspaces].map(([root, pkg]) => [pkg.name, root]),
);
const isPackage = (root) => root.startsWith("packages/");
const isApp = (root) => root.startsWith("apps/");
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
function checkDirection(source, target, location) {
  if (isPackage(source) && isApp(target))
    violations.push(
      `${location}: packages cannot depend on apps (${source} -> ${target})`,
    );
}
for (const [root, pkg] of workspaces) {
  const declared = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
  };
  for (const name of Object.keys(declared)) {
    const target = rootsByName.get(name);
    if (target) {
      checkDirection(root, target, join(root, "package.json"));
      if (target !== root) edges.get(root)?.add(target);
    }
  }
}
for (const file of files) {
  const root = ownerOf(file);
  if (!root) continue;
  const pkg = workspaces.get(root);
  const data = readFileSync(file, "utf8");
  const imports = [
    ...data.matchAll(
      /from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)|import\s+["']([^"']+)["']/g,
    ),
  ].map((m) => m[1] ?? m[2] ?? m[3]);
  for (const specifier of imports) {
    if (specifier.includes("packages/") || specifier.includes("apps/"))
      violations.push(`${file}: deep relative workspace import ${specifier}`);
    if (!specifier.startsWith("@motorbaldi/")) continue;
    const dependencyName =
      specifier.match(/^(@motorbaldi\/[^/]+)(?:\/.*)?$/)?.[1] ?? "";
    const depRoot = rootsByName.get(dependencyName);
    if (!depRoot) {
      violations.push(`${file}: unknown workspace import ${specifier}`);
      continue;
    }
    if (depRoot !== root) {
      checkDirection(root, depRoot, file);
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
