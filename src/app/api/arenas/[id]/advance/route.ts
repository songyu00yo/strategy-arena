import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { advanceArena } from "@/lib/server/runtime";
import { readBody, json, errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request, context: ArenaRouteContext) {
  try { const input = await readBody(request, z.object({ versionId: z.string().uuid() })); return json(await advanceArena((await context.params).id, requireOwner(request), input.versionId)); }
  catch (error) { return errorResponse(error); }
}
