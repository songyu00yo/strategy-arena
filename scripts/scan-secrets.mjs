import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Scan repository files only. Never open ignored local environment files.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const failures = [];
for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) && !/(^|\/)\.env\.example$/.test(file)) {
    failures.push(`${file}: environment files must not be tracked`);
    continue;
  }
  if (/\.(png|jpe?g|webp|gif|ico|woff2?|pdf|lock)$/.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [index, line] of content.split("\n").entries()) {
    if (
      /^\s*(?:MODEL_API_KEY|ARENA_SESSION_SECRET|ARENA_ACCESS_CODE)\s*=\s*\S/.test(line) ||
      /\bsk-[A-Za-z0-9_-]{30,}\b/.test(line) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)
    ) {
      failures.push(`${file}:${index + 1}: suspected credential (value redacted)`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Credential pattern check passed for ${files.length} repository files. This is not a complete secret audit.`,
  );
