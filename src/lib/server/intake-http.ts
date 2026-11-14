import { checkOrigin, requireOwner } from "./auth";
import { ArenaError } from "./db";

export type IntakeRouteContext = { params: Promise<{ id: string }> };
export type AttachmentRouteContext = { params: Promise<{ id: string; attachmentId: string }> };

/** Uploads have their own bounded multipart reader; ordinary JSON keeps its existing limit. */
export async function readIntakeUpload(request: Request) {
  checkOrigin(request);
  const owner = requireOwner(request);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;"))
    throw new ArenaError("请选择一个附件上传。", 415, "INVALID_CONTENT_TYPE");
  const max = 10 * 1024 * 1024 + 64 * 1024;
  if (Number(request.headers.get("content-length")) > max)
    throw new ArenaError("单个附件最多 10 MB。", 413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new ArenaError("附件内容为空。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ArenaError("单个附件最多 10 MB。", 413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new ArenaError("附件上传格式无效，请重新选择文件。");
  }
  const files = form.getAll("file");
  if (files.length !== 1 || !(files[0] instanceof File)) throw new ArenaError("请逐个上传附件。");
  const file = files[0];
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new ArenaError("附件须包含内容，且单个文件最多 10 MB。", 413, "BODY_TOO_LARGE");
  if ([...form.keys()].some((key) => key !== "file")) throw new ArenaError("上传字段无效。");
  return { owner, bytes: Buffer.from(await file.arrayBuffer()), name: file.name };
}
