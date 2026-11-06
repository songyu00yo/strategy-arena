// pnpm demo: starts the arena with scripted content for the home-page samples. It calls no model.
// Use --rebuild to force a fresh build, --port=<n> to choose the page's port.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createDemoServer } from "./demo/server.mjs";
import { demoPageEnvironment, demoReleaseIsCurrent } from "./demo/release.mjs";

const args = process.argv.slice(2);
const port = Number(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 3002);
const pagesPort = port + 1;
const root = resolve("work/demo-release");
const serverDir = join(root, "server");
const fresh = !args.includes("--rebuild") && demoReleaseIsCurrent(process.cwd(), serverDir);

if (!fresh) {
  console.log("正在构建正式版，大约需要一分钟……");
  execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
  mkdirSync(serverDir, { recursive: true });
  const archive = join(root, "build.tar.gz");
  execFileSync(process.execPath, ["scripts/package-release.mjs", archive], { stdio: "inherit" });
  execFileSync("tar", ["-xzf", archive, "-C", serverDir]);
  if (!demoReleaseIsCurrent(process.cwd(), serverDir))
    throw new Error("演示包与当前源码不一致，请重新构建。");
}

// The pages server gets no credentials at all. The demo server also never forwards /api to it.
const pages = spawn(process.execPath, ["server.js"], {
  cwd: serverDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: demoPageEnvironment(root, pagesPort),
});
const stop = () => {
  pages.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
pages.on("exit", (code) => {
  console.error(`页面服务已退出（${code}）。`);
  process.exit(1);
});

const server = createDemoServer({ target: pagesPort });
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，可以用 --port=<端口> 换一个。` : error,
  );
  stop();
});
server.listen(port, "127.0.0.1", () => {
  console.log(`\n演示已启动：http://127.0.0.1:${port}`);
  console.log("全部内容都是预设的，不调用模型。按 Ctrl+C 停止。\n");
});
