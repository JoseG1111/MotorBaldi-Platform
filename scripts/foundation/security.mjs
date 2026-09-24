import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
const root = process.argv[2];
let files;
if (root) {
  files = execFileSync(
    "find",
    [root, "-type", "f", "-not", "-path", "*/node_modules/*"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
} else {
  try {
    files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    files = execFileSync(
      "find",
      [
        ".",
        "-type",
        "f",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.wrangler/*",
        "-not",
        "-path",
        "*/dist/*",
      ],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((file) => file.replace(/^\.\//, ""));
  }
}
const bad = [];
const patterns = [
  [
    "github_token",
    /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})/,
  ],
  ["wompi_private", /prv_(?:test|prod)_[A-Za-z0-9_]{20,}/],
  ["hubspot_private", /pat-[a-z0-9]+-[A-Za-z0-9_-]{20,}/i],
  ["cloudflare_token", /\b(?:CFPAT|cfpat)_[A-Za-z0-9_-]{20,}\b/],
  [
    "cloudflare_api_key",
    /(?:CLOUDFLARE_API_KEY|CF_API_KEY)\s*[=:]\s*["']?[0-9a-f]{37}\b/i,
  ],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "private_key",
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{64,}-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  ],
  ["stripe_like", /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/],
];
for (const file of files) {
  if (!existsSync(file)) continue;
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".example"))
    bad.push(file);
  if (/\.(?:png|jpg|webp|ico|glb|zip|woff2?)$/.test(file)) continue;
  const data = readFileSync(file, "utf8");
  for (const [, pattern] of patterns) if (pattern.test(data)) bad.push(file);
}
if (bad.length)
  throw new Error("Potential secrets in: " + [...new Set(bad)].join(", "));
console.log(
  "Working-tree secret/config checks passed (does not replace credential inventory)",
);
