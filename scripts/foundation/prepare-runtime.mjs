import {
  mkdirSync,
  copyFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";

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
const moduleRoot = "build/node_modules/@motorbaldi";
rmSync(moduleRoot, { recursive: true, force: true });
mkdirSync(moduleRoot, { recursive: true });
for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const sourceRoot = dirname(file);
  const buildRoot = "build/" + sourceRoot;
  mkdirSync(buildRoot, { recursive: true });
  copyFileSync(file, buildRoot + "/package.json");
  if (!pkg.name.startsWith("@motorbaldi/")) continue;
  const link = moduleRoot + "/" + pkg.name.slice("@motorbaldi/".length);
  symlinkSync(relative(dirname(link), buildRoot), link, "dir");
}
