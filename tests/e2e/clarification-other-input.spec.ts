// Explicit synthetic UI records. This suite exercises local input and preserves the wire contract for API tests.
import { expect, test } from "@playwright/test";
import type { IntakeAnswer, IntakeQuestion } from "../../src/lib/intake-contracts";
import { ANSWER_JOURNAL_KEY } from "../../src/components/intake-answer-journal";
import { configureFixtureModels, fixtureIntake, intakeStorageKey } from "./intake.fixture";
import { fixtureSnapshot } from "./ui.fixture";

const questions: IntakeQuestion[] = [
  {
    id: "multiple_other",
    title: "【测试替身】需要哪些内容？",
    reason: "测试其他补充内容与普通选项的本地编辑。",
    type: "multiple",
    options: ["A", "B", "其他（请补充）"],
    placeholder: "",
    unit: "",
  },
  {
    id: "single_other",
    title: "【测试替身】采用哪种方式？",
    reason: "测试英文 Other 选项的本地编辑。",
    type: "single",
    options: ["默认方式", "Other (please specify)"],
    placeholder: "",
    unit: "",
  },
  {
    id: "legacy_other",
    title: "【测试替身】旧题补充什么？",
    reason: "测试旧逗号标签、ASCII冒号和多个Other候选的兼容。",
    type: "multiple",
    options: ["A", "其他，下一步由我描述", "其他（请补充）", "其他费用"],
    placeholder: "",
    unit: "",
  },
];

for (const width of [1440, 390]) {
  test(`explicit UI fixture: Other detail preserves ordinary choices and local modal draft at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const snapshot = configureFixtureModels(fixtureSnapshot());
    const draft = fixtureIntake({
      status: "questions",
      questions,
      round: 1,
      answers: [
        {
          questionId: questions[1].id,
          question: questions[1],
          state: "answered",
          value: questions[1].options[1],
          confirmation: "pending",
        },
        {
          questionId: questions[2].id,
          question: questions[2],
          state: "answered",
          value: ["A", "其他，下一步由我描述:old detail"],
          confirmation: "pending",
        },
      ],
    });
    const mutations: string[] = [];
    await page.addInitScript(({ key, id }) => localStorage.setItem(key, id), {
      key: intakeStorageKey,
      id: draft.id,
    });
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") {
        mutations.push(path);
        return route.fulfill({
          status: 500,
          json: { error: "This input fixture does not accept server mutations" },
        });
      }
      if (path === "/api/health")
        return route.fulfill({
          json: { status: "ok", accessGranted: true, model: snapshot.model },
        });
      if (path === "/api/identity")
        return route.fulfill({ json: { identityTag: "e".repeat(64), hasRecoveryCode: false } });
      if (path === `/api/intakes/${draft.id}`) return route.fulfill({ json: draft });
      return route.fulfill({
        status: 404,
        json: { error: "Explicit synthetic input fixture boundary" },
      });
    });
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: "需求梳理", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".gi-question")).toHaveCount(1);
    const optionA = dialog.getByRole("checkbox", { name: "A", exact: true });
    const optionB = dialog.getByRole("checkbox", { name: "B", exact: true });
    const other = dialog.getByRole("checkbox", { name: "其他（请补充）", exact: true });
    await optionA.check();
    await optionB.check();
    await other.check();
    const detail = dialog.getByRole("textbox", {
      name: "补充“其他（请补充）”的具体内容",
      exact: true,
    });
    await expect(detail).toBeVisible();
    await expect(detail).toHaveValue("");
    await detail.pressSequentially("custom content");
    await detail.press("Enter");
    await detail.pressSequentially("second line");
    await expect(detail).toHaveValue("custom content\nsecond line");
    await expect(optionA).toBeChecked();
    await expect(optionB).toBeChecked();
    const limit = 3000 - questions[0].options[2].length - 1 - "A".length - "B".length;
    await expect(detail).toHaveAttribute("maxlength", String(limit));
    await detail.fill("字".repeat(limit));
    await expect(detail).toHaveValue("字".repeat(limit));
    await optionB.uncheck();
    await expect(detail).toHaveAttribute("maxlength", String(limit + 1));
    await detail.press("End");
    await detail.pressSequentially("字");
    await expect(optionB).toBeDisabled();
    await detail.fill("");
    await expect(optionB).toBeEnabled();
    await optionB.check();
    await expect(other).toBeChecked();
    await expect(optionA).toBeChecked();
    await expect(optionB).toBeChecked();
    await detail.fill("本地补充内容");
    await dialog.getByRole("button", { name: "暂存并退出", exact: true }).click();
    await page.getByRole("button", { name: "继续回答", exact: true }).click();
    await expect(detail).toHaveValue("本地补充内容");
    await other.uncheck();
    await expect(detail).toHaveCount(0);
    await expect(optionA).toBeChecked();
    await expect(optionB).toBeChecked();
    await dialog.getByRole("button", { name: "下一题", exact: true }).click();
    // A legacy bare Other remains selected and editable with an empty detail.
    await expect(
      dialog.getByRole("radio", { name: "Other (please specify)", exact: true }),
    ).toBeChecked();
    const singleDetail = dialog.getByRole("textbox", {
      name: "补充“Other (please specify)”的具体内容",
      exact: true,
    });
    await expect(singleDetail).toHaveValue("");
    await singleDetail.pressSequentially("custom site");
    await expect(singleDetail).toHaveValue("custom site");
    await dialog.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(optionA).toBeChecked();
    await expect(optionB).toBeChecked();
    await expect(other).not.toBeChecked();
    await dialog.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(singleDetail).toHaveValue("custom site");
    await dialog.getByRole("radio", { name: "默认方式", exact: true }).check();
    await expect(singleDetail).toHaveCount(0);
    await dialog.getByRole("button", { name: "下一题", exact: true }).click();
    const commaOther = dialog.getByRole("checkbox", { name: "其他，下一步由我描述", exact: true });
    const canonicalOther = dialog.getByRole("checkbox", { name: "其他（请补充）", exact: true });
    const legacyDetail = dialog.getByRole("textbox", {
      name: "补充“其他，下一步由我描述”的具体内容",
      exact: true,
    });
    await expect(commaOther).toBeChecked();
    await expect(canonicalOther).toBeDisabled();
    await expect(legacyDetail).toHaveValue("old detail");
    await legacyDetail.fill("new local detail");
    await expect
      .poll(() =>
        page.evaluate(
          ({ key, questionId }) => {
            const journal = JSON.parse(sessionStorage.getItem(key)!) as { answers: IntakeAnswer[] };
            return journal.answers.find((answer) => answer.questionId === questionId)?.value;
          },
          { key: ANSWER_JOURNAL_KEY, questionId: questions[2].id },
        ),
      )
      .toEqual(["A", "其他，下一步由我描述：new local detail"]);
    await commaOther.uncheck();
    await expect(canonicalOther).toBeEnabled();
    await canonicalOther.check();
    await expect(commaOther).toBeDisabled();
    await dialog.getByRole("checkbox", { name: "其他费用", exact: true }).check();
    await expect(dialog.locator(".gi-other-answer textarea")).toHaveCount(1);
    await expect(dialog.getByRole("checkbox", { name: "A", exact: true })).toBeChecked();
    expect(mutations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });
}
