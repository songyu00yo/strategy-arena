import { modelInfo } from "@/lib/server/runtime";
import { json, errorResponse } from "@/lib/server/http";
import { accessState } from "@/lib/server/auth";
import { releaseInfo } from "@/lib/server/release";
export const runtime = "nodejs";
export function GET(request: Request) {
  try {
    return json({
      status: "ok",
      identityBootstrap: true,
      ...releaseInfo(),
      model: modelInfo(),
      ...accessState(request),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
