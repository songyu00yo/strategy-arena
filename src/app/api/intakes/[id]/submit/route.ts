import { SubmitIntakeSchema } from "@/lib/intake-contracts";
import { requireOwner } from "@/lib/server/auth";
import { readBody, json, errorResponse } from "@/lib/server/http";
import type { IntakeRouteContext } from "@/lib/server/intake-http";
import { getIntake, submitIntake, submitClarificationIntake } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function POST(request: Request, context: IntakeRouteContext) {
  try {
    const input = await readBody(request, SubmitIntakeSchema);
    const { id } = await context.params;
    const owner = requireOwner(request);
    if (getIntake(id, owner).workflow === "clarification")
      return json(await submitClarificationIntake(id, owner, input));
    return json(
      submitIntake(id, requireOwner(request), {
        ...input,
        executionMode: input.executionMode ?? "agent",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
