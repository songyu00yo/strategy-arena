import { CreatePlanningSchema } from "@/lib/planning-schemas";
import { ensureOwner } from "@/lib/server/auth";
import { errorResponse, json, readBody } from "@/lib/server/http";
import { createPlanning } from "@/lib/server/planning";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readBody(request, CreatePlanningSchema);
    const { owner, cookie } = ensureOwner(request);
    return json(createPlanning(owner, input), 201, cookie ? { "Set-Cookie": cookie } : undefined);
  } catch (error) {
    return errorResponse(error);
  }
}
