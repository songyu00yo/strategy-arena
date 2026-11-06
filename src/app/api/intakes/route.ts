import { CreateIntakeSchema } from "@/lib/intake-contracts";
import { ensureOwner } from "@/lib/server/auth";
import { readBody, json, errorResponse } from "@/lib/server/http";
import { createIntake } from "@/lib/server/intakes";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readBody(request, CreateIntakeSchema);
    const { owner, cookie } = ensureOwner(request);
    return json(createIntake(owner, input), 201, cookie ? { "Set-Cookie": cookie } : undefined);
  } catch (error) {
    return errorResponse(error);
  }
}
