import { PlanningActionSchema } from "@/lib/planning-schemas";
import { requireOwner } from "@/lib/server/auth";
import { errorResponse, json, readBody } from "@/lib/server/http";
import { actPlanning } from "@/lib/server/planning";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const input = await readBody(request, PlanningActionSchema);
    const { id } = await context.params;
    return json(await actPlanning(id, requireOwner(request), input));
  } catch (error) {
    return errorResponse(error);
  }
}
