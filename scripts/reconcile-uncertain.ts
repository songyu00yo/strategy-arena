import { parseArgs } from "node:util";
import { closeDb, ArenaError } from "../src/lib/server/db";
import { reconcileUncertain } from "../src/lib/server/reconcile";

try {
  const { values } = parseArgs({
    options: {
      step: { type: "string" },
      resolution: { type: "string" },
      "confirmed-cny": { type: "string" },
      proof: { type: "string" },
      "acknowledge-provider-confirmation": { type: "boolean", default: false },
    },
  });
  if (
    !values.step ||
    !values.resolution ||
    values["confirmed-cny"] === undefined ||
    !values.proof ||
    !values["confirmed-cny"].trim()
  )
    throw new ArenaError(
      "请提供 --step、--resolution、--confirmed-cny、--proof 及 --acknowledge-provider-confirmation。本命令仅用于旧版人民币步骤；不支持美元或共享费用账本。",
      400,
    );
  const result = reconcileUncertain({
    stepId: values.step,
    resolution: values.resolution as "no-charge" | "settled",
    confirmedCny: Number(values["confirmed-cny"]),
    proof: values.proof,
    acknowledgeProviderConfirmation: values["acknowledge-provider-confirmation"],
  });
  console.log(
    `核账完成：step=${result.stepId}，confirmedCny=${result.confirmedCny}，releasedCny=${result.releasedCny}。原步骤已终止。`,
  );
} catch (error) {
  console.error(
    error instanceof ArenaError
      ? error.message
      : "核账失败。请检查参数、数据库和凭证文件权限；未输出凭证内容。",
  );
  process.exitCode = 1;
} finally {
  closeDb();
}
