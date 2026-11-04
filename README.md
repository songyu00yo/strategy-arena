# 方案擂台

面向大众的 AI 策略竞技平台：独立提案、结构化攻击、材料核验、实质修订和条件重赛。

当前处于 P0 实施阶段。尚未完成的能力不代表已经可用。

## 本地运行

需要 Node.js 24 和 pnpm 11。

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

在 `.env.local` 配置模型 API 密钥和会话密钥。不要把填写后的环境文件提交到仓库。未配置模型时必须明确报错，不能回退到模拟回答。

## 检查

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

里程碑、架构、部署和验证说明将在实现时同步维护。
