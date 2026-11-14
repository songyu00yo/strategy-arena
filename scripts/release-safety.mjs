import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

const privateRoots = new Set([
  "data",
  "uploads",
  "attachments",
  "artifacts",
  "work",
  "private",
  "outputs",
  ".git",
  "test-results",
  "playwright-report",
]);
export function allowedReleaseSource(source, root) {
  const path = relative(resolve(root), resolve(source));
  if (!path) return true;
  const parts = path.split(sep);
  return (
    !privateRoots.has(parts[0]) &&
    !(parts[0] === "public" && ["uploads", "attachments"].includes(parts[1])) &&
    !parts.some((part) => /^\.env(?:\.|$)/.test(part)) &&
    !/\.(?:sqlite(?:-wal|-shm)?|db|pem|key)$/.test(basename(source))
  );
}
export function assertReleaseSafe(directory) {
  const root = realpathSync(directory);
  const failures = [];
  function walk(path) {
    const local = relative(root, path);
    // Check names before reading contents: environment files are never opened.
    if (!allowedReleaseSource(path, root)) {
      failures.push(`${local}: private path is forbidden`);
      return;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      let target;
      try {
        target = realpathSync(path);
      } catch {
        failures.push(`${local}: broken symbolic link`);
        return;
      }
      if (target !== root && !target.startsWith(root + sep))
        failures.push(`${local}: symbolic link escapes the bundle`);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(resolve(path, entry));
      return;
    }
    if (!stat.isFile()) {
      failures.push(`${local}: unsupported special file`);
      return;
    }
    // Test bytes without logging matching values, including compiled server output.
    const content = readFileSync(path).toString("latin1");
    if (
      /\bsk-[A-Za-z0-9_-]{30,}\b/.test(content) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{24}/.test(content)
    )
      failures.push(`${local}: credential pattern found (value redacted)`);
  }
  walk(root);
  if (failures.length) throw new Error(`Unsafe release bundle:\n${failures.join("\n")}`);
}
