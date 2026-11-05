import { VersionRequestSchema } from "@/lib/contracts";
import { requireOwner } from "@/lib/server/auth";
import { newVersion } from "@/lib/server/runtime";
import { readBody, json, errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: ArenaRouteContext) {
  try {
    const input = await readBody(request, VersionRequestSchema);
    return json(
      newVersion(
        (await context.params).id,
        requireOwner(request),
        input.challenge,
        input.changeReason,
        undefined,
        input.modelMode,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
