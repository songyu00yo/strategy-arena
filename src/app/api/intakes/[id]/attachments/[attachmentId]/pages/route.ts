import { SelectPagesSchema } from "@/lib/intake-contracts";
import { requireOwner } from "@/lib/server/auth";
import { readBody, json, errorResponse } from "@/lib/server/http";
import type { AttachmentRouteContext } from "@/lib/server/intake-http";
import { selectIntakePages } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function POST(request: Request, context: AttachmentRouteContext) {
  try {
    const input = await readBody(request, SelectPagesSchema);
    const { id, attachmentId } = await context.params;
    return json(await selectIntakePages(id, requireOwner(request), attachmentId, input.pages));
  } catch (error) {
    return errorResponse(error);
  }
}
