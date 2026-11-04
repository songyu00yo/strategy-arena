import { z } from "zod";
import { grantAccess } from "@/lib/server/auth";
import { errorResponse, json, readBody } from "@/lib/server/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const { code } = await readBody(request, z.object({ code: z.string().min(1).max(200) })); return json({ accessGranted: true }, 200, { "Set-Cookie": grantAccess(code) }); }
  catch (error) { return errorResponse(error); }
}
