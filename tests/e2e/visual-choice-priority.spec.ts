// Explicit synthetic UI fixtures. All API calls are intercepted and no model is contacted.
import { expect, test } from "@playwright/test";
import { configureFixtureModels, fixtureModels } from "./intake.fixture";
import { advanceFixture, fixtureSnapshot } from "./ui.fixture";

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test.describe(`decision priorities ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });
    test("homepage offers three explicitly synthetic choices and keeps general input editable", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const unexpected: string[] = [];
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/health")
          return route.fulfill({
            json: {
              status: "ok",
              version: "explicit-choice-ui-fixture",
              requiresAccessCode: false,
              accessGranted: true,
              model: {
                id: fixtureModels[0].id,
                configured: true,
                models: fixtureModels,
                providers: fixtureModels,
              },
            },
          });
        unexpected.push(path);
        return route.fulfill({
          status: 500,
          json: { error: "Unexpected API call blocked by fixture" },
        });
      });
      await page.goto("/");
      await expect(page.getByText("方案擂台 · 大学生的重大选择", { exact: true })).toBeVisible();
      const input = page.getByLabel("你想解决什么问题？", { exact: true });
      await expect(input).toBeEditable();
      const picker = page.getByRole("group", { name: "选择一个合成场景" });
      await expect(picker.getByRole("button")).toHaveCount(3);
      for (const label of ["考研还是就业", "选 offer", "买二手车"]) {
        await picker.getByRole("button", { name: label, exact: true }).click();
        await expect(input).toHaveValue(/合成场景 · 虚构情境/);
        await expect(input).toBeFocused();
      }
      await input.fill("我想比较一个自己提出的其他选择，可以继续自由输入。");
      await expect(input).toHaveValue("我想比较一个自己提出的其他选择，可以继续自由输入。");
      expect(unexpected).toEqual([]);
      await expect(page.getByRole("button", { name: "开始分析", exact: true })).toBeInViewport();
      await page.screenshot({
        path: `test-results/choices-home-${viewport.width}.png`,
        fullPage: true,
      });
    });

    test("completed result leads with conclusion and first action, with readable claim associations", async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const snapshot = configureFixtureModels(fixtureSnapshot());
      for (let stage = 0; stage < 5; stage++) advanceFixture(snapshot);
      const version = snapshot.versions[0];
      version.revisions[0].summary = "UI fixture：已回应 A-claim 的质疑，保留尚需确认的条件。";
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/health")
          return route.fulfill({
            json: {
              status: "ok",
              version: "explicit-choice-ui-fixture",
              model: snapshot.model,
              requiresAccessCode: false,
              accessGranted: true,
            },
          });
        if (path === `/api/arenas/${snapshot.id}`) return route.fulfill({ json: snapshot });
        if (path.endsWith("/events"))
          return route.fulfill({
            contentType: "text/event-stream",
            body: ": synthetic UI fixture\n\n",
          });
        return route.fulfill({
          status: 500,
          json: { error: "Unexpected API call blocked by fixture" },
        });
      });
      await page.goto(`/?arena=${snapshot.id}`);
      const result = page.getByRole("region", { name: "结论", exact: true });
      await expect(result.getByRole("heading", { name: version.verdict!.headline })).toBeVisible();
      await expect(result.locator(".first strong")).toHaveText(version.verdict!.nextActions[0]);
      await expect(result.locator(".first strong")).toBeInViewport();
      const resultBox = await result.boundingBox();
      const progressBox = await page
        .getByRole("group", { name: "推演步骤", exact: true })
        .boundingBox();
      expect(resultBox!.y + resultBox!.height).toBeLessThanOrEqual(progressBox!.y);
      await result.getByRole("button", { name: "看完整结论", exact: true }).click();
      await expect(result).toContainText(version.verdict!.exitCondition);
      await result.getByRole("button", { name: "收起结论", exact: true }).click();
      await expect(page.locator(".c-board-A .c-claim").first()).toContainText("路线 A 的判断 1");
      await expect(page.locator("body")).not.toContainText("A-claim");
      const dispute = page.locator(".c-row[data-attack]").first();
      await dispute.click();
      const drawer = page.getByRole("dialog", { name: "这一条，站得住吗？", exact: true });
      await expect(drawer.locator("blockquote")).toHaveText(version.attacks[0].claimQuote);
      await expect(drawer.locator(".evidence-route")).toHaveText("路线 A 的判断 1");
      await expect(drawer).not.toContainText("A-claim");
      await drawer.getByRole("button", { name: "关闭证据详情", exact: true }).click();
      await page.screenshot({
        path: `test-results/choices-result-${viewport.width}.png`,
        fullPage: true,
      });
    });
  });
}
