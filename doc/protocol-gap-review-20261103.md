# Cindy 协议 × DSH 原生能力：未接入项审查（2026-11-03）

> 只审查和记录，不修改业务源码、不发布、不操作用户真实会话。
> 主审已完成。独立只读复核未取得实质结果：分派仅收到就绪回执，受支持的结果接口经多次有界等待和恢复后仍返回运行中。本报告不把该分派计作独立复核通过；结论均来自主代理读取的三方证据。

## 结论与基线

**仍有明确缺口，“通道已分类拒绝”不代表“DSH 没有能力”。** 第一批建议原生置顶、手动压缩、普通会话分叉、关键词搜索；其次是后台任务和子代理只读面。提醒、侧栏排序、会话引用需限定语义后接入，不能整族宣称支持。

- Host 0.1.32，HEAD `d23d53a7174f31a213925aaf29351422d8134a4c`；基线业务源码无未提交修改，包含前轮切模/归档。[版本](<G:/Projects/DSH-cindy-host/package.json#L1-L5>)。
- 审查期间工作区另出现思考流相关源文件/测试改动（不是本轮写入），本轮未触碰或回退；本文以各段源码读取时状态为证据，不把并行工作计入本次成果。
- Cindy 本地 origin 指向 makecindy/cindy；HEAD `dc294b02cadf2339da10c07df8d7c005bcad3dc0`，本地 origin/main 为 `1dba6f01eee35d5b2ead174f00c7524079c81383`。没有 fetch，**不声称官方远端最新版**。本地既有手机/传输测试改动未动，关键 allowlist/invokePolicy 不在改动清单中。
- DSH 安装版 0.2.1-rc.5，见[运行包版本](<H:/Program Files/Deepseek/resources/app.asar/dsh/package.json#L1-L5>)。本文“支持”指有已读取的真实实现，不保证每个用户 profile 均挂载该服务；实施仍须可选注入和能力探测。
- 当前[审计脚本](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L319-L349>)覆盖词表 196 项：served 56、declined 140、unclassified 0。这是分类结果，**不是官方所有协议的穷举或端到端兼容认证**。没有重跑业务全量测试或手机实测。

- 验证补充：在隔离 router 上实测 compact 两个入口、fork、搜索、后台任务列表、子代理列表、schedule:list、引用能力探针、项目顺序读取共 9 条请求，均返回 CHANNEL_NOT_ALLOWED；副作用计数为 0。已校验报告 47 个证据链接/26 个文件的路径及行号范围，无失效链接。

## A. 确定存在原生底座，但 Host 未接

### 1. P1 — 原生置顶/取消置顶同步：目前仍是本地模拟

- Cindy 使用 `local-db:sessions:patch-meta(id, {pinnedAt})`，取消置顶为 null。[官方入口](<G:/Projects/Cindy/apps/mobile/src/session/useSessionListActions.ts#L48-L92>)。
- DSH 已有 `pinSession/unpinSession` 和有序 `pinnedSessionIds`。[原生接口](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js#L321-L345>)、[原生基线](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js#L62-L71>)。
- Host 只有 archived/active 进入原生分流，单独 pinnedAt 仍写本地 flags。[运行时](<G:/Projects/DSH-cindy-host/src/host.js#L392-L410>)、[本地写入](<G:/Projects/DSH-cindy-host/src/session-flags.js#L109-L124>)。原生观察器也只比较 archived 集合。[观察器](<G:/Projects/DSH-cindy-host/src/dsh-session-archive.js#L35-L48>)。
- 影响：Cindy 能显示“置顶成功”，但 DSH 原生侧栏不跟随；原生侧栏置顶也不回流。时间戳与有序 ID 集合须稳定映射，不能每次读取捏造新时间。

### 2. P1 — 手动压缩上下文：旧超时阻塞理由已过期

- Cindy 有 `maker:compact-session(sessionId, instructions?)`，另有 Claude 专用 `maker:input:compact`。[手机调用](<G:/Projects/Cindy/apps/mobile/src/device-link/mobileMakerTransport.ts#L1145-L1155>)。
- DSH 的 /compact 已调用 `compaction.compactNow(agent, signal, commandId)`，有真实忙碌/取消/结果处理。[原生命令](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-command-compact/lib/index.js#L48-L71>)。
- 两通道均不在 Host [支持表](<G:/Projects/DSH-cindy-host/src/cindy-channels.js#L212-L262>)；[旧审计](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L98-L107>)仍以“手机只有 15 秒”拒绝。
- **当前协议已给 compact-session 11 分钟，手机 resolver 会回退共享表。** [共享超时](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L724-L730>)、[手机 resolver](<G:/Projects/Cindy/packages/device-link/src/invokePolicy.ts#L73-L86>)。
- 应接原生 compaction/命令路径，不再等待并不存在的 Cindy 超时修复。DSH 当前 /compact 无参数；不得静默丢弃 instructions、忙碌时强行执行或提前报告完成。成功后需刷新历史。

### 3. P1 — 普通会话分叉 maker:fork

- Cindy 参数为 sourceSessionId + messageClientId，返回新会话行并广播创建。[官方 handler](<G:/Projects/Cindy/apps/desktop/src/main/maker-ipc/fork.ts#L34-L76>)。
- DSH `sessionController.fork({sessionId, atSeq?})` 已实现事件前缀分叉、parentSession 和工作区附着。[原生实现](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js#L842-L910>)。
- Host 整族仍按 [rewind/fork plan rule](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L80-L82>)拒绝。
- 必须精确转换展示消息/clientId 到事件 seq，校验 user/assistant 边界并返回新行/推送。**messageClientId 不能直接当 atSeq，fork 不等于原地 rewind。** Codex strip-encrypted 也不是通用 fork 的自然等价物。

### 4. P1 — 会话关键词搜索

- Cindy `local-db:conversations:search` 有 query、limit、排序、semanticMode、归档/引擎/工作目录/时间等条件。[官方入口](<G:/Projects/Cindy/apps/desktop/src/main/localDb/ipc/search.ts#L14-L47>)。
- DSH `sessionController.search` 调用 `sessionQuery.searchSessions`，对可见会话的当前 user/assistant 消息返回 sessionId/snippet/hasMore。[原生实现](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js#L2004-L2085>)。
- Host 以[搜索/目录历史未实现](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L69>)拒绝。
- 可做关键词子集，但不能将 DSH 默认最多 20 项的消息搜索冒充完整标题/语义搜索。归档/删除过滤、分页和权限须实际实现，不静默忽略查询条件。

### 5. P2 — 后台任务列表、输出尾部和精确停止

- Cindy 已有后台任务列表及相应活动/输出/停止协议。[官方目录](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L407-L418>)。
- DSH `jobController.list/follow/kill` 提供按 session 授权的集合、非消费输出游标及人工停止。[原生实现](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-job-controller/lib/index.js#L324-L372>)。
- Host 虽有内部 jobs fold/`jobsFor`，但 InputProjection 只输出 queue，专用控制仍拒绝。[内部 fold](<G:/Projects/DSH-cindy-host/src/host-input-queue.js#L307-L340>)、[投影边界](<G:/Projects/DSH-cindy-host/src/host-input-queue.js#L343-L393>)、[输出拒绝](<G:/Projects/DSH-cindy-host/tools/compat-boundaries-20261028.mjs#L19-L25>)及[活动拒绝](<G:/Projects/DSH-cindy-host/tools/compat-boundaries-20261028.mjs#L55-L61>)。
- 需转换 ID/状态/输出，保留 owner fence、输出预算和非消费读取。**停止单个 job 不能退化成停止整个 Agent；Cindy agent-task handle 也不是 DSH sessionId。**

### 6. P2 — 子代理运行的只读发现、详情和历史

- Cindy 已公开 `local-db:subagent-runs:list/detail/transcript`，控制另走 `maker:pi-subagent:control`。[官方协议](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L412-L418>)。
- DSH `subagent.listChildren/listDescendants` 能读取持久目录，不唤醒 Agent；继续投递/中断有严格父地址授权。[只读目录](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L3138-L3167>)、[控制边界](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js#L3170-L3227>)。
- Host 仍按 [subagent runs family](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L119>)拒绝。
- 先做只读列表/详情/历史，区分 continuable/one-shot、不可恢复或损坏目录；控制单独设计。不能绕过父子授权，把子会话塞给普通 sessionController。

## B. 有底座，但不能整族照搬

### 7. P2 — 定时提醒，而非完整 Cindy scheduler

Cindy 包含创建、暂停、恢复、立即运行、运行历史、费用、未读、模板/脚本等。[通道族](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L340-L361>)。DSH 已有 `create/list/catalog/history/update/delete` 和 changed 事件，绑定原始 session。[原生创建/列表](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js#L2068-L2135>)、[历史/编辑/删除](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js#L2137-L2234>)。Host [整族拒绝](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L47>)且[无对应推送](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L370-L375>)。

可设计对话提醒子集，不宣称脚本执行、独立运行 session、run-now、完整费用和未读模型；不能用删除冒充暂停。

### 8. P2 — 工作区/项目顺序同步

Cindy 有 owner-scoped `get-project-order/apply-project-order` 和 changed 推送。[官方入口](<G:/Projects/Cindy/apps/desktop/src/main/projectOrderStore.ts#L169-L180>)。DSH 有 workspace.insertBefore 和 workspace 内 insertSessionBefore。[原生接口](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js#L256-L287>)。Host [整族回退本地混排](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L61-L64>)。

可同步共同的项目顺序部分；Cindy mixed key、owner、snapshot revision/冲突、路径去重须先设计，不能直接用原生 ID 数组冒充完整快照。

### 9. P2 — 跨会话引用消费

Cindy 发结构化引用前探测 `maker:input:session-reference-capability` 并校验 supported/version。[协议](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L53-L59>)、[消费门](<G:/Projects/Cindy/apps/mobile/src/session/sessionReferences.ts#L812-L848>)。DSH `sessionReferenceResolver.prepare` 已读当前投影快照，生成带来源/序号/裁剪预算/spill 信息的持久不可信上下文。[原生准备](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-reference/lib/index.js#L603-L658>)。Host [当前拒绝探针](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L127>)，未接字段与快照转换。

存在底座，但需实现引用源可见性、同/跨设备快照验证、重试持久性和预算。**不能只改 supported:true，更不能把外部会话文本提升成系统指令。**

## C. 不应误报为“可直接接入”

| 协议面 | 限制 |
|---|---|
| Pi session tree/navigate | 是同一 Pi 会话内的分支导航，会改写分支并可能 summarize；不是 DSH 子代理树。[官方 handler](<G:/Projects/Cindy/apps/desktop/src/main/maker-ipc/register.ts#L17247-L17294>)。|
| 原地 rewind/消息删除 | 已验证的是 fork；未验证原会话截断或工作区文件回滚的等价接口。|
| 完整费用、订阅和额度 | DSH sessionStats 的回合/时延/decodeTokens 不足以构成各厂商账户额度、计费或订阅窗口。可另做真实统计子集，缺数据为 unknown。[统计字段](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session-stats/lib/index.js#L159-L180>)。|
| 上下文预算写入 | 自动压缩阈值不等于修改模型硬窗口；不能用 thresholdRatio 冒充完整预算协议。[现有缺口](<G:/Projects/DSH-cindy-host/tools/compat-boundaries-20261028.mjs#L27-L33>)。|
| 插件、Orca、厂商引擎切换 | DSH Cordis/子代理/Team 不等价于 Cindy .cindy/Orca/厂商 CLI 实例；普通模型切换也不等于迁移引擎。|
| 模型收藏/预测提示词 | 尚未核实可直接复用的原生持久收藏或预测接口；有模型调用能力不等于原生已支持产品协议。|

## 验收与优先级

1. 第一批：**原生置顶 → 手动压缩 → 普通 fork → 关键词搜索**。每项补真实完成/拒绝、刷新推送和控制端消费测试。
2. 第二批：后台 job 面板/精确 stop、只读子代理，再按产品需求决定提醒、排序、引用子集。
3. 模型切换、原生归档已经在本次 Host 基线中，不重复计缺口；历史窗口、持久输入确认、文件传输、goal、权限/plan-mode 的旧拒绝描述也不能压过当前实现。
4. 审计里“close-session 因 DSH 没有 archive”及旧 history fallback 等文字也应另行校正，**但不能直接把 close/release 映射成 archive 或据此实现副作用**。参考[旧分类](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L65-L84>)。
5. 更新分类与实现分开；本轮没有修改现有源码/测试，没有发布或重载，也没有真实压缩、fork、停止、归档操作。本报告是静态协议审查，不是实机认证。
