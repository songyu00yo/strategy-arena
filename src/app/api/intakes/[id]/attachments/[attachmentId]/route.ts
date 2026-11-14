import { checkOrigin, requireOwner } from "@/lib/server/auth";
import { json, errorResponse } from "@/lib/server/http";
import type { AttachmentRouteContext } from "@/lib/server/intake-http";
import { getIntakeAttachment, removeIntakeAttachment } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function GET(request: Request, context: AttachmentRouteContext) {
  try {
    const { id, attachmentId } = await context.params;
    const file = getIntakeAttachment(id, requireOwner(request), attachmentId);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request, context: AttachmentRouteContext) {
  try {
    checkOrigin(request);
    const { id, attachmentId } = await context.params;
    return json(removeIntakeAttachment(id, requireOwner(request), attachmentId));
  } catch (error) {
    return errorResponse(error);
  }
}
