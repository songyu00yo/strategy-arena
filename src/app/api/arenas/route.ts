import { CreateArenaRequestSchema } from "@/lib/contracts";
import { ensureOwner, requireOwner } from "@/lib/server/auth";
import { listArenaHistory } from "@/lib/server/identity";
import { createArena } from "@/lib/server/runtime";
import { readBody, json, errorResponse } from "@/lib/server/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return json(listArenaHistory(requireOwner(request), new URL(request.url)));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const { modelMode, executionMode, ...challenge } = await readBody(
      request,
      CreateArenaRequestSchema,
    );
    const { owner, cookie } = ensureOwner(request);
    return json(
      createArena(challenge, owner, modelMode, undefined, executionMode),
      201,
      cookie ? { "Set-Cookie": cookie } : undefined,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
