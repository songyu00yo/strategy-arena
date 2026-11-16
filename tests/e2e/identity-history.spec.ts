import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { e2eAddress } from "../../scripts/test-address.mjs";
import { fixtureChallenge } from "./ui.fixture";

const { origin } = e2eAddress();
async function unlock(request: APIRequestContext) {
  const response = await request.post("/api/access", {
    headers: { Origin: origin },
    data: { code: "e2e-only-access-code" },
  });
  expect(response.status()).toBe(200);
}
async function createArena(request: APIRequestContext, goal: string) {
  const response = await request.post("/api/arenas", {
    headers: { Origin: origin },
    data: { ...fixtureChallenge, goal },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: string };
}
async function activeRecoveryCode(request: APIRequestContext) {
  const state = await (await request.get("/api/identity")).json();
  const prepare = await request.post("/api/identity/recovery-code", {
    headers: { Origin: origin },
    data: { expectedIdentityTag: state.identityTag },
  });
  expect(prepare.status()).toBe(200);
  const { recoveryCode } = await prepare.json();
  expect(
    (
      await request.post("/api/identity/recovery-code/activate", {
        headers: { Origin: origin },
        data: { expectedIdentityTag: state.identityTag, code: recoveryCode },
      })
    ).status(),
  ).toBe(200);
  return recoveryCode as string;
}
async function openHistory(page: Page) {
  const trigger = page.getByRole("banner").getByRole("button", { name: "我的历史", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "我的历史与恢复码" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  return dialog;
}
async function saveAndActivateCode(page: Page) {
  const dialog = page.getByRole("dialog", { name: "我的历史与恢复码" });
  await dialog.getByRole("button", { name: /^(生成恢复码|重新生成恢复码)$/ }).click();
  const code = await dialog.getByLabel("本次新生成的恢复码").inputValue();
  expect(code).toMatch(/^ARENA1-/);
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "下载保存", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("方案擂台恢复码.txt");
  await dialog.getByLabel("我已保存新码。启用后旧恢复码与其他设备的访问失效。").check();
  await dialog.getByRole("button", { name: "已保存，启用新码", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("新恢复码已启用");
  await expect(dialog.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  return code;
}

test("real API without model calls restores all owned history after browser identity loss", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page.request);
  const firstGoal = "身份恢复浏览器检查：第一份合成讨论任务";
  const secondGoal = "身份恢复浏览器检查：第二份合成讨论任务";
  const draftGoal = "身份恢复浏览器检查：尚未完成的合成草稿";
  const first = await createArena(page.request, firstGoal);
  const second = await createArena(page.request, secondGoal);
  const draftResponse = await page.request.post("/api/intakes", {
    headers: { Origin: origin },
    data: { goal: draftGoal },
  });
  expect(draftResponse.status()).toBe(201);
  const draft = await draftResponse.json();
  await page.goto("/");
  let dialog = await openHistory(page);
  await expect(dialog.getByRole("button", { name: new RegExp(firstGoal) })).toBeVisible();
  await expect(dialog.getByRole("button", { name: new RegExp(secondGoal) })).toBeVisible();
  await expect(dialog.getByRole("button", { name: new RegExp(draftGoal) })).toBeVisible();
  const code = await saveAndActivateCode(page);
  await dialog.getByRole("button", { name: "关闭弹窗", exact: true }).click();
  await context.clearCookies({ name: "arena_owner" });
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  dialog = await openHistory(page);
  await expect(dialog.getByText("当前身份还没有讨论记录。", { exact: true })).toBeVisible();
  await dialog.getByLabel("输入已保存的完整恢复码").fill(code);
  await dialog.getByRole("button", { name: "恢复历史", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已恢复对应身份");
  await expect(dialog.getByRole("button", { name: new RegExp(firstGoal) })).toBeVisible();
  await expect(dialog.getByRole("button", { name: new RegExp(secondGoal) })).toBeVisible();
  const history = await (await page.request.get("/api/arenas")).json();
  expect(history.items.map((item: { id: string }) => item.id).sort()).toEqual(
    [first.id, second.id].sort(),
  );
  await dialog.getByRole("button", { name: new RegExp(firstGoal) }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
    .toBe(first.id);
  dialog = await openHistory(page);
  await dialog.getByRole("button", { name: new RegExp(draftGoal) }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("textbox", { name: "你想解决什么问题？", exact: true })).toHaveValue(
    draftGoal,
  );
  expect(await page.evaluate(() => sessionStorage.getItem("strategy-arena:intake-tab-id"))).toBe(
    draft.id,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  dialog = await openHistory(page);
  const mobileBounds = await dialog.boundingBox();
  expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
  expect(mobileBounds!.width).toBeLessThanOrEqual(390);
});

test("real API without model calls switches existing identities without merging either history", async ({
  page,
  playwright,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const alice = await playwright.request.newContext({ baseURL: origin });
  try {
    await unlock(alice);
    const aliceGoal = "身份切换浏览器检查：甲方独有的合成讨论";
    const bobGoal = "身份切换浏览器检查：乙方独有的合成讨论";
    const aliceArena = await createArena(alice, aliceGoal);
    const initial = await (await alice.get("/api/identity")).json();
    const generated = await alice.post("/api/identity/recovery-code", {
      headers: { Origin: origin },
      data: { expectedIdentityTag: initial.identityTag },
    });
    expect(generated.status()).toBe(200);
    const { recoveryCode } = await generated.json();
    const activation = await alice.post("/api/identity/recovery-code/activate", {
      headers: { Origin: origin },
      data: { expectedIdentityTag: initial.identityTag, code: recoveryCode },
    });
    expect(activation.status()).toBe(200);
    await unlock(page.request);
    const bobArena = await createArena(page.request, bobGoal);
    await page.goto("/");
    const dialog = await openHistory(page);
    await saveAndActivateCode(page);
    const bobCookies = await page.context().storageState();
    await dialog.getByLabel("输入已保存的完整恢复码").fill(recoveryCode);
    await expect(dialog.getByRole("button", { name: "恢复历史", exact: true })).toBeDisabled();
    await dialog.getByLabel("我已保存当前身份的恢复码，确认切换。").check();
    await dialog.getByRole("button", { name: "恢复历史", exact: true }).click();
    await expect(dialog.getByRole("button", { name: new RegExp(aliceGoal) })).toBeVisible();
    await expect(dialog.getByRole("button", { name: new RegExp(bobGoal) })).toHaveCount(0);
    expect((await page.request.get(`/api/arenas/${bobArena.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/arenas/${aliceArena.id}`)).status()).toBe(200);
    const bob = await playwright.request.newContext({ baseURL: origin, storageState: bobCookies });
    try {
      expect((await bob.get(`/api/arenas/${bobArena.id}`)).status()).toBe(200);
      const history = await (await bob.get("/api/arenas")).json();
      expect(history.items.map((item: { id: string }) => item.id)).toEqual([bobArena.id]);
    } finally {
      await bob.dispose();
    }
  } finally {
    await alice.dispose();
  }
});

test("real API without model calls clears other tabs' selected discussion after credential rotation", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page.request);
  const goal = "跨标签页身份检查：不调用模型的合成讨论";
  const arena = await createArena(page.request, goal);
  await page.goto(`/?arena=${arena.id}`);
  const other = await context.newPage();
  try {
    await other.emulateMedia({ reducedMotion: "reduce" });
    await other.goto(`/?arena=${arena.id}`);
    await expect
      .poll(() => other.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
      .toBe(arena.id);
    await openHistory(page);
    await saveAndActivateCode(page);
    await expect
      .poll(() => other.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
      .toBe("");
    expect(new URL(other.url()).searchParams.has("arena")).toBe(false);
    const dialog = await openHistory(other);
    await expect(dialog.getByRole("button", { name: new RegExp(goal) })).toBeVisible();
  } finally {
    await other.close();
  }
});

test("explicit list-network failure fixture keeps real identity recovery and code generation usable", async ({
  page,
  playwright,
}) => {
  const saved = await playwright.request.newContext({ baseURL: origin });
  try {
    await unlock(saved);
    const savedArena = await createArena(saved, "列表网络故障检查：已保存身份的合成讨论");
    const state = await (await saved.get("/api/identity")).json();
    const prepare = await saved.post("/api/identity/recovery-code", {
      headers: { Origin: origin },
      data: { expectedIdentityTag: state.identityTag },
    });
    expect(prepare.status()).toBe(200);
    const { recoveryCode } = await prepare.json();
    expect(
      (
        await saved.post("/api/identity/recovery-code/activate", {
          headers: { Origin: origin },
          data: { expectedIdentityTag: state.identityTag, code: recoveryCode },
        })
      ).status(),
    ).toBe(200);
    await unlock(page.request);
    await page.route("**/api/arenas?*", (route) => route.abort("failed"));
    await page.goto("/");
    const dialog = await openHistory(page);
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: "生成恢复码", exact: true }).click();
    await expect(dialog.getByLabel("本次新生成的恢复码")).toHaveValue(/^ARENA1-/);
    await dialog.getByLabel("输入已保存的完整恢复码").fill(recoveryCode);
    await dialog.getByRole("button", { name: "恢复历史", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("已恢复对应身份");
    // The transport fixture only breaks list rendering. The real server accepted the identity.
    expect((await page.request.get(`/api/arenas/${savedArena.id}`)).status()).toBe(200);
  } finally {
    await saved.dispose();
  }
});

test("explicit activation-response body failure fixture rechecks identity and clears the old selected snapshot", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await unlock(page.request);
  const arena = await createArena(page.request, "恢复码启用响应丢失：需要清理旧快照的合成任务");
  await page.goto(`/?arena=${arena.id}`);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
    .toBe(arena.id);
  const dialog = await openHistory(page);
  await dialog.getByRole("button", { name: "生成恢复码", exact: true }).click();
  await expect(dialog.getByLabel("本次新生成的恢复码")).toHaveValue(/^ARENA1-/);
  const savedCode = await dialog.getByLabel("本次新生成的恢复码").inputValue();
  let activationRequests = 0;
  await page.route("**/api/identity/recovery-code/activate", async (route) => {
    activationRequests++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response, body: "{" });
  });
  await dialog.getByLabel("我已保存新码。启用后旧恢复码与其他设备的访问失效。").check();
  await dialog.getByRole("button", { name: "已保存，启用新码", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
    .toBe("");
  expect((await (await page.request.get("/api/identity")).json()).hasRecoveryCode).toBe(true);
  const identity = await (await page.request.get("/api/identity")).json();
  const recovered = await page.request.post("/api/identity/recover", {
    headers: { Origin: origin },
    data: { expectedIdentityTag: identity.identityTag, code: savedCode },
  });
  expect(recovered.status()).toBe(200);
  expect(activationRequests).toBe(1);
});

test("explicit recovery-response body failure fixture switches the real identity once and removes the former snapshot", async ({
  page,
  playwright,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const alice = await playwright.request.newContext({ baseURL: origin });
  try {
    await unlock(alice);
    const aliceGoal = "恢复响应丢失检查：甲方的合成任务";
    const bobGoal = "恢复响应丢失检查：乙方的合成任务";
    const aliceArena = await createArena(alice, aliceGoal);
    const aliceCode = await activeRecoveryCode(alice);
    await unlock(page.request);
    const bobArena = await createArena(page.request, bobGoal);
    await activeRecoveryCode(page.request);
    await page.goto(`/?arena=${bobArena.id}`);
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
      .toBe(bobArena.id);
    const dialog = await openHistory(page);
    let recoveryRequests = 0;
    await page.route("**/api/identity/recover", async (route) => {
      recoveryRequests++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response, body: "{" });
    });
    await dialog.getByLabel("输入已保存的完整恢复码").fill(aliceCode);
    await dialog.getByLabel("我已保存当前身份的恢复码，确认切换。").check();
    await dialog.getByRole("button", { name: "恢复历史", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("button", { name: new RegExp(aliceGoal) })).toBeVisible();
    await expect(dialog.getByRole("button", { name: new RegExp(bobGoal) })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("strategy-arena:tab-arena-id")))
      .toBe("");
    expect((await page.request.get(`/api/arenas/${aliceArena.id}`)).status()).toBe(200);
    expect((await page.request.get(`/api/arenas/${bobArena.id}`)).status()).toBe(404);
    expect(recoveryRequests).toBe(1);
  } finally {
    await alice.dispose();
  }
});
