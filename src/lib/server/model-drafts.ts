import type { ModelDraft, Stage } from "@/lib/contracts";
import { atomic, db, event } from "./db";

/** Each paid attempt owns its own draft. Publishing a draft never commits a strategy. */
export function draftWriter(
  arenaId: string,
  versionId: string,
  stepId: string,
  stage: Stage,
  role: string,
) {
  const draft: ModelDraft = {
    stepId,
    versionId,
    stage,
    role,
    revision: 0,
    fields: {},
    status: "generating",
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let closed = false;
  const persist = () => {
    if (!dirty) return;
    dirty = false;
    const stored = db().prepare("SELECT body FROM model_drafts WHERE step_id=?").get(stepId) as
      | { body: string }
      | undefined;
    const previous = stored ? (JSON.parse(stored.body) as ModelDraft) : undefined;
    if (previous?.status === "interrupted") draft.status = "interrupted";
    draft.revision = Math.max(draft.revision, previous?.revision ?? 0) + 1;
    atomic(() => {
      db()
        .prepare(
          "INSERT INTO model_drafts(step_id,version_id,body) VALUES(?,?,?) ON CONFLICT(step_id) DO UPDATE SET body=excluded.body",
        )
        .run(stepId, versionId, JSON.stringify(draft));
      event(arenaId, versionId, "draft_updated", "生成中，尚未核验", stage, role, draft);
    });
  };
  return {
    preview(value: { field: string; text: string }) {
      if (closed || (Object.keys(draft.fields).length >= 60 && !(value.field in draft.fields)))
        return;
      draft.fields[value.field] = value.text.slice(0, 6000);
      dirty = true;
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          try {
            persist();
          } catch {
            /* Display failure must not interrupt receiving final usage. */
          }
        }, 150);
    },
    finish(status: ModelDraft["status"]) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      closed = true;
      draft.status = status;
      // A terminal draft is written inside the same transaction as the official result.
      const stored = db().prepare("SELECT body FROM model_drafts WHERE step_id=?").get(stepId) as
        | { body: string }
        | undefined;
      draft.revision =
        Math.max(draft.revision, stored ? (JSON.parse(stored.body) as ModelDraft).revision : 0) + 1;
      db()
        .prepare(
          "INSERT INTO model_drafts(step_id,version_id,body) VALUES(?,?,?) ON CONFLICT(step_id) DO UPDATE SET body=excluded.body",
        )
        .run(stepId, versionId, JSON.stringify(draft));
      event(
        arenaId,
        versionId,
        "draft_finished",
        status === "committed" ? "本步已完成校验" : "本次生成未作为正式结果采用",
        stage,
        role,
        draft,
      );
    },
  };
}
