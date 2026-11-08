import { RecoveryCodeRequestSchema } from "@/lib/identity-contracts";
import { prepareRecoveryCode } from "@/lib/server/identity";
import { errorResponse, json, readBody } from "@/lib/server/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readBody(request, RecoveryCodeRequestSchema);
    const { value } = prepareRecoveryCode(request, input.expectedIdentityTag);
    return json(value);
  } catch (error) {
    return errorResponse(error);
  }
}
