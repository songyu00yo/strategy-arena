import { parseArgs } from "node:util";
import { BillingError, changeBillingLimits, readBillingStatus } from "../src/lib/server/billing";

// Deliberately does not load .env files or import a runtime/model adapter.
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      database: { type: "string" },
      "expected-revision": { type: "string" },
      "expected-usd-limit": { type: "string" },
      "expected-request-limit": { type: "string" },
      "expected-token-limit": { type: "string" },
      "usd-limit": { type: "string" },
      "request-limit": { type: "string" },
      "token-limit": { type: "string" },
      "stage-id": { type: "string" },
      "stage-usd-limit": { type: "string" },
      "stage-request-limit": { type: "string" },
      "stage-token-limit": { type: "string" },
      reason: { type: "string" },
      "confirm-offline": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`Offline billing administration (no environment files/model requests).
status --database ABSOLUTE_PATH
set-limits --database ABSOLUTE_PATH --confirm-offline
  --expected-revision N --expected-usd-limit USD --expected-request-limit N --expected-token-limit N
  --usd-limit USD --request-limit N --token-limit N
  --stage-id ID --stage-usd-limit USD --stage-request-limit N --stage-token-limit N --reason TEXT
Stop paid workers before set-limits. Restart with ARENA_BILLING_* limits matching the new cumulative limits.
Stage caps are incremental after the transaction baseline; ceilings: USD 10 / 300 requests / 5000000 tokens.
Amounts are conservative usage estimates, not provider invoices.`);
  } else {
    const required = (name: keyof typeof values) => {
      const value = values[name];
      if (typeof value !== "string" || !value.trim())
        throw new BillingError(`Missing --${name}.`, "BILLING_INVALID_CONFIG");
      return value;
    };
    const number = (name: keyof typeof values) => {
      const raw = required(name);
      if (!/^\d+(?:\.\d+)?$/.test(raw))
        throw new BillingError(`Invalid --${name}.`, "BILLING_INVALID_CONFIG");
      return Number(raw);
    };
    if (positionals.length !== 1 || !["status", "set-limits"].includes(positionals[0]))
      throw new BillingError("Use status or set-limits; see --help.", "BILLING_INVALID_CONFIG");
    const databasePath = required("database");
    if (positionals[0] === "status") {
      if (Object.keys(values).some((key) => !["database", "confirm-offline", "help"].includes(key)))
        throw new BillingError("status accepts only --database.", "BILLING_INVALID_CONFIG");
      console.log(JSON.stringify(readBillingStatus(databasePath), null, 2));
    } else {
      if (!values["confirm-offline"])
        throw new BillingError(
          "Stop paid workers and provide --confirm-offline.",
          "BILLING_INVALID_CONFIG",
        );
      console.log(
        JSON.stringify(
          changeBillingLimits({
            databasePath,
            expected: {
              revision: number("expected-revision"),
              usdLimit: number("expected-usd-limit"),
              requestLimit: number("expected-request-limit"),
              tokenLimit: number("expected-token-limit"),
            },
            limits: {
              usdLimit: number("usd-limit"),
              requestLimit: number("request-limit"),
              tokenLimit: number("token-limit"),
            },
            stage: {
              id: required("stage-id"),
              usdLimit: number("stage-usd-limit"),
              requestLimit: number("stage-request-limit"),
              tokenLimit: number("stage-token-limit"),
            },
            reason: required("reason"),
          }),
          null,
          2,
        ),
      );
    }
  }
} catch (error) {
  console.error(
    error instanceof BillingError
      ? `${error.code}: ${error.message}`
      : "Billing administration failed; no private ledger contents printed.",
  );
  process.exitCode = 1;
}
