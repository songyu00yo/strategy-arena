import { InterventionSchema } from "@/lib/contracts";
import { requireOwner } from "@/lib/server/auth";
import { intervene } from "@/lib/server/runtime";
import { readBody, json, errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: ArenaRouteContext) {
  try {
    const input = await readBody(request, InterventionSchema);
    return json(intervene((await context.params).id, requireOwner(request), input));
  } catch (error) {
    return errorResponse(error);
  }
}
