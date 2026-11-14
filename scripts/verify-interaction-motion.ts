// Explicit synthetic UI acceptance only. Every API request is intercepted; no model is called.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { advanceFixture, fixtureSnapshot } from "../tests/e2e/ui.fixture";
import { configureFixtureModels } from "../tests/e2e/intake.fixture";

type Audit = {
  phase: string;
  frames: { time: number; dt: number; phase: string }[];
  longTasks: { start: number; duration: number; phase: string }[];
  marks: { name: string; at: number }[];
  animations: {
    at: number;
    phase: string;
    target: string;
    duration: number;
    delay: number;
    finishedAt?: number;
    cancelledAt?: number;
  }[];
};
type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visibility: string;
  transform: string;
};
type Geometry = {
  t: number;
  dialog: Box | null;
  proxy: Box | null;
  background: Box | null;
  source: Box | null;
};
type TraceEvent = {
  name: string;
  ph: string;
  dur: number;
  ts: number;
  args?: { data?: { functionName?: string; url?: string; lineNumber?: number } };
};

async function main() {
  const label = process.argv[2] ?? "current";
  const origin = process.argv[3] ?? "http://127.0.0.1:3350";
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))
    throw new Error("Only an isolated localhost server is allowed.");
  const output = resolve("work/motion-acceptance", label);
  const deliver = resolve("outputs/动效验收");
  await mkdir(output, { recursive: true });
  await mkdir(deliver, { recursive: true });
  const snapshot = configureFixtureModels(fixtureSnapshot());
  for (let step = 0; step < 5; step++) advanceFixture(snapshot);
  const verdict = snapshot.versions[0].verdict!;
  verdict.rationale =
    "明确的界面测试材料：先用最小样片核对制作速度，再根据时间与证据调整范围。".repeat(6);
  verdict.conditions = [
    "总投入不超过可用时间。".repeat(16),
    "先完成大纲，再核对素材。".repeat(14),
    "保留修改样片的时间。".repeat(12),
  ];
  verdict.uncertainties = ["真实制作速度待验证。".repeat(12), "字幕校对时间尚未确定。".repeat(10)];
  verdict.nextActions = ["完成测试大纲。", "制作一分钟样片。", "核对总投入并决定是否继续。"];
  const requests: { method: string; path: string }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const notes: unknown[] = [];
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference",
    recordVideo: { dir: resolve(output, "video"), size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    requests.push({ method: request.method(), path: url.pathname });
    if (url.pathname === "/api/health")
      return route.fulfill({
        json: {
          status: "ok",
          version: "explicit-ui-fixture",
          commit: "fixture-only",
          model: snapshot.model,
          requiresAccessCode: false,
          accessGranted: true,
        },
      });
    if (url.pathname.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": explicitly synthetic UI fixture; no model calls\n\n",
      });
    if (url.pathname === `/api/arenas/${snapshot.id}` && request.method() === "GET")
      return route.fulfill({ json: snapshot });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected request blocked by explicit motion acceptance fixture." },
    });
  });
  await page.addInitScript(
    `window.__name = (fn) => fn; localStorage.setItem('strategy-arena:last-id', 'fixture-arena'); sessionStorage.setItem('arena-intro','1');`,
  );
  await page.goto(origin);
  await expect(page.locator(".c-root")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.evaluate((text) => {
    const badge = document.createElement("div");
    badge.textContent = text;
    badge.style.cssText =
      "position:fixed;top:0;left:0;z-index:2147483647;background:#e9ff68;color:#0b0d10;padding:4px 9px;font:11px monospace;pointer-events:none";
    document.body.append(badge);
  }, `EXPLICIT UI FIXTURE · ${label} · NO MODEL CALLS · 1440×900`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Tracing.start", {
    categories:
      "toplevel,devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline.stack",
    transferMode: "ReturnAsStream",
  });
  await page.evaluate(`(() => {
  const audit = window.motionAudit = { frames: [], longTasks: [], marks: [], animations: [], phase: 'ready', active: true };
  const animate = Element.prototype.animate;
  Element.prototype.animate = function(frames, options) {
    const animation = animate.call(this, frames, options);
    const item = { at: performance.now(), phase: audit.phase, target: this.className?.baseVal ?? this.className ?? this.tagName, duration: typeof options === 'number' ? options : options?.duration, delay: options?.delay ?? 0, from: Array.isArray(frames) ? frames[0] : null, to: Array.isArray(frames) ? frames.at(-1) : null };
    audit.animations.push(item);
    animation.addEventListener('finish', () => item.finishedAt = performance.now(), {once:true});
    animation.addEventListener('cancel', () => item.cancelledAt = performance.now(), {once:true});
    return animation;
  };
  audit.observer = new PerformanceObserver(list => audit.longTasks.push(...list.getEntries().map(e => ({ start:e.startTime, duration:e.duration, phase:audit.phase }))));
  audit.observer.observe({type:'longtask', buffered:false});
  let previous = performance.now();
  function frame(time) { if(!audit.active) return; audit.frames.push({time, dt:time-previous, phase:audit.phase}); previous=time; audit.frame = requestAnimationFrame(frame); }
  audit.frame = requestAnimationFrame(frame);
})()`);
  async function phase(name: string) {
    await page.evaluate((name) => {
      const audit = (window as unknown as { motionAudit: Audit }).motionAudit;
      audit.phase = name;
      audit.marks.push({ name, at: performance.now() });
      performance.mark(name);
    }, name);
  }
  async function openCard(index = 0) {
    await page.getByRole("button", { name: `查看第 ${index + 1} 步`, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".c-pull")).toBeVisible();
  }
  async function closeCard(ms = 740) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(ms);
    await expect(page.locator(".c-pull")).toHaveCount(0);
  }
  async function go(step: number, wait = 760) {
    await page.getByRole("button", { name: `第 ${step} 步`, exact: true }).click({ force: true });
    await page.waitForTimeout(wait);
  }

  await phase("open-flip-current-card-return");
  await openCard();
  await page.waitForTimeout(160);
  await page.locator(".c-pull").getByRole("button", { name: "下一步", exact: true }).click();
  await page.waitForTimeout(120);
  await page.locator(".c-pull").getByRole("button", { name: "下一步", exact: true }).click();
  await page.waitForTimeout(740);
  await page.screenshot({ path: resolve(output, "card-after-flip.png") });
  await closeCard();
  await phase("interrupted-open-close");
  await openCard();
  await page.waitForTimeout(75);
  await closeCard();
  await phase("card-to-evidence-focus-handoff");
  await openCard();
  await page.waitForTimeout(680);
  for (let i = 0; i < 3; i++) {
    await page.locator(".c-pull").getByRole("button", { name: "下一步", exact: true }).click();
    await page.waitForTimeout(160);
  }
  await page.locator(".c-pull").getByRole("button", { name: "看证据", exact: true }).click();
  await expect(page.locator(".evidence-drawer")).toBeVisible();
  await page.waitForTimeout(760);
  notes.push({
    evidenceFocusInside: await page
      .locator(".evidence-drawer")
      .evaluate((node) => node.contains(document.activeElement)),
  });
  await page.screenshot({ path: resolve(output, "evidence.png") });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await phase("manual-proposal-attack-verify-revision");
  for (const step of [1, 4, 5, 7, 9]) await go(step, 860);
  await phase("rapid-manual-seeks");
  for (const step of [1, 4, 7, 2, 5, 8, 3, 9]) await go(step, 75);
  await page.waitForTimeout(1000);
  await phase("paused-result-expand-collapse");
  await go(8);
  await page.getByRole("button", { name: "逐步看", exact: true }).click();
  await page.getByRole("button", { name: /^(继续放映|从头放映)$/, exact: true }).click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "暂停放映", exact: true }).click();
  await page.waitForTimeout(5000);
  notes.push({ pausedRoot: await page.locator(".c-root").getAttribute("class") });
  await page.getByRole("button", { name: "看完整结论", exact: true }).click();
  await page.waitForTimeout(760);
  notes.push({
    expandedHeight: await page
      .locator(".c-result")
      .evaluate((node) => node.getBoundingClientRect().height),
    resultRegionHeight: (await page.locator(".c-result-region").count())
      ? await page
          .locator(".c-result-region")
          .evaluate((node) => node.getBoundingClientRect().height)
      : null,
  });
  await page.screenshot({ path: resolve(output, "paused-expanded.png") });
  await page.getByRole("button", { name: "收起结论", exact: true }).click();
  await page.waitForTimeout(700);
  notes.push({
    collapsedHeight: await page
      .locator(".c-result")
      .evaluate((node) => node.getBoundingClientRect().height),
  });
  await phase("open-close-model-overlay");
  await page.locator(".model-pill").click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const audit = (await page.evaluate(
    `(() => { const a = window.motionAudit; a.active=false; cancelAnimationFrame(a.frame); a.observer.disconnect(); return {frames:a.frames,longTasks:a.longTasks,marks:a.marks,animations:a.animations}; })()`,
  )) as Audit;
  const finished = new Promise<{ stream: string }>((resolve, reject) =>
    cdp.once("Tracing.tracingComplete", (data) =>
      data.stream
        ? resolve({ stream: data.stream })
        : reject(new Error("Chrome trace returned no stream")),
    ),
  );
  await cdp.send("Tracing.end");
  const { stream } = await finished;
  let trace = "";
  for (;;) {
    const part = await cdp.send("IO.read", { handle: stream });
    trace += part.data;
    if (part.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  await writeFile(resolve(output, "chrome-trace.json"), trace);
  await context.tracing.stop({ path: resolve(output, "playwright-trace.zip") });
  const events = JSON.parse(trace).traceEvents as TraceEvent[];
  const expensiveEvents = events
    .filter((event) => event.ph === "X" && event.dur >= 50000)
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 30)
    .map((event) => ({
      name: event.name,
      ms: event.dur / 1000,
      at: event.ts,
      function: event.args?.data?.functionName,
      url: event.args?.data?.url,
      line: event.args?.data?.lineNumber,
    }));

  // Geometry is sampled separately, outside the timed performance window, to avoid charging layout reads to the app.
  await go(9, 900);
  await page.evaluate(
    `window.motionGeometry=[]; window.geometryRunning=true; window.geometryTarget=0;`,
  );
  await page.evaluate(`(() => { const start=performance.now(); function sample(time) {
 const data=(selector) => { const node=document.querySelector(selector); if(!node) return null; const b=node.getBoundingClientRect(); const s=getComputedStyle(node); return {x:b.x,y:b.y,width:b.width,height:b.height,opacity:Number(s.opacity),visibility:s.visibility,transform:s.transform}; };
 window.motionGeometry.push({t:time-start,dialog:data('.c-pull'),proxy:data('.c-return-proxy'),background:data('.c-pull-bg'),source:data('[data-step-source="'+window.geometryTarget+'"]')});
 if(window.geometryRunning) requestAnimationFrame(sample);
 } requestAnimationFrame(sample); })()`);
  await openCard();
  await page.waitForTimeout(700);
  await page.locator(".c-pull").getByRole("button", { name: "下一步", exact: true }).click();
  await page.evaluate(`window.geometryTarget=1;`);
  await page.waitForTimeout(350);
  await closeCard(800);
  await page.evaluate(`window.geometryRunning=false;`);
  const geometry = (await page.evaluate(`window.motionGeometry`)) as Geometry[];
  const paired = geometry.filter((sample: Geometry) => sample.dialog && sample.proxy);
  const geometryDelta = paired.length
    ? Math.max(
        ...paired.map((sample: Geometry) =>
          Math.max(
            ...(["x", "y", "width", "height"] as const).map((key) =>
              Math.abs(sample.dialog![key] - sample.proxy![key]),
            ),
          ),
        ),
      )
    : null;
  const lastVisual = geometry
    .filter(
      (sample) =>
        sample.source &&
        ((sample.proxy && sample.proxy.opacity > 0.05) ||
          (sample.dialog && sample.dialog.opacity > 0.05 && sample.background)),
    )
    .at(-1);
  const landingBox =
    lastVisual?.proxy && lastVisual.proxy.opacity > 0.05
      ? lastVisual.proxy
      : lastVisual?.background;
  const landingDelta =
    landingBox && lastVisual?.source
      ? Math.max(
          ...(["x", "y", "width", "height"] as const).map((key) =>
            Math.abs(landingBox[key] - lastVisual.source![key]),
          ),
        )
      : null;
  const cleanupCount = await page.locator(".c-pull,.c-return-proxy,.pulled,.past-gap").count();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openCard();
  await page.waitForTimeout(80);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(80);
  notes.push({
    dynamicReducedCardRunning: await page
      .locator(".c-pull")
      .evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length,
      ),
  });
  await closeCard(150);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openCard();
  await closeCard(100);
  const reducedCleanup = await page.locator(".c-pull,.c-return-proxy,.pulled,.past-gap").count();
  await page.screenshot({ path: resolve(output, "completed.png") });
  const byPhase = Object.fromEntries(
    [...new Set(audit.frames.map((frame: Audit["frames"][number]) => frame.phase))].map((phase) => {
      const frames = audit.frames
        .filter((frame: Audit["frames"][number]) => frame.phase === phase)
        .map((frame: Audit["frames"][number]) => frame.dt)
        .sort((a: number, b: number) => a - b);
      return [
        phase,
        {
          count: frames.length,
          p95: frames[Math.floor(frames.length * 0.95)] ?? 0,
          max: Math.max(0, ...frames),
          over50: frames.filter((dt: number) => dt > 50).length,
        },
      ];
    }),
  );
  const result = {
    label,
    origin,
    fixture:
      "Explicit synthetic UI fixture. All API requests intercepted; no real model calls or quality evaluation.",
    viewport: { width: 1440, height: 900 },
    perfIncludesTraceAndVideoOverhead: true,
    errors,
    unexpectedRequests: unexpected,
    requests,
    notes,
    byPhase,
    longTasks: audit.longTasks,
    expensiveTraceEvents: expensiveEvents,
    geometry: {
      samples: geometry.length,
      pairedFrames: paired.length,
      maxCopyDeltaPx: geometryDelta,
      lastVisibleLandingDeltaPx: landingDelta,
      cleanupCount,
      reducedCleanup,
    },
    animations: audit.animations,
    marks: audit.marks,
  };
  await writeFile(resolve(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  await writeFile(resolve(output, "report.json"), JSON.stringify(result, null, 2));
  const video = page.video();
  await context.close();
  const videoPath = await video?.path();
  if (videoPath) {
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      resolve(deliver, `${label}-正常速度.mp4`),
    ]);
    execFileSync("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      videoPath,
      "-vf",
      "setpts=4*PTS",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      resolve(deliver, `${label}-四分之一慢放.mp4`),
    ]);
  }
  await copyFile(resolve(output, "report.json"), resolve(deliver, `${label}-报告.json`));
  await browser.close();
  console.log(
    JSON.stringify(
      {
        label,
        errors,
        unexpectedRequests: unexpected,
        byPhase,
        longTasks: audit.longTasks,
        geometry: result.geometry,
        output,
      },
      null,
      2,
    ),
  );
  if (
    errors.length ||
    unexpected.length ||
    cleanupCount ||
    reducedCleanup ||
    (geometryDelta !== null && geometryDelta > 2)
  )
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
