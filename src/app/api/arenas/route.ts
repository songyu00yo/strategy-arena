import { CreateArenaRequestSchema } from "@/lib/contracts";
import { ensureOwner } from "@/lib/server/auth";
import { createArena } from "@/lib/server/runtime";
import { readBody, json, errorResponse } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { modelMode, ...challenge } = await readBody(request, CreateArenaRequestSchema);
    const { owner, cookie } = ensureOwner(request);
    return json(
      createArena(challenge, owner, modelMode),
      201,
      cookie ? { "Set-Cookie": cookie } : undefined,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
