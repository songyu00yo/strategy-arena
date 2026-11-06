import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const footage = new Map([
  ...["intro", "input", "outro", "other-case-input"].map((id) => [id, "input"]),
  ...[
    "full-replay",
    "result",
    "proposal-step-and-card",
    "evidence-drawer",
    "history",
    "first-result-before-rematch",
  ].map((id) => [id, "replay"]),
  ...["initial-live-run", "rematch-input-and-live-run"].map((id) => [id, "live"]),
]);
const labels = {
  input: "示例输入画面 · 未展示模型结果",
  replay: "本次记录回看 · 真实模型结果",
  live: "实际推演录制 · 真实模型调用",
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function recordedModels(capture, clip) {
  const selections = new Map();
  for (const snapshot of capture.snapshots ?? []) {
    if (
      !clip.versionId &&
      (snapshot.sessionId !== clip.sessionId ||
        !finite(snapshot.elapsedSeconds) ||
        snapshot.elapsedSeconds < clip.startSeconds ||
        snapshot.elapsedSeconds > clip.endSeconds)
    )
      continue;
    const versionId = clip.versionId ?? snapshot.activeVersionId;
    const selection = snapshot.versions?.find(
      (version) => version.id === versionId,
    )?.modelSelection;
    if (selection?.provider && selection?.modelId)
      selections.set(`${selection.provider}:${selection.modelId}`, { versionId, ...selection });
  }
  return [...selections.values()];
}

/** Resolve every scene from a completed, identified capture clip, never an arbitrary video. */
export function validateScene(spec, scene, base) {
  if (!/^[a-f0-9]{40}$/.test(spec.commit ?? ""))
    throw new Error("Edit requires a full source commit.");
  if (typeof scene.captureManifest !== "string" || !scene.captureManifest)
    throw new Error("Scene requires a capture manifest.");
  const captureManifest = resolve(base, scene.captureManifest);
  const capture = JSON.parse(readFileSync(captureManifest, "utf8"));
  if (capture.source !== "actual-product-ui-real-api" || capture.commit !== spec.commit)
    throw new Error("Capture source or commit does not match the real product edit.");
  if (!Number.isInteger(scene.clipIndex) || scene.clipIndex < 0 || !Array.isArray(capture.clips))
    throw new Error("Scene requires an exact zero-based clipIndex.");
  const clip = capture.clips[scene.clipIndex];
  if (!clip || clip.status !== "completed")
    throw new Error("Selected capture clip must be completed.");
  const sessions = Array.isArray(capture.sessions)
    ? capture.sessions.filter((item) => item.id === clip.sessionId)
    : [];
  if (sessions.length !== 1) throw new Error("Capture clip requires one matching session.");
  const session = sessions[0];
  const health = session.health;
  if (
    !health ||
    health.commit !== spec.commit ||
    health.sourceDirty !== false ||
    health.version === "demo" ||
    health.model?.id === "demo-no-model"
  )
    throw new Error("Capture session health must identify the clean real product commit.");
  if (
    typeof clip.rawFile !== "string" ||
    !clip.rawFile ||
    typeof session.rawFile !== "string" ||
    !session.rawFile
  )
    throw new Error("Capture clip and session must identify their original recording.");
  const source = resolve(dirname(captureManifest), clip.rawFile);
  if (
    resolve(dirname(captureManifest), session.rawFile) !== source ||
    (scene.source !== undefined &&
      (typeof scene.source !== "string" || resolve(base, scene.source) !== source))
  )
    throw new Error("Scene source must match the selected clip and session recording.");
  if (!statSync(source).isFile()) throw new Error("Capture recording must be a file.");
  if (
    !finite(scene.start) ||
    scene.start < 0 ||
    !finite(scene.duration) ||
    scene.duration <= 0 ||
    !finite(clip.startSeconds) ||
    clip.startSeconds < 0 ||
    !finite(clip.endSeconds) ||
    clip.endSeconds <= clip.startSeconds ||
    scene.start < clip.startSeconds - 0.1 ||
    scene.start + scene.duration > clip.endSeconds + 0.1
  )
    throw new Error("Scene range must be finite, positive and inside the selected capture clip.");
  const footageKind = footage.get(clip.id);
  if (!footageKind) throw new Error("Capture clip has an unsupported footage kind.");
  const models = footageKind === "input" ? [] : recordedModels(capture, clip);
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const providerLabel = providers
    .map((provider) => ({ deepseek: "DeepSeek", openai: "GPT" })[provider] ?? provider)
    .join(" / ");
  const suppliedProvider = scene.provider ?? spec.provider;
  if (
    footageKind !== "input" &&
    suppliedProvider !== undefined &&
    suppliedProvider !== providerLabel
  )
    throw new Error(
      "Scene provider must match the selected clip's recorded model selection; omit it when unavailable.",
    );
  if (scene.label !== undefined && (typeof scene.label !== "string" || !scene.label.trim()))
    throw new Error("Scene label must be nonempty text when supplied.");
  return {
    source,
    captureManifest,
    capture,
    clip,
    footageKind,
    models,
    providerLabel,
    label: scene.label ?? labels[footageKind],
  };
}
