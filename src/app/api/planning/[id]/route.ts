import { requireOwner } from "@/lib/server/auth";
import { errorResponse, json } from "@/lib/server/http";
import { getPlanning } from "@/lib/server/planning";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return json(getPlanning(id, requireOwner(request)));
  } catch (error) {
    return errorResponse(error);
  }
}
