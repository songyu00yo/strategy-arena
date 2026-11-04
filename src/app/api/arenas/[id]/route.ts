import { requireOwner } from "@/lib/server/auth";
import { getArena } from "@/lib/server/runtime";
import { json, errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export async function GET(request: Request, context: ArenaRouteContext) {
  try { return json(getArena((await context.params).id, requireOwner(request))); }
  catch (error) { return errorResponse(error); }
}
