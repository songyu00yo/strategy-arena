import { UpdateIntakeSchema } from "@/lib/intake-contracts";
import { requireOwner } from "@/lib/server/auth";
import { readBody, json, errorResponse } from "@/lib/server/http";
import type { IntakeRouteContext } from "@/lib/server/intake-http";
import { getIntake, updateIntake } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function GET(request: Request, context: IntakeRouteContext) {
  try {
    const { id } = await context.params;
    return json(getIntake(id, requireOwner(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function PATCH(request: Request, context: IntakeRouteContext) {
  try {
    const input = await readBody(request, UpdateIntakeSchema);
    const { id } = await context.params;
    return json(updateIntake(id, requireOwner(request), input));
  } catch (error) {
    return errorResponse(error);
  }
}
