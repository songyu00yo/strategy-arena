import { json, errorResponse } from "@/lib/server/http";
import { readIntakeUpload, type IntakeRouteContext } from "@/lib/server/intake-http";
import { addIntakeAttachment } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function POST(request: Request, context: IntakeRouteContext) {
  try {
    const { owner, bytes, name } = await readIntakeUpload(request);
    const { id } = await context.params;
    return json(await addIntakeAttachment(id, owner, bytes, name), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
