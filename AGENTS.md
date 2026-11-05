<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 项目协作约定

## 真实性与验收

保留真实 Git 历史，不补造开发记录、模型输出、评测结果、用户反馈或部署证据。区分单元测试、页面测试替身、真实模型调用和生产验收。测试替身只能出现在测试中，并明确标注；生产路径缺少配置时必须报错。

未通过的检查、未知结果和未部署状态要如实记录。不承诺获奖，不把同一 DeepSeek 模型的角色对照表述成对 GPT 的胜出。

## 密钥与数据

不要读取、打印或提交实际 `.env.local` 中的密钥。公开配置写入 `.env.example`。发布包排除环境文件、数据库、私有输入和测试产物。现有代理项目的私有文件不属于本项目。

## 分支与最终提交

围绕具体任务修改，并保留其他协作者的变更。Codex 临时派出的子代理不自行切分支或提交。用户手动打开的 Claude Code 是平级协作者，可以在独立工作区的任务分支提交；Codex 统一负责评审、PR 集成和发布。双方不得在对方工作区切分支、重置或覆盖未提交内容。

省赛标签 `v1.0.0-provincial` 对应最终材料的同一提交 SHA，创建后保持不可变。视频、PDF、仓库和发布清单需要核对 SHA。省赛之后在 `develop/national` 继续开发，不移动最终标签。

## 交接与协作入口

接手前阅读 [完整交接](docs/handoff.md) 和 [协作约定](docs/collaboration.md)。Claude 同时阅读 [CLAUDE.md](CLAUDE.md)。Claude 主要负责前端视觉和独立评审；Codex 负责后端、可靠性、测试和集成。共享类型、前端数据同步钩子、依赖、锁文件和 CI 由 Codex 协调修改。

共享任务和各自状态位于主工作区的 `work/collaboration`，不包含密钥。双方只更新自己的状态文件。使用独立端口、数据库、依赖和浏览器资料；视觉开发默认禁用模型。同步记录不代表对方已接收或开始执行。

## 技能调用

只有用户在当前消息中以 `/skill-name` 明确调用时，才使用对应技能。不得因任务类型或无斜杠的技能名称自动读取、推荐或应用技能。

唯一例外是 `zh-tech-writing`：创建、编辑、翻译或润色中文技术文档时，自动读取 `/Users/songyu00yo/.codex/skills/zh-tech-writing/SKILL.md` 并遵守其规则。普通中文对话、只读总结和英文文档不触发例外。用户明确禁用时优先遵守用户要求。
