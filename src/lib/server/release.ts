import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version } from "../../../package.json";

/** The package's immutable build identity takes precedence over mutable runtime labels. */
export function releaseInfo() {
  try {
    const record = JSON.parse(readFileSync(join(process.cwd(), "release-info.json"), "utf8"));
    if (
      typeof record.commit === "string" &&
      /^[a-f0-9]{40}$/.test(record.commit) &&
      typeof record.version === "string"
    ) {
      return {
        version: record.version,
        commit: record.commit,
        sourceDirty: Boolean(record.workingTreeDirty),
      };
    }
  } catch {
    /* A source checkout has no packaged release identity. */
  }
  return {
    version: process.env.RELEASE_VERSION || `${version}-dev`,
    commit: process.env.RELEASE_COMMIT || "development",
    sourceDirty: null,
  };
}
