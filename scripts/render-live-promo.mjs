#!/usr/bin/env node
/** Local postproduction only. Input shots must point to preserved real capture footage. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { validateScene } from "./promo-render/provenance.mjs";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/render-live-promo.mjs EDIT.json");
const specPath = resolve(input);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const base = dirname(specPath);
const output = resolve(base, spec.output || "promo.mp4");
const work = resolve(base, "render");
mkdirSync(work, { recursive: true });
const run = (cmd, args) =>
  execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16e6 });
const probe = (path) =>
  JSON.parse(run("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path]));
const seconds = (path) => Number(probe(path).format.duration);
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const safe = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const listLine = (path) => `file '${path.replaceAll("'", "'\\''")}'`;
if (spec.kind !== "real-product-promo" || !/^[a-f0-9]{40}$/.test(spec.commit || ""))
  throw new Error("A real-product-promo edit and full source commit are required.");
const transition = 0.4;
const total =
  spec.scenes.reduce((sum, scene) => sum + scene.duration, 0) -
  transition * (spec.scenes.length - 1);
if (total < 90 || total > 120) throw new Error("Promo duration must be 90–120 seconds.");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const subtitles = [];
const provenance = [];
let cursor = 0;

async function overlay(path, scene, caption = "", opening = false) {
  await page.setContent(`<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;background:transparent;font-family:"PingFang SC","Hiragino Sans GB",sans-serif;color:#151a25}
  .top{position:absolute;inset:0 0 auto;height:155px;background:linear-gradient(#f8f9fbd9,#f8f9fbc9,transparent)}
  .brand{position:absolute;left:56px;top:30px;font-size:18px;font-weight:700;letter-spacing:3px;color:#566079}
  .dot{display:inline-block;width:11px;height:11px;border-radius:50%;background:#376df7;margin-right:12px;box-shadow:0 0 20px #70a3ffaa}
  .heading{position:absolute;left:55px;top:63px;font-size:36px;font-weight:650;letter-spacing:1px}
  .source{position:absolute;right:56px;top:32px;padding:10px 16px;background:#ffffffe8;border:1px solid #dce1ed;border-radius:30px;font-size:17px;letter-spacing:1px;color:#475267}
  .caption{position:absolute;bottom:34px;left:230px;width:1460px;text-align:center;font-size:30px;font-weight:550;letter-spacing:.6px}
  .caption span{display:inline-block;padding:15px 30px;background:#ffffffed;border:1px solid #dce1ed;border-radius:16px;box-shadow:0 7px 35px #28375313}
  .footer{position:absolute;bottom:9px;left:56px;font-size:13px;color:#556077;background:#ffffffcc;padding:3px 8px;border-radius:4px}
  .intro{position:absolute;inset:0;background:linear-gradient(90deg,#f9fafcf7 0%,#f9fafcf5 29%,#f9fafcbf 42%,transparent 64%)}
  .kicker{position:absolute;left:90px;top:260px;font-size:19px;letter-spacing:5px;color:#376df7;font-weight:650}
  .hero{position:absolute;left:86px;top:315px;font-size:86px;line-height:1.2;letter-spacing:-3px;font-weight:750;white-space:pre-line}
  .sub{position:absolute;left:92px;top:560px;font-size:27px;line-height:1.8;color:#586375;max-width:560px}
  .line{position:absolute;left:92px;top:690px;width:90px;height:5px;background:#376df7;border-radius:4px}
  </style></head><body>${opening ? `<div class="intro"></div><div class="kicker">STRATEGY ARENA</div><div class="hero">${safe(scene.hero || "让方案上场。")}</div><div class="sub">${safe(scene.sub || "从一个目标，到可检查的下一步。")}</div><div class="line"></div>` : ""}
  <div class="top"></div><div class="brand"><i class="dot"></i>方案擂台</div><div class="heading">${safe(scene.heading || "")}</div>
  <div class="source">${safe(scene.label || "本次记录回看 · 真实模型结果")}</div>
  ${caption ? `<div class="caption"><span>${safe(caption)}</span></div>` : ""}
  <div class="footer">${scene.footageKind === "input" ? "真实产品录屏 · 示例输入" : `示例任务 · ${safe(spec.provider || "DeepSeek")} 真实模型结果`}${scene.waitCut ? " · 已剪去模型等待" : ""}${scene.outro ? " · 普通话合成旁白" : ""}</div></body></html>`);
  await page.screenshot({ path, omitBackground: true });
}

try {
  for (let index = 0; index < spec.scenes.length; index++) {
    const scene = { ...spec.scenes[index] };
    const verified = validateScene(spec, scene, base);
    const source = verified.source;
    scene.footageKind = verified.footageKind;
    scene.label = verified.label;
    if (!existsSync(source) || scene.start < 0 || !(scene.duration > 0))
      throw new Error(`Invalid source in scene ${index}`);
    if (scene.start + scene.duration > seconds(source) + 0.15)
      throw new Error(`Scene ${index} exceeds original recording; cannot fabricate footage.`);
    const sourceManifest = verified.captureManifest;
    const prefix = join(work, `scene-${String(index).padStart(2, "0")}`);
    let speechTime = 0.45;
    const lines = [];
    const audioParts = [];
    const silence = `${prefix}-silence.wav`;
    run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-t",
      "0.45",
      silence,
    ]);
    audioParts.push(silence);
    for (let lineIndex = 0; lineIndex < scene.narration.length; lineIndex++) {
      const text = scene.narration[lineIndex];
      const textFile = `${prefix}-speech-${lineIndex}.txt`;
      const aiff = `${prefix}-speech-${lineIndex}.aiff`;
      const wav = `${prefix}-speech-${lineIndex}.wav`;
      writeFileSync(textFile, text);
      run("say", ["-v", "Tingting", "-r", String(scene.rate || 205), "-f", textFile, "-o", aiff]);
      run("ffmpeg", ["-y", "-v", "error", "-i", aiff, "-ar", "48000", "-ac", "1", wav]);
      const duration = seconds(wav);
      const image = `${prefix}-caption-${lineIndex}.png`;
      await overlay(image, scene, text, Boolean(scene.hero));
      lines.push({ text, image, start: speechTime, end: speechTime + duration });
      subtitles.push({ text, start: cursor + speechTime, end: cursor + speechTime + duration });
      speechTime += duration;
      audioParts.push(wav);
    }
    if (speechTime > scene.duration - 0.15)
      throw new Error(
        `Narration in scene ${index} lasts ${speechTime.toFixed(2)}s, exceeds ${scene.duration}s. Rewrite before rendering.`,
      );
    const audioList = `${prefix}-speech.txt`;
    writeFileSync(audioList, audioParts.map(listLine).join("\n"));
    const speech = `${prefix}-speech.wav`;
    run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      audioList,
      "-af",
      "apad",
      "-t",
      String(scene.duration),
      speech,
    ]);
    const plain = `${prefix}-overlay.png`;
    await overlay(plain, scene, "", Boolean(scene.hero));
    const args = [
      "-y",
      "-v",
      "error",
      "-ss",
      String(scene.start),
      "-i",
      source,
      "-i",
      speech,
      "-loop",
      "1",
      "-i",
      plain,
    ];
    for (const line of lines) args.push("-loop", "1", "-i", line.image);
    let filters = `[0:v]${scene.crop ? `crop=${scene.crop.join(":")},` : ""}scale=1920:1080:flags=lanczos,setsar=1,fps=30[v0];[v0][2:v]overlay=0:0[v1];`;
    lines.forEach((line, i) => {
      filters += `[v${i + 1}][${i + 3}:v]overlay=0:0:enable='between(t,${line.start},${line.end})'[v${i + 2}];`;
    });
    filters += `[v${lines.length + 1}]format=yuv420p[out]`;
    const clip = `${prefix}.mp4`;
    args.push(
      "-filter_complex",
      filters,
      "-map",
      "[out]",
      "-map",
      "1:a",
      "-t",
      String(scene.duration),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "17",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      clip,
    );
    run("ffmpeg", args);
    provenance.push({
      index,
      source,
      sourceSha256: hashFile(source),
      captureManifest: sourceManifest,
      manifestSha256: hashFile(sourceManifest),
      start: scene.start,
      duration: scene.duration,
      outputStart: cursor,
      heading: scene.heading,
      label: scene.label,
    });
    cursor += scene.duration - (index < spec.scenes.length - 1 ? transition : 0);
    console.log(`Rendered scene ${index + 1}/${spec.scenes.length}: ${scene.heading}`);
  }
} finally {
  await browser.close();
}

// Original synthesized music; no downloaded recordings or licensed sample libraries.
const sampleRate = 48000;
const frames = Math.ceil(total * sampleRate);
const wave = Buffer.alloc(44 + frames * 2);
wave.write("RIFF", 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(sampleRate, 24);
wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write("data", 36);
wave.writeUInt32LE(frames * 2, 40);
const chords = [
  [57, 60, 64, 67],
  [53, 57, 60, 64],
  [48, 55, 60, 64],
  [55, 59, 62, 69],
];
const frequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
const beat = 60 / 106;
for (let i = 0; i < frames; i++) {
  const t = i / sampleRate;
  const chord = chords[Math.floor(t / (beat * 8)) % chords.length];
  const hit = t % (beat / 2);
  const note = chord[Math.floor(t / (beat / 2)) % 4] + 12;
  const pluck =
    (Math.sin(2 * Math.PI * frequency(note) * hit) +
      0.2 * Math.sin(4 * Math.PI * frequency(note) * hit)) *
    Math.min(1, hit * 100) *
    Math.exp(-hit * 8);
  const pulse = t % beat;
  const kick =
    Math.sin(2 * Math.PI * (48 * pulse + (20 * (1 - Math.exp(-pulse * 35))) / 35)) *
    Math.exp(-pulse * 17);
  const pad = chord.reduce((sum, midi) => sum + Math.sin(2 * Math.PI * frequency(midi) * t), 0) / 4;
  const fade = Math.max(0, Math.min(1, t / 2, (total - t) / 3));
  wave.writeInt16LE(
    Math.round(32767 * fade * (0.055 * pluck + 0.035 * kick + 0.018 * pad)),
    44 + i * 2,
  );
}
const music = join(work, "original-score.wav");
writeFileSync(music, wave);
const clips = spec.scenes.map((_, index) =>
  join(work, `scene-${String(index).padStart(2, "0")}.mp4`),
);
const joins = clips
  .map(
    (_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`,
  )
  .join("");
let timeline = joins;
let offset = spec.scenes[0].duration;
let visual = "v0";
let voice = "a0";
for (let i = 1; i < clips.length; i++) {
  timeline += `[${visual}][v${i}]xfade=transition=fade:duration=${transition}:offset=${offset - transition}[joinv${i}];[${voice}][a${i}]acrossfade=d=${transition}[joina${i}];`;
  visual = `joinv${i}`;
  voice = `joina${i}`;
  offset += spec.scenes[i].duration - transition;
}
timeline += `[${visual}]format=yuv420p[finalv];[${voice}][${clips.length}:a]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9[a]`;
run("ffmpeg", [
  "-y",
  "-v",
  "error",
  ...clips.flatMap((clip) => ["-i", clip]),
  "-i",
  music,
  "-filter_complex",
  timeline,
  "-map",
  "[finalv]",
  "-map",
  "[a]",
  "-c:v",
  "libx264",
  "-preset",
  "fast",
  "-crf",
  "17",
  "-c:a",
  "aac",
  "-b:a",
  "192k",
  "-movflags",
  "+faststart",
  output,
]);
const stamp = (value) => {
  const ms = Math.round(value * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};
writeFileSync(
  output.replace(/\.mp4$/, ".srt"),
  subtitles
    .map((entry, i) => `${i + 1}\n${stamp(entry.start)} --> ${stamp(entry.end)}\n${entry.text}\n`)
    .join("\n"),
);
run("ffmpeg", [
  "-y",
  "-v",
  "error",
  "-ss",
  String(spec.coverSecond ?? 3),
  "-i",
  output,
  "-frames:v",
  "1",
  output.replace(/\.mp4$/, "-cover.png"),
]);
writeFileSync(
  output.replace(/\.mp4$/, "-provenance.json"),
  JSON.stringify(
    {
      kind: spec.kind,
      commit: spec.commit,
      editSha256: hashFile(specPath),
      outputSha256: hashFile(output),
      duration: seconds(output),
      voice: "macOS Tingting synthetic Mandarin",
      music: "original procedural synthesis",
      scenes: provenance,
    },
    null,
    2,
  ),
);
console.log(`Rendered ${output}`);
