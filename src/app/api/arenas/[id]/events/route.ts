import { requireOwner } from "@/lib/server/auth";
import { assertOwner, getEvents } from "@/lib/server/db";
import { errorResponse, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: ArenaRouteContext) {
  try {
    const arenaId = (await context.params).id;
    assertOwner(arenaId, requireOwner(request));
    const rawSeq = new URL(request.url).searchParams.get("afterSeq") || request.headers.get("last-event-id") || "0";
    let afterSeq = /^\d{1,15}$/.test(rawSeq) ? Number(rawSeq) : 0;
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const started = Date.now();
        let heartbeat = Date.now();
        cleanup = () => { if (closed) return; closed = true; if (timer) clearInterval(timer); request.signal.removeEventListener("abort", cleanup); try { controller.close(); } catch {} };
        const poll = () => {
          if (closed) return;
          try {
            const events = getEvents(arenaId, afterSeq);
            if (events.length) { afterSeq = events.at(-1)!.seq; controller.enqueue(encoder.encode(`id: ${afterSeq}\nevent: arena\ndata: ${JSON.stringify({ events })}\n\n`)); }
            if (Date.now() - heartbeat >= 15_000) { heartbeat = Date.now(); controller.enqueue(encoder.encode(": heartbeat\n\n")); }
            if (Date.now() - started >= 55_000) cleanup();
          } catch { cleanup(); }
        };
        controller.enqueue(encoder.encode(": connected\n\n"));
        poll();
        timer = setInterval(poll, 1000);
        request.signal.addEventListener("abort", cleanup, { once: true });
        if (request.signal.aborted) cleanup();
      },
      cancel() { cleanup(); }
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" } });
  } catch (error) { return errorResponse(error); }
}
