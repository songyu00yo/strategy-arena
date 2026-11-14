import { ZodError, type ZodType } from "zod";
import { ArenaError } from "./db";
import { checkOrigin } from "./auth";

export async function readBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  checkOrigin(request);
  const max = 96 * 1024;
  const declared = Number(request.headers.get("content-length"));
  if (declared > max)
    throw new ArenaError("提交的内容过长，请精简材料后再试。", 413, "BODY_TOO_LARGE");
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new ArenaError("请使用 JSON 格式提交。", 415, "INVALID_CONTENT_TYPE");
  const reader = request.body?.getReader();
  if (!reader) throw new ArenaError("提交内容为空，请填写后再试。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ArenaError("提交的内容过长，请精简材料后再试。", 413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new ArenaError("提交内容不是有效的 JSON。");
    }
    return schema.parse(parsed);
  } finally {
    reader.releaseLock();
  }
}
export function json(value: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(value, { status, headers: responseHeaders });
}
export function errorResponse(error: unknown) {
  if (error instanceof ArenaError)
    return json({ error: error.message, code: error.code }, error.status);
  if (error instanceof ZodError)
    return json(
      { error: error.issues.map((i) => i.message).join("；"), code: "INVALID_REQUEST" },
      400,
    );
  console.error("Arena request failed", error instanceof Error ? error.name : "UnknownError");
  return json(
    { error: "暂时无法完成请求，已有内容已保留。请稍后刷新。", code: "INTERNAL_ERROR" },
    500,
  );
}
export type ArenaRouteContext = { params: Promise<{ id: string }> };
