import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { stopArena } from "@/lib/server/runtime";
import { readBody, json, errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: ArenaRouteContext) {
  try {
    const input = await readBody(request, z.object({ versionId: z.string().uuid() }));
    return json(stopArena((await context.params).id, requireOwner(request), input.versionId));
  } catch (error) {
    return errorResponse(error);
  }
}
