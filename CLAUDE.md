# Claude Code 项目入口

2026 年 11 月 5 日追加：后续模型接入改用 OpenAI 官方 API，预算上限 200 美元，主模型选择 GPT-6.1 Sol。接入和新限额尚未实施；DeepSeek 历史数据保留。先读[模型与费用更新](docs/model-budget.md)，其中的最新预算覆盖本文历史预算。核账期间真实预览已停止。

## 接手前阅读

你与 Codex 并行开发《方案擂台》。用户指定你主要负责前端视觉和独立评审，Codex 负责竞技机制、后端、测试、版本与集成。

先阅读以下文件，再领取任务：

1. [AGENTS.md](AGENTS.md)：真实性、密钥、Git 和技能规则。
2. [完整交接](docs/handoff.md)：产品、实际状态、架构、接口与证据。
3. [协作约定](docs/collaboration.md)：修改范围、检查命令、任务同步与集成。

## 确认工作区

用户会把独立工作区 `work/claude-frontend` 交给你。先执行 `pwd`、`git status --short`、`git branch --show-current` 和 `git worktree list`。初始分支应为 `feat/claude-arena-ux`。若打开的是根工作区，先提示用户打开 Claude 工作区，不在根目录开始改代码。

你不是唯一的协作者。不要撤销别人的改动，不在其他工作区切分支或提交。只在你的分支提交，不合并主分支，不修改不可变标签。

## 第一轮任务

领取 `CLAUDE-UX-001`，改进策略轨道、争议定位、证据与修订的可读性。随后完成 `CLAUDE-REVIEW-001`，独立审查迁移与开发隔离工具。不要等待后端新增能力才开始视觉工作。

可直接修改页面、样式、展示组件和新增视觉测试。`use-arena.ts`、共享类型、API、后端、Prompt、模型、数据库、依赖与锁文件归 Codex 管理。需要改动时，记录问题及建议，由 Codex 协调。

保留真实攻击、工具证据、修订与条件重赛。没有模型输出就显示实际空状态，不加入假比赛。测试替身只能用于明确标记的 Playwright 检查，不进入生产路径。

## 启动与检查

```bash
pnpm install --frozen-lockfile
node scripts/dev-local.mjs claude
```

地址为 `http://127.0.0.1:3001`。启动器禁用模型调用，使用工作区自己的数据库。不要读取、复制或请求用户粘贴根目录的 `.env.local`。用独立浏览器资料，避免与 3200 固定预览共享 Cookie。

完整策略画面通过 `tests/e2e` 的明确测试替身检查。先构建，再执行 `E2E_PORT=3101 pnpm test:e2e`；可加 `PLAYWRIGHT_CHANNEL=chrome` 使用本机 Chrome。完整检查顺序见协作约定。调试页面不需要购买服务或真实模型调用。

## 同步与交付

```bash
COMMON_GIT=$(git rev-parse --path-format=absolute --git-common-dir)
ARENA_SHARED="$(dirname "$COMMON_GIT")/work/collaboration"
cat "$ARENA_SHARED/tasks.md"
cat "$ARENA_SHARED/codex-status.md"
```

只更新共享目录的 `claude-status.md` 和你自己的评审文件，记录接手、进度、完整提交 SHA、测试、截图与阻塞项。不要覆盖 `tasks.md` 或 Codex 状态。任务状态不会自动唤醒另一方，不能假定 Codex 已读。

交付可运行代码和真实检查证据。保留失败记录、未知项和未测试内容。当前 v0.2.0 没有完成 P0 语义与真人总验收，不存在已证明优于 GPT、公网部署或正式省赛提交的结论。
