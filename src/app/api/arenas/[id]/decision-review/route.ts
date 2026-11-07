import { DecisionReviewQuerySchema, DecisionReviewRequestSchema } from "@/lib/decision-review";
import { requireOwner } from "@/lib/server/auth";
import { getDecisionReview, runDecisionReview } from "@/lib/server/decision-review";
import { errorResponse, json, readBody, type ArenaRouteContext } from "@/lib/server/http";
export const runtime = "nodejs";
export const maxDuration = 210;
export async function GET(request: Request, context: ArenaRouteContext) {
  try {
    const input = DecisionReviewQuerySchema.parse({
      versionId: new URL(request.url).searchParams.get("versionId"),
    });
    return json(
      getDecisionReview((await context.params).id, input.versionId, requireOwner(request)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: ArenaRouteContext) {
  try {
    const input = await readBody(request, DecisionReviewRequestSchema);
    return json(
      await runDecisionReview(
        (await context.params).id,
        input.versionId,
        requireOwner(request),
        input.operationId,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
