import { AnalyzeIntakeSchema } from "@/lib/intake-contracts";
import { requireOwner } from "@/lib/server/auth";
import { readBody, json, errorResponse } from "@/lib/server/http";
import type { IntakeRouteContext } from "@/lib/server/intake-http";
import { analyzeIntake } from "@/lib/server/intakes";

export const runtime = "nodejs";
export const maxDuration = 600;
export async function POST(request: Request, context: IntakeRouteContext) {
  try {
    const input = await readBody(request, AnalyzeIntakeSchema);
    const { id } = await context.params;
    return json(await analyzeIntake(id, requireOwner(request), input));
  } catch (error) {
    return errorResponse(error);
  }
}
