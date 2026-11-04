# 方案擂台

## 这个项目做什么

方案擂台让同一个模型从不同角色提出 3 条策略，再依次质疑、核验、修订和裁决。用户可以更改条件，保留旧版本后重新推演。应用面向学习、生活、工作和创作中的具体决策。

当前版本为 `0.1.0-dev`。截至 2026 年 11 月 4 日，项目仍在 P0 实施和验收阶段。代码、测试数据和真实模型结果需要分别核对；项目尚未据此宣称整个 P0 完成，也没有 P1 完成或获奖承诺。

## 本地启动

需要 Node.js `24.19.0` 和 pnpm `11.19.0`。数据库使用 Node.js 内置的 `node:sqlite`，请使用 Node.js 24。

```sh
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
cp .env.example .env.local
```

用编辑器打开 `.env.local`，填写 `MODEL_API_KEY` 和 `ARENA_SESSION_SECRET`。会话密钥可以在本机生成：

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
pnpm dev
```

在浏览器打开 [本地应用](http://127.0.0.1:3000)。密钥只放在服务端环境文件中。填写后的 `.env.local` 已加入忽略规则；不要提交、截图或粘贴密钥。更改环境配置后重启服务。

默认使用 DeepSeek 官方接口 `https://api.deepseek.com`，模型标识为 `deepseek-flash`。模型别名可能由服务商更新，并不代表不可变模型快照。配置依据和价格估算见 [模型配置](config/model.json)。运行记录还应保留服务商实际返回的模型标识与用量。

缺少模型密钥时，页面会显示配置提示，阻止开始推演。API 创建空擂台后，推进接口会返回 `MODEL_NOT_CONFIGURED`；生产路径不会生成模拟回答。

真实模型可能返回不符合约定格式的内容。已知格式校验失败时，每个步骤最多增加 1 次格式修复请求；原始失败与用量会保留，修复请求也占用预算。超时等未知请求状态不会自动重试。当前尚未验证服务商支持严格 JSON Schema 输出，每场推演不保证成功。

## 完成一轮推演

1. 填写目标、硬性限制、偏好和已有材料。预算、时间与备选方案可以选填。
2. 开始后查看独立提案、交叉质疑、证据核验、策略修订和条件裁决。
3. 点击质疑查看原话、工具证据和修订回应。也可以对具体判断提交自己的质疑。
4. 选择“修改条件再开局”，说明原因并提交新条件。版本选择器可以查看历史。

材料检索只使用你粘贴的文本。计算工具核算表达式，并保留假设。系统没有接入实时互联网搜索；缺少材料的外部事实应保持未知。费用属于根据记录用量计算的估算，以服务商账单为准。

预览服务可以要求访问口令。生产环境需要填写 `ARENA_ACCESS_CODE`；只有明确公开演示时，才设置 `ARENA_PUBLIC_DEMO=true`。

浏览器通过签名的 HttpOnly Cookie 持有访问身份。知道擂台编号不等于拥有访问权限。清除 Cookie、换浏览器或更换会话密钥后，原身份可能无法恢复；当前没有账号找回功能。

本地默认由页面推进。长驻 Node.js 服务可以设置 `ARENA_WORKER_ENABLED=true`，让已经创建的任务在关闭页面后继续。进程停止期间任务不会执行；外部请求状态不确定时会暂停，避免自动重复计费。serverless 环境不保证后台持续运行。

## 本地检查与自动检查

```sh
pnpm typecheck
pnpm lint
pnpm test
node --test scripts/*.test.mjs
node scripts/validate-evals.mjs
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

GitHub Actions 使用冻结锁文件安装依赖，执行类型检查、代码检查、单元测试、构建和 Chromium 端到端测试。成功后打包独立运行文件，生成包含提交 SHA 和文件哈希的清单。失败追踪、截图和日志按提交 SHA 保存，保留 14 天。本机已有 Google Chrome 时，也可以用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`；CI 仍使用固定依赖版本安装的 Chromium。配置见 [CI 工作流](.github/workflows/ci.yml)。

端到端测试分为两种：真实 standalone 服务测试访问口令、缺钥错误和访问隔离；标有 `explicit UI fixture` 的测试使用合成响应检查页面流程。合成响应只存在于测试中，不能作为模型质量证据。CI 不配置真实模型密钥，不调用付费模型。

真实模型验收需要单独执行，并记录输入、条件变化、证据、用量和失败情况。12 个评测定义和 3 组对照规范见 [评测说明](docs/evaluation.md)。仓库尚未据此提供模型胜率或显著性结论。

## 部署与提交

构建使用 Next.js standalone 输出。生产服务应只监听回环地址，由现有反向代理提供 HTTPS。不要把模型密钥、SQLite 数据和已有代理服务的私有文件装进发布包。

[部署说明](docs/deployment.md) 给出版本目录、原子切换、回滚模板和发布清单命令。模板尚不能证明服务器已部署。只有真实 HTTPS 地址、健康检查、真实模型流程和隔离测试全部通过后，才能记录部署验收结果。

[范围与验收](docs/acceptance.md) 列出 P0 检查项、日期、预算和省赛材料要求。最终 `v1.0.0-provincial` 标签应在冻结提交和材料核对后创建。当前工具不会自动创建最终标签。
