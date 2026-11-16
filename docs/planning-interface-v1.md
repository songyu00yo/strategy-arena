# 需求工作台接口约定 v1

## 当前状态

当前源码已实现本文件中的三个 API。共享类型见 `src/lib/planning-contracts.ts`，状态机见 `src/lib/server/planning.ts`。接口实现与部署状态分别记录；新增源码不代表线上服务已经更新。

生产路径调用原有模型适配器。测试替身只位于测试目录；模型未配置或请求失败时显示实际错误，不生成模拟 Agent 内容。

## 数据归属

`PlanningSnapshot` 是服务端状态。`session` 包含当前规划内容、允许动作、Agent 状态、问题、答案、草稿、查漏和报告。`events` 是有序的真实事件。

`revision` 表示需求内容版本。仅播放游标、动画、轮询、Agent 工作状态变化不增加这个版本。`eventCursor` 用于识别活动顺序，不能用它替代需求版本。

`snapshotVersion` 在每次服务端可见变化时递增，包括预览文字和 Agent 状态。前端仅接受同一 session 中不早于当前版本的快照。并发 GET 与 POST 返回顺序改变时，旧快照不能覆盖新内容。

每个来源以 kind 和 id 引用 `session.sourceRecords` 中的原始记录。快照包含当前方案引用的来源；事件分页或历史窗口裁剪不能让来源失去正文。用户原话和模型分析保留不同 kind，不因被引用就变成已验证事实。

浏览器只维护纸窗开关、用户未提交的输入、播放位置和动效队列。它不能自行把 Agent 改成完成、把事项改成用户确认，或者把报告改成正式版本。

## API

| 请求 | 输入 | 成功响应 |
| --- | --- | --- |
| `POST /api/planning` | `CreatePlanningInput` | `PlanningSnapshot`，HTTP 201 |
| `GET /api/planning/{id}` | 无 | `PlanningSnapshot`，HTTP 200 |
| `POST /api/planning/{id}/actions` | `PlanningAction` | `PlanningSnapshot`，HTTP 200 |

创建操作只创建 session，不请求模型。`modelMode` 复用当前模型选择器返回的有效模型标识。后端沿用现有 owner Cookie 和同源检查。

所有变更带唯一 `operationId`。同一个操作重试使用同一个 ID、相同参数。相同 ID 携带不同参数应拒绝。已发出的请求结果未知时，先读取状态，不能换 ID 盲目重发。

除创建外，每个动作带用户所见的 `revision`。过期内容返回冲突，前端保留本地输入，读取新状态并解释发生了什么。

错误沿用当前项目的 `{ error, code }` JSON 结构。错误响应不能当作业务成功。后端的能力字段控制允许动作，前端不能靠按钮显示状态绕过检查。

## 动作

| kind | 语义 |
| --- | --- |
| `advance` | 执行下一项真实规划动作；单次不执行无上限循环 |
| `answer` | 保存用户对当前版本问题的实际回答 |
| `note` | 保存用户补充、追问、否定或纠正，可关联事项 |
| `preview` | 查漏并准备阶段报告；保留所有未答状态 |
| `confirm` | 对指定 reportId 和 fingerprint 做用户正式确认 |
| `stop` | 阻止启动后续模型动作；已经发出的请求仍需记录结果和用量 |

前端成功保存答案后，可以根据最新 `nextAction` 与 `canAdvance` 发起下一次推进。推进不能以动画结束为触发条件。后台处于 working 时，读取快照只更新界面，不额外发起推进。

同一 session 同时最多一个推进操作。建议工作中约每秒读取一次快照，页面隐藏时减频；轮询不代表新的模型调用。初次恢复时读取已有状态，避免重新创建任务。

## 展示状态

| status | 用户可理解的含义 |
| --- | --- |
| ready | 任务已建立，准备下一步 |
| working | 有真实工作正在执行 |
| awaiting_user | 当前需要用户作答或判断 |
| review_ready | 当前报告可供审阅；是否能正式确认仍看 canConfirm |
| completed | 用户已确认当前报告 |
| paused | 暂停后续工作 |
| failed | 已知失败；已有内容保留 |
| uncertain | 请求结果尚未核实；停止自动推进 |

Agent 卡片读取各自的 `status`、`taskLabel`、`summary` 和 `preview`。三张卡不必同时运行，也不必每轮按固定顺序各发言一次。完成任务的卡片可以保留已有产物。

## 问题与回答

只自动展示 `status=active` 的当前问题。问题的 `askedBy` 决定纸张来源，`answerTo` 决定回答回执接收方。没有来源数据时使用中性的工作台位置，不伪造某个 Agent 已发问。

提交带 `questionId + questionVersion`。选项传 optionIds，文字传 text，数字传 number。unknown 和 skipped 保留原意，不能写成用户确认。用户的自由文字由后端解释为新信息，不能在前端直接改需求事项。

服务器返回 `answer_saved` 后才能播放成功回执。若刷新时这条事件已经存在，显示保存状态，不重播。`question_issued` 事件的 questionId 和 questionVersion 必须匹配当前 active 问题，才允许自动弹出。

## 事件与动画

事件包含稳定 `id`、`seq`、`from`、`to` 和关联的 questionId、answerId、itemIds。重复快照可以包含同一事件，前端按 sessionId 和事件 ID 去重。

动画只表达已经发生的业务事件。它可以延迟展示内容，但不能改变回答、确认、调用或费用。`agent_started` 表示真实调用已经启动；候选输出通过校验后才发布正式问题和需求变更。

首次恢复现有 session 时，将已存在的事件作为历史读取。新事件继续播放，当前待答问题始终有入口。回放使用前端独立游标，不能再次发出 answer 或 confirm。

## 报告与确认

`report.status=draft` 可用于阶段预览。只有当前 review 和 report 都对应当前需求内容，且用户显式确认后，后端才写 `confirmed` 和 `completed`。

`review.contentFingerprint` 和 `report.contentFingerprint` 都指向当前需求内容的指纹。`report.fingerprint` 指向用户实际审阅的报告正文。confirm 提交后者；后端同时检查 reportId、内容版本、内容指纹、报告指纹及当前查漏结果。不能确认旧内容上的新报告，或新内容上的旧报告。

`canConfirm` 由后端计算，至少要求当前有效查漏的 ready 为 true、blockers 为空、无阻断执行的必需未决事项或冲突，且报告与需求版本及指纹匹配。confirm 时重新检查这些条件。确认时间和状态等元数据不改变被审阅正文的指纹。

`review.ready=true` 不表示用户已经批准，也不证明现实执行必然成功。未验证条件继续出现在风险或未决事项中。最终报告提供 markdown 和 executionPrompt，前端可以复制或下载。

## 实现位置

| 部分 | 文件 |
| --- | --- |
| 共享类型和输入、模型输出校验 | `src/lib/planning-contracts.ts`、`src/lib/planning-schemas.ts` |
| 状态机、真实模型调用、报告和持久化 | `src/lib/server/planning.ts`、`prompts/planning.ts`、`migrations/006_planning.sql` |
| API | `src/app/api/planning/` |
| 客户端同步与请求恢复 | `src/components/use-planning.ts` |
| 工作台、问题纸窗、报告和动效 | `src/components/planning/` |
| 旧记录入口 | `/?legacy=1`、`/?arena={id}` |

旧路线流程继续使用原有 `use-arena.ts` 与 `intake-contracts.ts`，新工作台直接使用规划接口。原有计费适配器、依赖和锁文件继续复用。
