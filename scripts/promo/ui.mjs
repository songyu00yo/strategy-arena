/** These helpers operate existing controls and preserve the product's normal animation settings. */
export const wait = (ms) => new Promise((done) => setTimeout(done, ms));

export async function cinematicClick(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 22 });
  await wait(220);
  await locator.click();
}

export async function fillVideoSample(page, { demo = false } = {}) {
  await cinematicClick(page, page.getByRole("button", { name: "试填一个视频任务" }));
  // Sample typing, light trails and its existing auto-scroll play at their original speed.
  await wait(6500);
  await page.getByRole("textbox", { name: "你的目标、备选方案或想法" }).waitFor();
  if (!demo) {
    await cinematicClick(page, page.getByRole("radio", { name: /DeepSeek/ }));
    if (!(await page.getByRole("radio", { name: /DeepSeek/ }).isChecked()))
      throw new Error("The initial run must explicitly select DeepSeek.");
  }
  await page.getByRole("button", { name: "让方案上场", exact: true }).scrollIntoViewIfNeeded();
  await wait(2200);
}

export async function openRematch(page, { demo = false } = {}) {
  await cinematicClick(page, page.getByRole("button", { name: "修改条件再开局" }));
  const dialog = page.getByRole("dialog", { name: "修改条件，重新开局" });
  await dialog.waitFor();
  await wait(1200);
  const constraints = dialog.getByRole("textbox", { name: /硬性限制/ });
  const existing = await constraints.inputValue();
  await constraints.fill(`${existing}\n所有画面必须来自真实记录，禁止生成虚构画面。`);
  await dialog
    .getByRole("textbox", { name: /这次为什么修改/ })
    .fill(
      "新增真实画面限制：所有画面必须来自真实记录，禁止生成虚构画面。检查三条路线能否遵守新条件。",
    );
  if (!demo) {
    await cinematicClick(page, dialog.getByRole("radio", { name: /DeepSeek/ }));
    if (!(await dialog.getByRole("radio", { name: /DeepSeek/ }).isChecked()))
      throw new Error("The changed-condition run must explicitly select DeepSeek.");
  }
  await dialog.getByRole("button", { name: "按新条件重新推演" }).scrollIntoViewIfNeeded();
  await wait(3000);
  return dialog;
}

export async function finishedShots(page, version, shot) {
  await shot(
    "result",
    async () => {
      await page.keyboard.press("End");
      await wait(1800);
      const result = page.getByRole("region", { name: "结论", exact: true });
      if (await result.count()) await result.scrollIntoViewIfNeeded();
      await wait(6000);
    },
    { versionId: version.id, preferred: version.verdict?.preferred ?? null },
  );

  // A complete replay yields the actual route arrivals, attacks, verification, revisions and verdict.
  // No fake events, replaced snapshots, CSS overrides, speed changes or DOM edits are used.
  await shot(
    "full-replay",
    async () => {
      await cinematicClick(page, page.getByRole("button", { name: "从头放映", exact: true }));
      await page.getByRole("button", { name: "暂停放映", exact: true }).waitFor();
      await page
        .getByRole("button", { name: "暂停放映", exact: true })
        .waitFor({ state: "hidden", timeout: 300000 });
      await wait(6000);
    },
    { versionId: version.id, playback: "existing UI at normal speed; completed real records" },
  );

  const secondStep = page.getByRole("button", { name: "第 2 步", exact: true });
  if (await secondStep.count())
    await shot(
      "proposal-step-and-card",
      async () => {
        await cinematicClick(page, secondStep);
        await wait(2200);
        const card = page.locator('[data-step-source="0"][role="button"]');
        if (await card.count()) {
          // The cards overlap physically. Use the product's own keyboard activation on the prior
          // card instead of forcing a pointer through its visible neighbour.
          await card.focus();
          await page.keyboard.press("Enter");
          const close = page.getByRole("button", { name: "收起这张卡片" });
          await close.waitFor({ timeout: 10000 });
          await wait(4500);
          await cinematicClick(page, close);
          await wait(2600);
        }
        await page.keyboard.press("End");
        await wait(1800);
      },
      { versionId: version.id },
    );

  if (version.attacks.length)
    await shot(
      "evidence-drawer",
      async () => {
        const attack = page.locator("button[data-attack]").first();
        await cinematicClick(page, attack);
        await page.getByRole("button", { name: "关闭证据详情" }).waitFor();
        await wait(5000);
        const drawer = page.locator(".drawer-scroll");
        await drawer.evaluate((node) =>
          node.scrollTo({ top: node.scrollHeight * 0.45, behavior: "smooth" }),
        );
        await wait(4000);
        await cinematicClick(page, page.getByRole("button", { name: "关闭证据详情" }));
        await wait(2000);
      },
      { versionId: version.id, attackId: version.attacks[0].id },
    );
}

export async function otherCaseShots(page, shot) {
  await cinematicClick(page, page.getByRole("button", { name: "新问题", exact: true }));
  await wait(1500);
  for (const name of ["考研还是就业", "要不要换城市", "工单系统选型", "内容账号起步"]) {
    await shot(
      "other-case-input",
      async () => {
        await cinematicClick(page, page.getByRole("button", { name, exact: true }));
        await wait(6500);
        await page
          .getByRole("textbox", { name: "你的目标、备选方案或想法" })
          .scrollIntoViewIfNeeded();
        await wait(2800);
      },
      { sample: name, source: "sample input only; no model run or result" },
    );
  }
}
