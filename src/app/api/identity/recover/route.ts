import { RecoverIdentityRequestSchema } from "@/lib/identity-contracts";
import { recoverIdentity } from "@/lib/server/identity";
import { errorResponse, json, readBody } from "@/lib/server/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readBody(request, RecoverIdentityRequestSchema);
    const { value, cookie } = recoverIdentity(request, input.code, input.expectedIdentityTag);
    return json(value, 200, { "Set-Cookie": cookie });
  } catch (error) {
    return errorResponse(error);
  }
}
