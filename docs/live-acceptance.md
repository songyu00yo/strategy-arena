# 真实验收与宣传片工具

## 运行边界

这些工具用于开发验收。任务输入为明确标注的合成案例，结果必须来自实际模型调用。结构检查、代理语义审查、真人评测和生产验收分别记录。

`evals/live-acceptance.json` 固定五类任务的初始与变化条件，以及材料不足、条件冲突两个边界任务。运行器在调用前保存输入哈希。GPT 未配置时记录阻塞，不切换供应商。显式选择 DeepSeek 的补充运行不能算作 GPT 或原自动路线验收。

## 费用管理

所有工作区使用同一个绝对路径账本。以下命令不读取环境文件，也不调用模型：

```sh
pnpm exec tsx scripts/billing-admin.ts status --database /绝对路径/billing.sqlite
pnpm exec tsx scripts/billing-admin.ts --help
```

阶段调整前停止收费进程。使用 `set-limits` 明确提供旧限额、修订号、新累计限额、阶段限额及理由。工具在同一事务中核对旧状态、保留消费记录并追加审计记录。单个新增阶段最多 10 美元、300 次请求、500 万 Token。2026 年 11 月 6 日，用户将本轮累计请求上限从 300 次提高到 400 次；累计费用仍限 10 美元，Token 仍限 500 万。项目的累计开发上限为 120 美元，另保留最终评审的 80 美元。

阶段限额按调整后的请求计算；需要把预检也计入本轮时，将累计限额设为本轮开始前的已用量加上本轮授权额度。累计限额与阶段限额同时生效。已结算金额、未结预留和失败请求均保留。工具不能证明服务商账单，也不负责核销未知请求。

运行进程的 `ARENA_BILLING_*` 限额必须与审计后的累计限额一致。修改环境变量不能扩大账本额度。未知请求继续保留预留，不得删库、换路径或手改记录来释放额度。

新批次默认拒绝任何未结请求。独立新任务经授权后，可用 `--acknowledge-held` 明确列出启动前已知的全部 held 请求，并用 `--acknowledgement-reason` 保存原因。这只允许新任务运行，不核销、不重试旧请求。reserved 请求不能豁免；批次中出现新的 held 或 reserved 请求时立即停止。

## 冻结案例与恢复

先执行不收费的预览：

```sh
pnpm exec tsx scripts/live-acceptance.ts --exclude creation
```

实际运行前，由本机进程加载私有配置，并明确设置独立的 `ARENA_DATABASE_PATH` 和共享的 `ARENA_BILLING_DATABASE_PATH`。密钥不得打印、写进命令参数或复制到验收文件。

本机需要代理时，使用 Node.js 24 的 `--use-env-proxy`，让模型请求使用已有的 `HTTPS_PROXY` 或 `HTTP_PROXY`。预览启动器仅传递这些代理变量，并将回环地址加入 `NO_PROXY`。启动器不继承 `NODE_OPTIONS` 或外层进程的模型密钥，应用子进程从指定私有配置文件加载密钥。

OpenAI 使用 `/v1/responses`，保留 `low` 推理档位、严格函数工具和 `store: false`。DeepSeek 继续使用 Chat Completions。OpenAI 配置版本为 `openai-1.1.1`；历史版本仍显示原配置，不在新版适配器下续跑旧步骤。

真实 GPT 质疑阶段曾返回 `incomplete / max_output_tokens`，输出为空，用量为零。将输出额度从 2200 提高到 6000 未解决问题。后续对照调用仅删除有限枚举中已满足的重复正则约束，保留全部允许值，调用成功。OpenAI 的严格 Schema 因此做等价简化；DeepSeek、服务端字段校验和证据引用检查保持不变。这是本次观察到的兼容现象，不代表所有截断错误都由此引起。

```sh
pnpm exec tsx scripts/live-acceptance.ts --run --exclude creation --out artifacts/planned.json
pnpm exec tsx scripts/live-acceptance.ts --run --cases career,team --model-mode deepseek --out artifacts/supplement.json
pnpm exec tsx scripts/live-acceptance.ts --run --resume artifacts/planned.json
```

创作主案例由录制工具在实际界面中完成，避免再次运行同一任务。断点恢复保留案例、模型选择、数据库身份和已有版本。终止、失败或费用未知时，不重新创建同一请求。运行器保留原始结构化输出、服务端处理结果和用量；没有保存原始 HTTP 响应包，不能宣称具有该项证据。

输出位于忽略提交的 `artifacts/`，权限为 `0600`。运行器不会填写语义通过结论。审查人须逐项检查限制、依据、未知项、修订和下一步，再记录具体证据。

## 真实录制与剪辑

```sh
node scripts/capture-live-promo.mjs --help
```

录制要求实际服务报告干净构建和完整提交 SHA。工具拒绝预设演示服务。`live` 模式经由界面创建主案例和一次条件重赛。`--model-mode auto|deepseek|gpt` 控制两次提交的模式，默认为 DeepSeek；本轮主片使用 `auto`，启动前检查两家模型均已配置。实际供应商由现有选择规则决定，并随版本保存。每次写操作先保存意图，再发送请求。已有录制目录只允许 `read-only` 接续，不能自动重复收费。

回看模式在页面加载前阻止所有写请求。原始录像保留等待与正常速度动效。片段清单记录时间、任务和版本；浏览器身份放在独立私有目录，不进入交付包。其他领域的结果镜头必须来自已完成的真实记录，试填表单不能冒充结果。

```sh
node scripts/render-live-promo.mjs /绝对路径/edit.json
```

剪辑描述使用 `kind: real-product-promo`、完整提交 SHA 和 `scenes`。每段包含真实原片、录制清单、起点、时长、标题、来源说明和旁白句子。工具制作 90～120 秒的 1080p MP4，导出字幕、封面及来源哈希。旁白采用本机合成语音，音乐由脚本原创合成。剪去等待和事后回看须在画面中标注。

交付前完整观看成片，并核对结果、字幕、音画同步、文字可读性和源码身份。录像只能说明画面中的实际行为，不能替代跨任务验收、真人效果或公网验收。
