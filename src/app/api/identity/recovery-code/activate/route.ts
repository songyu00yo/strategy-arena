import { ActivateRecoveryCodeRequestSchema } from "@/lib/identity-contracts";
import { activateRecoveryCode } from "@/lib/server/identity";
import { errorResponse, json, readBody } from "@/lib/server/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readBody(request, ActivateRecoveryCodeRequestSchema);
    const { value, cookie } = activateRecoveryCode(request, input.expectedIdentityTag, input.code);
    return json(value, 200, { "Set-Cookie": cookie });
  } catch (error) {
    return errorResponse(error);
  }
}
