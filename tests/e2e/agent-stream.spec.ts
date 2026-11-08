// Explicit synthetic UI stream. This test never contacts a model or search provider.
import { expect, test } from "@playwright/test";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

test("synthetic stream displays real event text before the step finishes without per-draft snapshots", async ({
  page,
}) => {
  const initial = fixtureSnapshot();
  advanceFixture(initial);
  initial.versions[0].status = "running";
  initial.eventCursor = 20;
  const finished = fixtureSnapshot();
  for (let i = 0; i < 5; i++) advanceFixture(finished);
  finished.eventCursor = 22;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stepFinished = false;
  let reads = 0;
  const draft = {
    stepId: "stream-attempt",
    versionId: initial.activeVersionId,
    stage: "attack",
    role: "B",
    revision: 1,
    fields: { reason: "流式测试文字正在逐步出现，当前仍在生成。" },
    status: "generating",
  };
  await page.addInitScript(() => sessionStorage.setItem("arena-intro", "1"));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/health")
      return route.fulfill({ json: { status: "ok", model: initial.model, accessGranted: true } });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: `id: 21\nevent: arena\ndata: ${JSON.stringify({ events: [{ seq: 21, arenaId: initial.id, versionId: initial.activeVersionId, type: "draft_updated", stage: "attack", actor: "B", message: "生成中", data: draft, createdAt: initial.createdAt }] })}\n\n`,
      });
    if (url.pathname.endsWith("/advance")) {
      await gate;
      stepFinished = true;
      return route.fulfill({ json: finished }).catch(() => {});
    }
    if (url.pathname === `/api/arenas/${initial.id}`) {
      reads++;
      return route.fulfill({ json: stepFinished ? finished : initial });
    }
    return route.fulfill({ status: 404, json: { error: "explicit fixture boundary" } });
  });
  try {
    await page.goto(`/?arena=${initial.id}`);
    await expect(page.getByLabel("实时生成文字")).toContainText(draft.fields.reason);
    expect(stepFinished).toBe(false);
    expect(reads).toBe(1);
    await expect(page.getByLabel("实时生成文字")).toContainText("尚未核验");
  } finally {
    release();
  }
  await expect(page.getByLabel("实时生成文字")).toHaveCount(0);
});
