import { getIdentity } from "@/lib/server/identity";
import { errorResponse, json } from "@/lib/server/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const { value, cookie } = getIdentity(request);
    return json(value, 200, cookie ? { "Set-Cookie": cookie } : undefined);
  } catch (error) {
    return errorResponse(error);
  }
}
