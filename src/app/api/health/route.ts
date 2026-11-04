import { modelInfo } from "@/lib/server/runtime";
import { json, errorResponse } from "@/lib/server/http";
import { accessState } from "@/lib/server/auth";
export const runtime = "nodejs";
export function GET(request: Request) {
  try { return json({ status: "ok", version: process.env.RELEASE_VERSION || "0.1.0-dev", commit: process.env.RELEASE_COMMIT || "development", model: modelInfo(), ...accessState(request) }); }
  catch (error) { return errorResponse(error); }
}
