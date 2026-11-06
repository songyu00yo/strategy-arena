// Explicit synthetic UI records. No model requests or evaluation outputs.
import { expect, type Page } from "@playwright/test";
import type { ArenaSnapshot, Challenge, ModelCatalogOption } from "../../src/lib/contracts";
import type { IntakeDraft } from "../../src/lib/intake-contracts";
import { MODEL_CATALOG } from "../../src/lib/model-catalog";
import { fixtureChallenge } from "./ui.fixture";

export const intakeStorageKey = "strategy-arena:intake-id";
export const fixtureModels: ModelCatalogOption[] = MODEL_CATALOG.map((model) => ({
  ...model,
  configured: true,
}));
export function configureFixtureModels(snapshot: ArenaSnapshot) {
  snapshot.model.providers = structuredClone(fixtureModels);
  snapshot.model.models = structuredClone(fixtureModels);
  return snapshot;
}
export function fixtureIntake(overrides: Partial<IntakeDraft> = {}): IntakeDraft {
  return {
    id: "fixture-intake",
    revision: 0,
    goal: fixtureChallenge.goal,
    modelMode: "gpt-6.1-terra",
    status: "input",
    round: 0,
    questions: [],
    answers: [],
    challenge: null,
    assumptions: [],
    attachments: [],
    sources: [],
    usedSourceIds: [],
    usage: [],
    error: null,
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
    arenaId: null,
    ...overrides,
  };
}

/** Quick summary fixture for existing arena regressions; guided question flow has its own suite. */
export async function installQuickIntakeFixture(
  page: Page,
  snapshot: ArenaSnapshot,
  onSubmit?: (draft: IntakeDraft, body: { challenge: Challenge; assumptions: string[] }) => void,
) {
  let draft = fixtureIntake();
  await page.route(/\/api\/intakes(?:\/[^?]*)?(?:\?.*)?$/, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname === "/api/intakes" && method === "POST") {
      const body = route.request().postDataJSON();
      draft = fixtureIntake({ goal: body.goal, modelMode: body.modelMode });
      return route.fulfill({ status: 201, json: draft });
    }
    if (method === "PATCH") {
      const body = route.request().postDataJSON();
      const { summary, ...fields } = body;
      draft = {
        ...draft,
        ...fields,
        ...(summary ? { challenge: summary.challenge, assumptions: summary.assumptions } : {}),
        revision: draft.revision + 1,
      };
    }
    if (pathname.endsWith("/analyze")) {
      draft = {
        ...draft,
        status: "summary",
        revision: draft.revision + 1,
        challenge: { ...structuredClone(fixtureChallenge), goal: draft.goal },
      };
    }
    if (pathname.endsWith("/submit")) {
      const body = route.request().postDataJSON();
      onSubmit?.(draft, body);
      return route.fulfill({ status: 201, json: snapshot });
    }
    return route.fulfill({ json: draft });
  });
}

export async function confirmFixtureIntake(page: Page, goal = fixtureChallenge.goal) {
  await page.getByLabel("你想解决什么问题？", { exact: true }).fill(goal);
  await page.getByRole("button", { name: "开始分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "这是我们理解的任务。" })).toBeVisible();
  await page.getByRole("button", { name: "开始推演", exact: true }).click();
}
