# 部署与发布

## 部署边界

本仓库提供 Linux standalone 服务模板，没有据此声称已部署到生产环境。生产验收需要真实 HTTPS 地址、与提交一致的健康信息、真实模型流程、访问隔离记录和实际费用。

Node.js 版本固定为 `24.19.0`，pnpm 版本固定为 `11.19.0`。SQLite 需要可持久写入的目录，当前模板面向单实例。不要直接启动多个共享同一数据库的应用实例；多实例部署需要另行验证事务与预算控制。

默认首页是五角色分析工作台。页面根据服务端状态推进下一步，关闭页面后不会继续自动发起后续步骤。已经发出的请求仍可能完成；重新打开页面后，按保存状态恢复。未知外部请求会暂停，不能按普通失败直接重试。

`ARENA_WORKER_ENABLED=true` 只启动旧版三路线讨论的后台 worker，不推进新工作台。旧版入口是 `/?legacy=1` 和已有 `?arena` 链接。旧版后台执行需要长驻 Node.js 进程，serverless 平台不保证这类执行。

默认把 Node.js 服务绑定到 `127.0.0.1:3100`。现有反向代理负责 HTTPS 和转发。不要覆盖其他项目的代理配置、环境文件或数据，也不要把这些私有文件复制进本仓库。

## 本地检查当前工作台

在当前源码的根目录执行：

```sh
pnpm dev
```

默认地址是 `http://127.0.0.1:3000`。Next.js 会加载已有的本地环境配置，保留现有文件即可。macOS 也可以双击 `scripts/local/启动当前工作台.command`。这个入口检查 Node.js 24 和 pnpm，然后在所在仓库运行 `pnpm dev --port 3000`；端口占用时会报错，不会停止已有进程。

只检查界面、不接入模型时，使用 `node scripts/dev-local.mjs codex`。该入口禁用模型密钥和后台 worker。页面会如实显示模型未配置。`pnpm demo` 展示的是[旧版预设流程](demo.md)，不覆盖新工作台。

检查 standalone 包时，先按下文生成与当前提交一致的构建包。在同一版本的源码目录执行启动器，路径替换为本机实际位置：

```sh
node scripts/start-live-preview.mjs \
  --release /absolute/path/to/current-release \
  --env-file /absolute/path/to/existing-model.env \
  --database /absolute/path/to/planning-preview.sqlite \
  --billing-database /absolute/path/to/existing-billing.sqlite \
  --check
```

`--billing-database` 必须指向已有的共享账本。`--check` 核对构建身份、平台、全部迁移文件、账本限额和端口，不启动页面、不调用模型，也不创建应用数据或会话文件。它只检查模型配置文件是否存在，不读取配置正文。

检查通过后，去掉 `--check` 启动 `http://127.0.0.1:3340`。启动器沿用账本的当前审计限额，并限制在自身支持的预算范围内；它不会升额。真实分析需要模型配置可用，付费请求仍受中央账本约束。此入口只绑定本机地址，并关闭旧版 worker；按 Ctrl+C 停止。

## 服务目录和环境

建议使用以下目录：

```text
/srv/strategy-arena/releases/<commit-sha>/
/srv/strategy-arena/current -> releases/<commit-sha>/
/srv/strategy-arena/data/
/etc/strategy-arena/arena.env
```

由管理员创建专用低权限用户 `strategy-arena`，并让该用户可写数据目录。环境文件放在发布目录外，权限设为仅管理员和服务账号可读。不要把填写后的环境文件提交到仓库。

参考 `.env.example` 配置所选模型、随机会话密钥和预览访问口令。已有环境文件时按需补充，不要用模板覆盖。模型默认值以当前源码和运行时配置为准。配置存在只说明已填写，接口可用性仍需真实请求验证。

设置 `ARENA_DATABASE_PATH=/srv/strategy-arena/data/arena.sqlite`。所有付费入口使用同一个 `ARENA_BILLING_DATABASE_PATH` 绝对路径。把 `ARENA_PUBLIC_ORIGIN` 设为实际 HTTPS 源站地址，把 `RELEASE_COMMIT` 设为完整提交 SHA。反向代理必须保留正确的 Host，源站校验不信任任意转发头。预览口令限制进入付费分析，每个浏览器的所有者隔离另行校验。

生产环境默认要求 `ARENA_ACCESS_CODE`。只有明确决定开放公开演示时，才设置 `ARENA_PUBLIC_DEMO=true`；公开演示仍需费用和请求限制。不要把测试口令或测试会话密钥用在生产服务中。

工作台会保存本轮有效模型配置及其指纹。部署后如果所选模型的有效参数变化，继续分析会返回配置变化错误，需要新建规划；已有内容仍可查看。密钥轮换不改变模型配置指纹。

配置服务前先检查 [systemd 模板](strategy-arena.service.example) 中的 Node.js 路径、目录、用户名和端口。SQLite 数据放在独立持久目录。升级前先停止写入或使用 SQLite 一致性备份；运行中的数据库不能只复制主文件而忽略 WAL。

## 账本与预算

每次真实验收前，读取共享账本的当前状态。下面的命令只读已有账本，不初始化数据库，不加载模型配置，也不调用模型：

```sh
pnpm exec tsx scripts/billing-admin.ts status \
  --database /absolute/path/to/existing-billing.sqlite
```

以输出中的审计修订、累计限额、当前阶段限额、已用请求、Token 和预留为准。环境中的 `ARENA_BILLING_*` 限额必须与审计值一致。历史文档中的金额和次数不能替代当前余额，单场限额也不会扩大共享额度。

所有工作区、网页和离线付费命令共用该账本。更换数据库路径、重启服务或重新部署都不会增加授权预算。跨主机迁移前先停止原付费入口，再备份并迁移原账本；当前实现不跨主机同步费用。

## 未知请求的人工核账

外部请求超时后，服务可能无法确认是否扣费。系统会保留费用预留，暂停相关工作，不自动重试或释放。当前工作台和使用共享账本的请求，需要同时核对应用记录、中央账本及服务商回执。现有 `reconcile-uncertain.ts` 不支持这些请求，不要用旧命令解除它们的预留。

以下流程只适用于未使用共享账本的历史三路线人民币记录。旧工具会拒绝带新模型选择或中央账本信息的步骤。尚未提供新工作台的双账本核销命令；未核清的请求继续保留未知状态。

只有管理员在服务商后台核对请求和实际人民币费用后，才能运行离线核账工具。工具只能记录管理员的确认，无法证明凭证真实。没有查到请求不等于确认未扣费；仍有疑问时，保留未知状态。

先停止 `strategy-arena` 服务，确认没有该服务的其他实例。再备份 SQLite 数据库及其 WAL。停止服务可避免迟到的响应与人工核账同时写账本。

```sh
sudo systemctl stop strategy-arena
```

在已核对提交的源码目录执行下面的命令。源码目录需要安装依赖，包含 `scripts`、`src` 和 `migrations`。standalone 发布包通常不含这些运维脚本。不要把环境文件、数据库或凭证复制进源码仓库。

先设置实际数据库路径，再查看未知步骤。下面的查询只显示步骤 ID、版本 ID 和预留金额。

```sh
export ARENA_DATABASE_PATH=/srv/strategy-arena/data/arena.sqlite
node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.env.ARENA_DATABASE_PATH, { readOnly: true });
console.table(database.prepare(
  'SELECT id, version_id, reservation FROM steps WHERE status = ?'
).all('uncertain'));
database.close();
JS
```

把服务商回执保存到仓库外的本地普通文件。工具接受 `.json`、`.pdf`、`.png`、`.jpg` 和 `.txt`，文件大小不超过 20 MB。凭证应先脱敏，不包含密钥。环境文件、密钥路径和符号链接会遭拒。工具只保存文件名和 SHA-256，不保存或打印凭证正文，也不把凭证加入 Git。

把示例中的步骤 ID 和凭证路径替换成已核对的值。确认没有扣费时，使用 `no-charge`，金额必须是 `0`。

```sh
pnpm exec tsx scripts/reconcile-uncertain.ts \
  --step '替换为步骤UUID' --resolution no-charge --confirmed-cny 0 \
  --proof /srv/strategy-arena/operator-receipts/receipt.json \
  --acknowledge-provider-confirmation
```

确认实际扣费时，使用 `settled`，金额填写服务商确认的人民币正数。下例的 `0.0345` 仅为格式示例，不是建议金额。实际费用即使超过原预留，也必须如实记录。

```sh
pnpm exec tsx scripts/reconcile-uncertain.ts \
  --step '替换为步骤UUID' --resolution settled --confirmed-cny 0.0345 \
  --proof /srv/strategy-arena/operator-receipts/receipt.json \
  --acknowledge-provider-confirmation
```

成功后，工具释放该步骤的预留和并发占用，并记入确认费用。原步骤变为失败，原结果仍不可用；工具不会重放请求、继续原版本或创建新版本。已暂停或已替换的版本保留原状态。重复核账会遭拒，确认费用只入账一次。实际费用超出预算时，后续请求仍受正常预算限制。

保留脱敏回执，核对终端显示的步骤 ID 和金额，再启动服务。原讨论需要继续时，由使用者另建版本，并遵守每日次数和剩余预算。

```sh
sudo systemctl start strategy-arena
```

## 打包和校验

在冻结提交上完成检查，再生成构建包：

必须通过 `pnpm build` 构建。构建包装脚本在开始前清除旧身份标记，成功后才记录提交、Git 可见源码指纹与编译产物哈希。构建期间源码变化、构建失败、标记缺失，或打包前提交／源码／编译文件发生变化，都不能沿用旧构建。应先提交，再重新构建和检查。稳定的未提交开发构建可以运行测试，但不能生成干净的候选发布清单。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
node --test scripts/*.test.mjs
pnpm build
pnpm test:e2e
node scripts/package-release.mjs artifacts/strategy-arena-build.tar.gz
```

打包器复制 standalone、静态资源、可选的 `public` 和全部 SQL 迁移。当前业务迁移为 `001_initial.sql` 至 `006_planning.sql`，账本迁移为 `billing/001_initial.sql` 至 `billing/004_usage_policy.sql`。新工作台依赖 `006_planning.sql`，发布包和本地启动检查必须包含它。

根目录允许列表会排除项目私有目录、环境文件、数据库和密钥文件。打包后还会扫描密钥形态，并拒绝逃逸到包外的符号链接。扫描不能代替密钥管理和人工核对。

包内 `release-info.json` 记录提交、工作区状态、应用版本、Node.js 和 pnpm 版本，以及构建平台和处理器架构。部署校验器要求构建包、清单和目标服务器的 `platform`、`arch` 一致。macOS 构建包需在 Linux 重新构建并测试，才能部署到 Linux。开发包有未提交变更时，提交 SHA 不能代表完整源码，部署校验器会拒绝这类清单。构建过程可重复执行；当前工具没有承诺不同机器产物逐字节相同。

CI 成功后会生成 `checks.json` 和 CI 清单。人工准备候选发布时，把实际检查记录保存到 `artifacts/checks.json`，再执行：

```sh
node scripts/release-manifest.mjs --kind candidate --checks artifacts/checks.json --artifact artifacts/strategy-arena-build.tar.gz --output artifacts/release-manifest.json
```

`checks.json` 必须包含 `typecheck`、`lint`、`unit`、`build` 和 `e2e`，且值均为 `passed`。同时保留原始日志或 CI 地址。脚本能校验字段和哈希，无法证明人工填写的 `passed` 真实；不要手工补写未通过的结果。

候选与已部署清单要求 Git 工作区干净。清单包含完整 SHA、锁文件与模型默认配置哈希、构建包哈希和检查证据。运行时环境可能覆盖模型默认值，正式验收还要核对有效配置和响应中的模型标识。模型别名会由服务商更新，清单不能将别名变成不可变模型版本。CI 清单不等于部署成功。

## 切换与回滚

[部署模板](../scripts/deploy-standalone.sh.example) 是需要管理员检查的脚本。它校验批准的提交和包哈希，把构建包解压到新的版本目录，再原子替换 `current`。重启和回环健康检查失败时，脚本在有旧版本的情况下恢复旧链接。

```sh
bash scripts/deploy-standalone.sh.example artifacts/strategy-arena-build.tar.gz artifacts/release-manifest.json <完整提交SHA> /srv/strategy-arena
```

模板在目标 Linux 主机上运行，要求已经配置好 systemd 服务与专用目录。脚本不设置域名、证书和反向代理，也不会修改已有代理项目。只使用来自已核对 CI 的构建包；文件哈希用于完整性检查，不能替代可信来源校验。

回环健康检查只能说明服务有响应。正式验收还要检查公网 HTTPS、健康信息中的 SHA、访问口令、独立浏览器隔离，以及一轮真实模型推演。确认完成后，用 `--kind deployed --deploy-url https://实际地址` 重新生成清单，并附上外部检查证据。不要为了生成清单编造地址。

保留上一版本的构建包、清单和数据库备份。代码回滚不保证数据库结构向后兼容；有迁移时先核对兼容性，再决定恢复备份。

旧版三路线评测不能替代五角色工作台的验收。当前版本仍需核对真实输出是否理解用户项目、问题是否按约定收束，以及报告能否用于后续制作。脚本和浏览器测试证明对应行为通过检查，不能单独证明模型语义质量。

## 最终提交

`v1.0.0-provincial` 只在省赛材料对应同一 SHA 后创建，并保持不可变。脚本不会自动打标签、推送、部署或宣称 P1 完成。视频、PDF、仓库和部署清单的 SHA 要逐项核对，再保存平台提交回执。
