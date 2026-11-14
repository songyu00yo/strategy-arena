#!/usr/bin/env node
/** Actual product recording. Default prepares speech only; --render explicitly authorizes two UI runs. */
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = resolve(root, "work/video");
mkdirSync(work, { recursive: true });
const valueOptions = new Set([
  "--base-url",
  "--commit",
  "--version",
  "--output",
  "--target-seconds",
  "--rate",
  "--max-cny",
  "--server-run-cap",
]);
const flags = new Set(["--render", "--prepare-only", "--resume", "--help"]);
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (flags.has(key)) options[key] = true;
  else if (valueOptions.has(key) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
    options[key] = process.argv[++i];
  else throw new Error(`Unknown or incomplete option: ${key}`);
}
if (options["--help"]) {
  console.log(
    "Default: prepare Tingting narration, captions and storyboard in work/video; NO network/model calls.\nnode scripts/build-demo-video.mjs --prepare-only\nFinal capture: --render --base-url http://127.0.0.1:PORT --commit FULL_SHA --version 0.2.0 --server-run-cap 1.5\nRead-only pickup: add --resume after a selector failure; needs two completed versions and the original live clips, never creates a new run.\nOptional: --target-seconds 360 --rate 185 --max-cny 2 --output work/video/demo-preview.mp4\nThe production server MUST enforce ARENA_RUN_BUDGET_CNY <= 2 for the whole arena plus versions. Polling is only a secondary guard. Auth state stays private in work/video and is never packaged.",
  );
  process.exit(0);
}
if (options["--render"] && options["--prepare-only"])
  throw new Error("Choose --render or --prepare-only");
if (options["--resume"] && !options["--render"])
  throw new Error("--resume requires --render and never creates paid runs");
const priorManifest = options["--resume"]
  ? JSON.parse(readFileSync(resolve(work, "capture-manifest.json"), "utf8"))
  : null;
const priorNarration = options["--resume"]
  ? JSON.parse(readFileSync(resolve(work, "narration.json"), "utf8"))
  : null;
if (
  priorManifest &&
  !["01-intro", "02-input", "03-live"].every((id) =>
    priorManifest.clips.some((clip) => clip.id === id),
  )
)
  throw new Error(
    "Resume needs the three original introduction/input/live clips; it cannot fabricate missing live capture",
  );
const version = options["--version"] || "0.2.0";
const target = Number(options["--target-seconds"] || 360);
const rate = Number(options["--rate"] || 185);
const maxCny = Number(options["--max-cny"] || 2);
const serverCap = Number(options["--server-run-cap"] || process.env.ARENA_RUN_BUDGET_CNY || 1.5);
if (!Number.isFinite(target) || target < 300 || target > 480)
  throw new Error("Target must be 300–480 seconds");
if (!Number.isFinite(rate) || rate < 140 || rate > 230)
  throw new Error("Speech rate must be 140–230");
if (!Number.isFinite(maxCny) || maxCny <= 0 || maxCny > 2)
  throw new Error("This demo is limited to at most CNY2");
if (!Number.isFinite(serverCap) || serverCap <= 0 || serverCap > maxCny)
  throw new Error("The confirmed server arena cap must be positive and <= the demo budget");
const commit = options["--commit"] || null;
const base = options["--base-url"] ? new URL(options["--base-url"]) : null;
if (
  options["--render"] &&
  (!base ||
    !/^https?:$/.test(base.protocol) ||
    base.username ||
    base.password ||
    !/^[a-f0-9]{40}$/i.test(commit || ""))
)
  throw new Error("Rendering requires a credential-free production URL and full final SHA");
const output = resolve(root, options["--output"] || "work/video/strategy-arena-0.2.0-preview.mp4");
if (!output.endsWith(".mp4")) throw new Error("Output must end with .mp4");
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
const probe = (path) =>
  JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      path,
    ]).toString(),
  );
const duration = (path) => Number(probe(path).format.duration);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeWrite = (path, value) => {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
};
const concatLine = (path) => `file '${path.replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenes = [
  {
    id: "01-intro",
    title: "从问题到可行动的路线",
    source: "实际界面 · 尚未启动收费推演",
    text: "这是方案擂台零点二版本的预览演示。本片使用婷婷合成普通话旁白，画面会持续标明这一点。方案擂台面向学习、生活、工作和创作中的具体决策。用户可以提出目标、已有选项，或者一个还不成熟的想法。系统把目标展开为三条路线，再让关键判断接受质疑、证据核验和修订。本片输入是明确标注的合成测试材料，不是真实用户研究，也不展示模拟生成结果。",
  },
  {
    id: "02-input",
    title: "同一个目标，明确不同条件",
    source: "实际界面 · 规范合成输入",
    text: "现在填写统一的视频任务。目标是七天内，用十二张已有照片制作九十秒、有字幕、无水印的高清视频。总投入只有八小时，预算三百元。候选路线是模板、本地剪辑和人工智能生成镜头。硬性限制与个人偏好分别填写，预算和时间也单独保存。测试材料明确写出，三个合格镜头曾经历两次、三次和四次尝试，每次八分钟。后期一百二十分钟只是估计。导出权限、订阅价格和未来成功率，仍然需要核实。",
  },
  {
    id: "03-live",
    title: "真实实况：独立提案到交叉质疑",
    source: "实况 · 真实 API 调用 / 合成输入",
    text: "点击开始后，下面显示的是本次真实调用，不是预设播放。阶段状态和现场记录来自服务端事件，模型还在处理时也会更新。三条路线使用同一个已配置模型，但独立提案时不读取其他路线。随后才进入交叉质疑、工具核验、策略修订和条件裁决。角色名字不代表三个独立训练的模型，它们仍可能有相同盲点。模型等待时间可能较长，本片会剪去部分等待；完成后的画面会明确标为本次记录回看，不会制造虚假的生成速度。",
  },
  {
    id: "04-strategies",
    title: "回看本次真实提案与具体判断",
    source: "回看 · 本次真实记录 / 已完成",
    text: "现在回看刚才完成的真实记录。三条路线分别列出核心思路、行动步骤、所需资源、第一步和失效条件。关键判断区分用户提供、估算、未知和有材料支持。一个看起来精确的时间或价格，如果来自估计，就不能当作事实。交叉质疑必须指向具体主张和原话，说明哪一个前提可能失败，以及失败后会改变哪项选择。这里不按攻击数量计分，也不会为了选出赢家而掩盖未知。用户还可以点击具体判断，补充自己的反例或限制。",
  },
  {
    id: "05-evidence",
    title: "打开一条攻击，核对原话与证据",
    source: "回看 · 真实工具记录",
    text: "打开一条质疑，可以按顺序查看原话、挑战理由、核验办法、工具返回和路线回应。材料检索只查找用户粘贴的文字，不是实时互联网搜索。计算器保留表达式、结果和假设，只执行受限算术。工具没有找到依据时，记录会明确保留不可用或未决。比如九次尝试乘以每次八分钟，只能说明已给样本的七十二分钟，不能证明未来镜头一定成功。再加估计的后期时间，也不能代替完整工时核算。证据可定位，仍然不等于推理自动正确。",
  },
  {
    id: "06-revision",
    title: "查看修订前后，而不只看态度",
    source: "回看 · 本次修订差异",
    text: "修订阶段需要给出完整的新策略，并逐条说明接受、反驳或保留未决。展开修订前后，可以核对行动步骤、资源、第一步、失效条件和投入估算的真实变化。行动没有改变时，界面会说明保留原内容，不把所有回应都写成认输。其他路线借鉴一项质疑，也会单独标明来源和自身修改。裁决会继续回应每条攻击，并列出建议成立的条件、仍需确认的事项、下一步和退出条件。改了多少字不能证明方案更好，关键仍是变化有没有解决实际问题。",
  },
  {
    id: "07-rematch",
    title: "新增真实画面限制，再次推演",
    source: "界面操作 → 第二次真实 API 推演",
    text: "现在通过产品的修改条件入口，补上一条限制：所有画面必须来自真实记录，禁止生成虚构画面。其他规范输入保留，并写明修改原因。提交后产生第二个版本，原版本的结果和费用继续保存。新限制是否影响推荐，需要由这次实际推演决定。本片不要求推荐路线一定翻转；即使仍选同一条路线，也要检查步骤、资源和失效条件是否合理调整。新版运行时，旧请求只能写入原版本，延迟响应不能把页面退回旧条件。现场事件仍来自这次真实执行。",
  },
  {
    id: "08-history",
    title: "回看两个版本与本次实际费用",
    source: "回看 · 两版真实结果",
    text: "第二轮完成后，可以在版本选择器中切换。历史版本保持只读，能够回到当时的条件、主张、证据和裁决。这里显示本次实际记录的推荐，不预先指定路线，也不把保持同一推荐解释为验证成功。费用区显示按已记录用量计算的估算，调用中预留额另列，最终金额仍以服务商账单为准。已知格式或引用错误最多尝试一次显式修复，原失败和修复都记入用量。超时或请求状态未知时停止自动重试，避免把网络中断当作肯定没有计费。",
  },
  {
    id: "09-limits",
    title: "阶段边界与可复现材料",
    source: "v0.2.0 预览 · 合成旁白",
    text: "零点二版本目前完成文字条件、角色推演、材料与算术工具、证据追溯和版本重赛。图像理解、互联网搜索和公开分享不在本次完成范围内。自动测试与真实联调证明部分工程行为，不能代替人工质量评分，也不能证明优于强单助手。最终材料需要让源码、部署、评测、截图和报告对应同一个构建标识。本片保存两次真实快照、画面与费用记录，会话身份单独私密保存，不进入视频交付包。方案擂台希望让条件更清楚，让证据可检查，让下一步行动能够修改。",
  },
];
if (priorManifest && !priorManifest.clips.some((clip) => clip.id === "07-rematch")) {
  scenes[6].source = "补录回看 · 已有两版真实记录 / 无新调用";
  scenes[6].text =
    "这一段是对已完成条件变化的补录回看，没有再次调用模型。此前通过修改条件入口，加入了所有画面必须来自真实记录、禁止生成虚构画面的限制。这里打开表单核对保存的条件，随后取消，不提交新的版本。原始测试材料和修改原因都可以检查。新的限制是否影响推荐，应当以已经保存的实际结果为准，不要求推荐一定翻转。即使仍选同一条路线，也要核对步骤、资源和失效条件。两次实际推演与费用都保留在同一个任务中。";
}
function chunks(text) {
  const sentences = text.match(/[^。！？]+[。！？]?/g) || [];
  return sentences.flatMap((sentence) => {
    if ([...sentence].length <= 58) return [sentence];
    const pieces = sentence.match(/[^，；]+[，；]?/g) || [sentence];
    const out = [];
    let pending = "";
    for (const piece of pieces) {
      if ([...(pending + piece)].length > 54 && pending) {
        out.push(pending);
        pending = "";
      }
      pending += piece;
    }
    if (pending) out.push(pending);
    return out;
  });
}
function timestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}
function caption(text) {
  const chars = [...text];
  if (chars.length <= 28) return text;
  const middle = Math.ceil(chars.length / 2);
  return chars.slice(0, middle).join("") + "\n" + chars.slice(middle).join("");
}
const audioDir = resolve(work, "audio");
mkdirSync(audioDir, { recursive: true });
let rawTotal = 0;
for (const scene of scenes) {
  scene.units = [];
  for (const [index, text] of chunks(scene.text).entries()) {
    const stem = resolve(audioDir, `${scene.id}-${index + 1}`);
    const aiff = `${stem}.aiff`;
    const signature = hash(`Tingting|${rate}|${text}`);
    if (
      !existsSync(aiff) ||
      !existsSync(`${stem}.sha256`) ||
      readFileSync(`${stem}.sha256`, "utf8") !== signature
    ) {
      safeWrite(`${stem}.txt`, text);
      run("say", ["-v", "Tingting", "-r", String(rate), "-f", `${stem}.txt`, "-o", aiff]);
      safeWrite(`${stem}.sha256`, signature);
    }
    const seconds = duration(aiff);
    rawTotal += seconds;
    scene.units.push({ text, aiff, rawSeconds: seconds });
  }
}
const tempo = priorNarration?.tempo ?? rawTotal / (target - scenes.length);
if (tempo < 0.75 || tempo > 1.3)
  throw new Error(`Speech tempo ${tempo.toFixed(2)} outside natural range; adjust --rate`);
let cursor = 0;
let subtitleIndex = 1;
let srt = "";
for (const scene of scenes) {
  const list = resolve(audioDir, `${scene.id}.ffconcat`);
  safeWrite(list, scene.units.map((unit) => concatLine(unit.aiff)).join("\n"));
  scene.audio = resolve(audioDir, `${scene.id}.wav`);
  const sceneTempo =
    priorManifest &&
    scene.id === "07-rematch" &&
    !priorManifest.clips.some((clip) => clip.id === scene.id)
      ? scene.units.reduce((sum, unit) => sum + unit.rawSeconds, 0) /
        (priorNarration.scenes.find((item) => item.id === scene.id).duration - 1)
      : tempo;
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-af",
    `atempo=${sceneTempo},adelay=300,apad=pad_dur=0.7,loudnorm=I=-16:TP=-1.5:LRA=11`,
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    scene.audio,
  ]);
  scene.duration = duration(scene.audio);
  let local = 0.3;
  for (const unit of scene.units) {
    unit.seconds = unit.rawSeconds / sceneTempo;
    srt += `${subtitleIndex++}\n${timestamp(cursor + local)} --> ${timestamp(cursor + local + unit.seconds)}\n${caption(unit.text)}\n\n`;
    local += unit.seconds;
  }
  scene.globalStart = cursor;
  cursor += scene.duration;
}
safeWrite(resolve(work, "narration.srt"), srt);
safeWrite(
  resolve(work, "narration.json"),
  JSON.stringify(
    {
      voice: "Tingting",
      syntheticVoice: true,
      previewVersion: version,
      targetSeconds: target,
      preparedSeconds: cursor,
      tempo,
      scenes,
    },
    null,
    2,
  ),
);
safeWrite(
  resolve(work, "storyboard.md"),
  `# 方案擂台 ${version} 预览演示\n\n普通话旁白：macOS Tingting，合成语音。目标 1920 × 1080、约 ${Math.round(cursor)} 秒。准备阶段不请求网络或模型。\n\n${scenes.map((scene) => `## ${scene.id}　${scene.title}\n\n来源：${scene.source}。时长约 ${scene.duration.toFixed(1)} 秒。\n\n${scene.text}\n`).join("\n")}\n## 录制与隐私\n\n最终录制必须显式使用 --render，核对生产 health 的完整 SHA 与版本。通过真实产品界面跑规范样例和一次新增真实画面限制重赛，最多两个版本。不得使用路由替身、预设结果或伪造进度。模型等待可剪去，回看必须标明。生产服务应设置 ARENA_RUN_BUDGET_CNY 不超过 2，脚本轮询只是补充保护。auth-state.json 权限为 0600，不进入任何交付包。\n`,
);
console.log(
  `Prepared ${scenes.length} scenes, ${cursor.toFixed(1)} seconds, Tingting synthetic narration. No model calls during preparation.`,
);
if (!options["--render"]) process.exit(0);

const browser = await chromium.launch({ headless: true });
const rawDir = resolve(work, "raw");
mkdirSync(rawDir, { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: rawDir, size: { width: 1920, height: 1080 } },
  ...(priorManifest ? { storageState: resolve(work, "auth-state.json") } : {}),
});
const page = await context.newPage();
const recordingStarted = Date.now();
const captureId = `capture-${Date.now()}`;
const manifest = priorManifest
  ? { ...priorManifest, status: "recording", resumedAt: new Date().toISOString() }
  : {
      kind: "actual-product-live-demo-on-synthetic-input",
      status: "recording",
      previewVersion: version,
      expectedCommit: commit,
      syntheticNarration: "macOS say / Tingting",
      startedAt: new Date().toISOString(),
      serverRunCapConfirmedCny: serverCap,
      hardCapSource:
        "Caller-confirmed production ARENA_RUN_BUDGET_CNY; polling is not the hard limit",
      maxCny,
      clips: [],
      versions: [],
      consoleErrors: [],
      pageErrors: [],
      httpErrors: [],
      captureSources: {},
      checks: {},
    };
const manifestPath = resolve(work, "capture-manifest.json");
manifest.captureSources ||= {};
manifest.checks ||= {};
manifest.pageErrors ||= [];
if (priorManifest && priorManifest.expectedCommit !== commit)
  throw new Error("Resume SHA differs from the original capture");
let arenaId = priorManifest?.arenaId;
let lastSnapshot;
let videoPath;
page.on("pageerror", (error) => manifest.pageErrors.push(error.message.slice(0, 500)));
page.on("console", (message) => {
  if (message.type() === "error") manifest.consoleErrors.push(message.text().slice(0, 500));
});
page.on("response", (response) => {
  if (response.status() >= 400)
    manifest.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() });
});
async function saveState() {
  await context.storageState({ path: resolve(work, "auth-state.json") });
  chmodSync(resolve(work, "auth-state.json"), 0o600);
}
async function snapshot() {
  const response = await context.request.get(new URL(`/api/arenas/${arenaId}`, base).href);
  if (!response.ok()) throw new Error(`Snapshot HTTP ${response.status()}`);
  lastSnapshot = await response.json();
  safeWrite(resolve(work, "latest-snapshot.json"), JSON.stringify(lastSnapshot, null, 2));
  const spent = lastSnapshot.versions.reduce(
    (sum, item) => sum + item.costCny + item.reservedCny,
    0,
  );
  if (spent > maxCny - 0.05) {
    const stop = page.getByRole("button", { name: "现在收束", exact: true });
    if (await stop.isVisible()) {
      await stop.click();
      await page.getByRole("button", { name: "确认停止", exact: true }).click();
    }
    throw new Error(
      "Secondary budget guard stopped capture; inspect current reservations before any further call",
    );
  }
  return lastSnapshot;
}
async function terminal(number) {
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const state = await snapshot();
    const current = state.versions.find((item) => item.number === number);
    if (!current) throw new Error(`Version ${number} missing`);
    if (!["ready", "running"].includes(current.status)) {
      safeWrite(
        resolve(work, `actual-version-${number}.json`),
        JSON.stringify(
          {
            kind: manifest.kind,
            capturedAt: new Date().toISOString(),
            productionCommit: commit,
            snapshot: state,
          },
          null,
          2,
        ),
      );
      manifest.versions.push({
        number,
        id: current.id,
        status: current.status,
        preferred: current.verdict?.preferred ?? null,
        costCny: current.costCny,
        reservedCny: current.reservedCny,
        error: current.error,
      });
      await saveState();
      if (current.status !== "completed")
        throw new Error(`Real version ${number} ended ${current.status}; no automatic repeat`);
      return current;
    }
    await sleep(2000);
  }
  throw new Error("Real run still pending after four minutes; no automatic new run");
}
async function overlay(scene, text = "") {
  await page.evaluate(
    ({ title, source, text, version, commit }) => {
      let el = document.getElementById("demo-recording-annotations");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-recording-annotations";
        el.innerHTML =
          '<div class="demo-badge"></div><div class="demo-subtitle"><span></span><p></p></div>';
        document.body.append(el);
        const style = document.createElement("style");
        style.textContent =
          '#demo-recording-annotations{position:fixed;inset:0;z-index:2147483600;pointer-events:none;font-family:Arial,"PingFang SC",sans-serif}.demo-badge{position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:8px 18px;border:1px solid #d5dccb;background:#fffefaf2;color:#536347;font-size:15px;letter-spacing:.4px;white-space:nowrap}.demo-subtitle{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);width:1560px;max-width:94%;padding:12px 24px 15px;background:#fffefaf5;border:1px solid #d9dfcf;border-top:3px solid #254fe3;box-shadow:0 4px 24px #20301014;text-align:center}.demo-subtitle>span{font-size:16px;letter-spacing:1px;color:#254fe3}.demo-subtitle p{font-size:29px;font-weight:500;line-height:1.5;margin:7px 0 0;color:#20251e;white-space:pre-line}.demo-subtitle p:empty{display:none}';
        document.head.append(style);
      }
      el.querySelector(".demo-badge").textContent =
        `v${version} 预览 · Tingting 合成旁白 · ${commit.slice(0, 12)}`;
      el.querySelector(".demo-subtitle>span").textContent = `${title}　｜　${source}`;
      el.querySelector(".demo-subtitle p").textContent = text;
    },
    { title: scene.title, source: scene.source, text, version, commit },
  );
}
async function scene(index, actions = {}) {
  const item = scenes[index];
  if (priorManifest && manifest.clips.some((clip) => clip.id === item.id)) return;
  const start = Date.now();
  await overlay(item);
  await sleep(300);
  for (const [unitIndex, unit] of item.units.entries()) {
    const begin = Date.now();
    await overlay(item, caption(unit.text));
    if (actions[unitIndex]) await actions[unitIndex]();
    await sleep(Math.max(0, unit.seconds * 1000 - (Date.now() - begin)));
  }
  await overlay(item);
  const remaining = item.duration * 1000 - (Date.now() - start);
  if (remaining > 0) await sleep(remaining);
  manifest.clips.push({
    id: item.id,
    captureId,
    title: item.title,
    source: item.source,
    videoStartSeconds: (start - recordingStarted) / 1000,
    duration: item.duration,
    audio: relative(root, item.audio),
  });
  await page.screenshot({ path: resolve(work, `${item.id}.png`) });
  safeWrite(manifestPath, JSON.stringify(manifest, null, 2));
}
try {
  const healthResponse = await context.request.get(new URL("/api/health", base).href);
  if (!healthResponse.ok()) throw new Error("Production health failed");
  const health = await healthResponse.json();
  manifest.health = health;
  if (health.commit !== commit || health.version !== version || !health.model?.configured)
    throw new Error("Production SHA/version/model does not match requested final capture");
  if (health.requiresAccessCode && !health.accessGranted) {
    if (!process.env.DEMO_ACCESS_CODE)
      throw new Error(
        "Production requires private DEMO_ACCESS_CODE; never pass it on the command line",
      );
    const access = await context.request.post(new URL("/api/access", base).href, {
      data: { code: process.env.DEMO_ACCESS_CODE },
      headers: { Origin: base.origin },
    });
    if (!access.ok()) throw new Error("Demo access was not granted");
  }
  if (priorManifest) {
    const previous = await snapshot();
    if (
      previous.versions.length !== 2 ||
      previous.versions.some((item) => item.status !== "completed")
    )
      throw new Error(
        "Read-only resume requires two already-completed versions. It will not create or advance any paid run.",
      );
    await page.addInitScript((id) => localStorage.setItem("strategy-arena:last-id", id), arenaId);
  }
  await page.goto(base.href, { waitUntil: "domcontentloaded" });
  let first;
  if (!priorManifest) {
    await page.getByRole("button", { name: "试填一个视频任务" }).waitFor();
    await scene(0);
    await page.getByRole("button", { name: "试填一个视频任务" }).click();
    if (!(await page.getByLabel("你的目标、备选方案或想法").inputValue()).includes("九十秒"))
      throw new Error("Visible sample is not the canonical ninety-second case");
    await scene(1, {
      2: () => page.getByLabel(/参考材料/).scrollIntoViewIfNeeded(),
      5: () =>
        page.getByRole("button", { name: "让方案上场", exact: true }).scrollIntoViewIfNeeded(),
    });
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/arenas" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "让方案上场", exact: true }).click();
    const response = await created;
    if (!response.ok()) throw new Error(`Real create HTTP ${response.status()}`);
    arenaId = (await response.json()).id;
    manifest.arenaId = arenaId;
    await saveState();
    await page.locator(".stage-rail").waitFor();
    await page.getByRole("button", { name: /现场记录/ }).click();
    await scene(2, {
      1: () => page.locator(".stage-rail").scrollIntoViewIfNeeded(),
      4: () => snapshot(),
    });
    first = await terminal(1);
  } else {
    await page.getByLabel("选择推演版本").waitFor();
    first = lastSnapshot.versions.find((item) => item.number === 1);
    await page.getByLabel("选择推演版本").selectOption(first.id);
  }
  await page.locator(".strategy-grid").scrollIntoViewIfNeeded();
  await scene(3, {
    2: () => page.locator(".claim-list").first().scrollIntoViewIfNeeded(),
    4: () => page.locator(".attack-list").first().scrollIntoViewIfNeeded(),
  });
  await page.locator(".attack-item").first().click();
  await page.locator(".evidence-drawer").waitFor();
  await sleep(400);
  await scene(4, {
    1: () => page.locator(".evidence-item").first().scrollIntoViewIfNeeded(),
    4: async () => {
      const finding = page.locator(".finding-section");
      if (await finding.count()) await finding.scrollIntoViewIfNeeded();
    },
  });
  await page.keyboard.press("Escape");
  manifest.checks.evidenceEsc = (await page.locator(".evidence-drawer").count()) === 0;
  const diff = page.locator(".revision-diff").first();
  await diff.locator("summary").click();
  await diff.scrollIntoViewIfNeeded();
  await scene(5, { 3: () => page.locator(".verdict").scrollIntoViewIfNeeded() });
  if (!priorManifest) {
    await page.getByRole("button", { name: "修改条件再开局" }).click();
    const dialog = page.getByRole("dialog", { name: "修改条件，重新开局" });
    await dialog
      .getByLabel(/硬性限制/)
      .fill(first.challenge.constraints + "\n所有画面必须来自真实记录，禁止生成虚构画面。");
    await dialog
      .getByLabel(/这次为什么修改/)
      .fill("演示的真实条件变化：新增真实画面限制，保留原始输入并重新检查路线与行动。");
    await scene(6, {
      3: async () => {
        await dialog.getByRole("button", { name: "按新条件重新推演" }).click();
        await page.locator(".stage-rail").waitFor();
        await page.locator(".stage-rail").scrollIntoViewIfNeeded();
      },
    });
    await terminal(2);
  } else if (!manifest.clips.some((clip) => clip.id === "07-rematch")) {
    await page.getByLabel("选择推演版本").selectOption(lastSnapshot.activeVersionId);
    await page.getByRole("button", { name: "修改条件再开局" }).click();
    await scene(6, {
      3: async () => {
        await page.keyboard.press("Escape");
        await page.locator(".stage-rail").scrollIntoViewIfNeeded();
      },
    });
  }
  await page.locator(".arena-intro").scrollIntoViewIfNeeded();
  await scene(7, {
    1: () => page.getByLabel("选择推演版本").selectOption(first.id),
    3: () => page.getByLabel("选择推演版本").selectOption(lastSnapshot.activeVersionId),
    5: () => page.locator(".arena-cost").scrollIntoViewIfNeeded(),
  });
  await page.getByRole("button", { name: "真实模型推演" }).click();
  await scene(8, {
    3: async () => {
      await page.keyboard.press("Escape");
      await page.locator(".verdict").scrollIntoViewIfNeeded();
    },
  });
  await page.keyboard.press("Escape");
  await page.getByLabel("选择推演版本").selectOption(first.id);
  manifest.checks.historyReadOnly = (await page.locator(".historical-tag").innerText()) === "只读";
  manifest.checks.historyClaimsDisabled = await page
    .locator(".claim")
    .evaluateAll((nodes) => nodes.length > 0 && nodes.every((node) => node.disabled));
  await page.getByLabel("选择推演版本").selectOption(lastSnapshot.activeVersionId);
  const expectedArena = arenaId;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("选择推演版本").waitFor();
  manifest.checks.refreshRestoresArena =
    (await page.evaluate(() => localStorage.getItem("strategy-arena:last-id"))) === expectedArena &&
    (await page.getByLabel("选择推演版本").inputValue()) === lastSnapshot.activeVersionId;
  manifest.checks.desktopNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: /^B/ }).click();
  await sleep(400);
  manifest.checks.mobileNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  await page.screenshot({ path: resolve(work, "mobile-390-real-page.png"), fullPage: true });
  await page.locator(".strategy-column.mobile-active .attack-item").first().click();
  await sleep(400);
  await page.screenshot({ path: resolve(work, "mobile-390-real-evidence.png") });
  await page.keyboard.press("Escape");
  manifest.checks.mobileEvidenceEsc = (await page.locator(".evidence-drawer").count()) === 0;
  await page.setViewportSize({ width: 1920, height: 1080 });
  manifest.status = "captured";
  delete manifest.error;
  manifest.finishedAt = new Date().toISOString();
  manifest.totalCostCny = lastSnapshot.versions.reduce((sum, item) => sum + item.costCny, 0);
  await saveState();
} catch (error) {
  manifest.status = "failed";
  manifest.error = error.message;
  manifest.finishedAt = new Date().toISOString();
  await page.screenshot({ path: resolve(work, "capture-failure.png") }).catch(() => {});
  await finishSource();
  await browser.close();
  safeWrite(manifestPath, JSON.stringify(manifest, null, 2));
  throw new Error(
    `${error.message}. No automatic repeated run; --resume only reuses an existing completed two-version arena and original live footage.`,
  );
}
await finishSource();
await browser.close();
manifest.clips.sort(
  (a, b) =>
    scenes.findIndex((item) => item.id === a.id) - scenes.findIndex((item) => item.id === b.id),
);
safeWrite(manifestPath, JSON.stringify(manifest, null, 2));
async function finishSource() {
  const video = page.video();
  const wallDuration = (Date.now() - recordingStarted) / 1000;
  await context.close();
  videoPath = await video.path();
  chmodSync(videoPath, 0o600);
  manifest.captureSources[captureId] = {
    recordingScriptSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    file: relative(root, videoPath),
    offset: Math.max(0, duration(videoPath) - wallDuration),
  };
}
const clipDir = resolve(work, "clips");
mkdirSync(clipDir, { recursive: true });
for (const item of manifest.clips) {
  const clip = resolve(clipDir, `${item.id}.mp4`);
  item.file = relative(root, clip);
  run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(item.videoStartSeconds + manifest.captureSources[item.captureId].offset),
    "-i",
    resolve(root, manifest.captureSources[item.captureId].file),
    "-i",
    resolve(root, item.audio),
    "-t",
    String(item.duration),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-vf",
    "fps=30,scale=1920:1080,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    clip,
  ]);
}
const list = resolve(work, "clips.ffconcat");
safeWrite(list, manifest.clips.map((item) => concatLine(resolve(root, item.file))).join("\n"));
mkdirSync(dirname(output), { recursive: true });
run("ffmpeg", [
  "-y",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  list,
  "-c",
  "copy",
  "-movflags",
  "+faststart",
  output,
]);
const media = probe(output);
const stream = media.streams.find((item) => item.codec_type === "video");
const audio = media.streams.find((item) => item.codec_type === "audio");
if (
  stream.width !== 1920 ||
  stream.height !== 1080 ||
  stream.codec_name !== "h264" ||
  audio?.codec_name !== "aac" ||
  Number(media.format.duration) < 300 ||
  Number(media.format.duration) > 480
)
  throw new Error("Final MP4 failed format or duration checks");
manifest.status = "rendered-preview";
manifest.output = relative(root, output);
manifest.outputSha256 = hash(readFileSync(output));
manifest.media = {
  duration: Number(media.format.duration),
  width: stream.width,
  height: stream.height,
  videoCodec: stream.codec_name,
  audioCodec: audio.codec_name,
};
manifest.rawVideo = relative(root, videoPath);
safeWrite(manifestPath, JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify(
    {
      status: manifest.status,
      commit,
      output: manifest.output,
      media: manifest.media,
      totalEstimatedCny: manifest.totalCostCny,
      versions: manifest.versions,
      note: "Synthetic narration; actual product/API records on synthetic input. auth-state.json is private and must not be packaged.",
    },
    null,
    2,
  ),
);
