# 部署与发布

## 部署边界

本仓库提供 Linux standalone 服务模板，没有据此声称已部署到生产环境。生产验收需要真实 HTTPS 地址、与提交一致的健康信息、真实模型流程、访问隔离记录和实际费用。

Node.js 版本固定为 `24.19.0`，pnpm 版本固定为 `11.19.0`。SQLite 需要可持久写入的目录，当前模板面向单实例。需要关闭浏览器后继续运行时，设置 `ARENA_WORKER_ENABLED=true`，由长驻 Node.js 进程轮询数据库中的可执行步骤。进程停止期间任务暂停，未知外部请求不会自动重试。serverless 平台不保证这类后台执行。不要直接启动多个共享同一数据库的应用实例；多实例部署需要另行验证事务与预算控制。

默认把 Node.js 服务绑定到 `127.0.0.1:3100`。现有反向代理负责 HTTPS 和转发。不要覆盖其他项目的代理配置、环境文件或数据，也不要把这些私有文件复制进本仓库。

## 服务目录和环境

建议使用以下目录：

```text
/srv/strategy-arena/releases/<commit-sha>/
/srv/strategy-arena/current -> releases/<commit-sha>/
/srv/strategy-arena/data/
/etc/strategy-arena/arena.env
```

由管理员创建专用低权限用户 `strategy-arena`，并让该用户可写数据目录。环境文件放在发布目录外，权限设为仅管理员和服务账号可读。不要把填写后的环境文件提交到仓库。

根据 `.env.example` 填写真实模型密钥、随机会话密钥和预览访问口令。设置 `ARENA_DATABASE_PATH=/srv/strategy-arena/data/arena.sqlite`，把 `ARENA_PUBLIC_ORIGIN` 设为实际 HTTPS 源站地址（例如 `https://你的域名`），并把 `RELEASE_COMMIT` 设为完整的提交 SHA。源站校验不信任任意转发头；反向代理必须保留正确的 Host。预览口令用于限制进入付费推演，不能代替每个浏览器的所有者隔离。

生产环境默认要求 `ARENA_ACCESS_CODE`。只有明确决定开放公开演示时，才设置 `ARENA_PUBLIC_DEMO=true`；公开演示仍需费用和请求限制。不要把测试口令或测试会话密钥用在生产服务中。

配置服务前先检查 [systemd 模板](strategy-arena.service.example) 中的 Node.js 路径、目录、用户名和端口。SQLite 数据放在独立持久目录。升级前先停止写入或使用 SQLite 一致性备份；运行中的数据库不能只复制主文件而忽略 WAL。

## 打包和校验

在冻结提交上完成检查，再生成构建包：

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

打包器只复制 standalone、静态资源和可选的 `public`，并通过根目录允许列表排除项目私有目录、环境文件、数据库和密钥文件。打包后还会扫描密钥形态，并拒绝逃逸到包外的符号链接。扫描不能代替密钥管理和人工核对。包内 `release-info.json` 记录提交、工作区是否有未提交变更、应用版本、Node.js 版本和 pnpm 版本。开发包有未提交变更时，提交 SHA 不能代表完整源码；部署校验器会拒绝这类清单。构建过程可重复执行；当前工具没有承诺不同机器产物逐字节相同。

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

## 最终提交

`v1.0.0-provincial` 只在省赛材料对应同一 SHA 后创建，并保持不可变。脚本不会自动打标签、推送、部署或宣称 P1 完成。视频、PDF、仓库和部署清单的 SHA 要逐项核对，再保存平台提交回执。
