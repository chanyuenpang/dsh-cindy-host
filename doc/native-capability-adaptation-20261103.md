# 九组 DSH 原生能力的 Cindy 手机协议适配

## 交付与验证边界

只修改 DSH-cindy-host；业务状态仍由 DSH 原生服务持有。Cindy 源码只作只读契约参考，没有修改、复制执行或运行 Cindy 测试。没有新增协议通道、安装 DSH core/profile 包、发布、重载或执行真实会话副作用。

**已实现的是下表中的原生可表达子集，不是全部 Cindy 产品功能。** 动态服务门禁和缺服务路径有 Host 测试；本次没有把这些测试或 SDK 源码审查当作当前真实 profile/手机实测。部署后仍需在实际挂载组合下验收。

## 能力矩阵

| 能力 | 既有手机入口与 DSH 唯一 owner | 运行时门禁和支持范围 | 明确不支持 |
|---|---|---|---|
| 置顶 | patch-meta；workspaceRegistry 的 pinnedSessionIds/pinSession/unpinSession | 普通可见会话、真实 registry API、提交后重读；幂等重试不重排；原生事件回流 | 不编造原生置顶时间或持久排序；线上的 pinnedAt 固定标记只表示 membership；混合改名/状态/置顶写先拒绝 |
| 手动压缩 | maker:compact-session；receiving Agent scoped commands.find/execute | 目标 preset 必须登记 definitionId=@deepseek-ai/dsh-command-compact；执行真实 /compact 并等待 success/error/no-op | 非空自定义指令、Claude 队列 compact 别名；不提前成功、不自动重放 |
| 普通 fork | maker:fork；sessionController.fork + sessionQuery observation | 复用真实 message/client ID；user-before、完整 completed assistant-turn-end；已创建 child ID 在部分失败时保留 | shadowed/未知/未完成/中途工具边界、分支导航、原地 rewind、虚构回滚 |
| 关键词搜索 | local-db:conversations:search；sessionQuery.filterEvents | 当前 surface 的 literal 搜索；接受的过滤、排序、limit 真正执行；预算用 poolCapped 表达 | hybrid/vector/FTS 伪装，静默忽略过滤或将 limit 缩成 20 |
| 后台 jobs | maker:session-background-tasks:list；jobs.list(sessionId) | own/unowned fence；快照仅 active；真实 terminal 状态经现有 agent_task_update 推送；不读消费型输出游标 | 假 continuations=0、凭消失判 stopped、虚构厂商/工具/文件/费用；没有官方入口的精确 kill/output-tail 不新增 |
| 子代理只读 | subagent-runs list/detail/transcript；native parent catalog、sessionQuery、agents.get、foldConsumedWork | 每次重新授权 parent/descendant；local one-shot/continuable；真实 live/consumed-work/inbox 状态；25 条分页和 tail；不唤醒 Agent | inactive 当 completed、external/unknown 伪终态；resume/steer/stop 均 false；未证实返回父代理的结果不开放；pi 只是传输别名 |
| 提醒增查改删 | schedule list/get/create/update/delete；原生 schedule 服务 | 可见普通会话绑定；周期五段 cron / >=60 秒整秒 interval；原生完整 expected CAS；一次性记录可读/删除；真实提交 ready 事件 | 新会话/worktree/model/notify/script override、manual、暂停/恢复/立即运行、把 delivery 当 run/cost/unread/completion；不能表达的规则明确报错 |
| 工作区顺序 | sidebar get/apply-project-order；workspaceRegistry + workspaceController.insertBefore | 唯一登记本机路径；custom；验证 account/device/source ownerStamp；串行移动、逐步重读；保持未请求项相对顺序 | activity、跨设备混排、未知/重复/歧义路径；不新建排序 store，不假装原子 replace/CAS；部分失败报告实际同 owner 快照 |
| 跨会话引用子集 | local-db:history:messages 和既有 capability probe；native query observation/current surface | 源端授权只读 user/assistant、过滤/游标/裁剪标记、同次捕获 terminal；目标 supported:false/version:1；结构化输入在所有 admission/edit/replay 边界拒绝 | 冻结/锚定/跨设备 snapshot 的目标消费；源端能读不等于目标已消费，普通链接 fallback 也不算结构化消费成功 |

## 实现与门禁证据

- [原生置顶/归档适配](<../src/dsh-session-archive.js>)：直接探测 registry 方法与真实 membership。
- [压缩适配](<../src/dsh-manual-compact.js>)、[fork 适配](<../src/dsh-fork.js>)、[搜索适配](<../src/dsh-keyword-search.js>)：分别由原生命令、fork/query、literal filter API 控制效果和完成语义。
- [jobs 适配](<../src/dsh-background-jobs.js>)、[子代理只读](<../src/dsh-subagent-reads.js>)：不使用 model activation 代替读取，不制造 terminal。子代理 work reader 是 host-provided SDK peer，不安装另一套核心依赖。
- [提醒适配](<../src/dsh-reminders.js>)、[工作区顺序](<../src/dsh-project-order.js>)：无 Host 业务副本；本地 receipts/队列只处理传输重试，不是另一套业务 owner。
- [引用源端](<../src/dsh-reference-history.js>)、[结构化引用边界](<../src/session-reference-boundary.js>)：Native foldSurface 保留可见性，消息与终态来自同一 observation；边界覆盖路由、durable coordinator、prepare、dispatch 和 cold recovery。
- [Source 构造与能力转发](<../src/dsh-plugin.js>)：getter 在调用时读取真实挂载服务；服务缺失/移除不返回空成功。[Host 生命周期](<../src/host.js>) 处理换源、账号切换、socket teardown、授权 peer 和 observation 释放。

### 原生与官方参考（只读）

已核对当前安装 SDK 0.2.1-rc.5 的公开接口及此前架构登记的来源。关键接口包括：

- [Native Workspace controller](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js>)：registry baseline 与 insertBefore。
- [Native schedule](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js>)：catalog、create、完整 expected update、delete、提交后的 changed；history 是 delivery。
- [Native Agent](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js>)、[native subagents](<H:/Program Files/Deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js>)：consumed-work owner、durable child catalog 与 readonly lookup。
- [官方提醒 DTO](<G:/Projects/Cindy/packages/maker-shared/src/scheduleTypes.ts>)、[官方排序协议](<G:/Projects/Cindy/packages/maker-shared/src/projectOrderSync.ts>)、[官方历史 IPC](<G:/Projects/Cindy/apps/desktop/src/main/localDb/ipc/history.ts>)、[官方手机引用](<G:/Projects/Cindy/apps/mobile/src/session/sessionReferences.ts>)、[官方 allowlist](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts>)。这些文件没有导入测试执行。

## 定向验证（不是全量回归）

- 置顶/压缩/fork/搜索：四个对应 Host 文件共 **51** 项通过。
- jobs：**10** 项；子代理：**18** 项；提醒：**19** 项；工作区：**12** 项；引用源端/拒绝边界：**12** 项。
- 引用边界直接影响的 native/coordinator 投递用例：**28** 项通过。
- source 工厂/能力转发：**40** 项；按名称选择的相关路由：**12** 项。
- [专门生命周期验收](<../test/native-capability-lifecycle.test.js>)：**3** 项，覆盖八个 request port 的真实 Host 换源和 socket-close→disconnect 取消链、单 peer 断开时其他 peer 仍可收事件、账号边界及迟到旧 source 回调。
- 通道审计只读取 Cindy 源码文本：**72 served / 124 declined / 0 unclassified**；Host 推送 **12** 个，未分类 **0**。served 代表现有入口有处理，并不表示每个输入变体或 profile 都支持。[推送清单](<../src/host-push-channels.js>) 与实际发送路径保持一致。
- diff whitespace 检查通过。未再运行仓库全量或 Cindy 测试。

### 保留的历史验证说明

用户收紧验证边界之前，一次历史全量在 logout 路由用例出现 expected invalidate/clear/disconnect、actual 多 set-login 的断言差异；这是当时结果，不据此声称当前仍失败或已经通过。该区域有并行认证改动，本次未修改其预期或用全量重跑掩盖。早期新增的 Cindy 源码复制/执行型验证已撤回；保留用户原有/并行的思考流和认证代码，不计为本次九组适配成果。

## 明确留给部署后的验收

当前真实 profile 的服务挂载、不同 preset 下 /compact、手机页面对受限提醒表单的提示、真实数据排序与操作回执，均未在本次执行。需要独立授权后部署并验收；不能由上述 mocks、静态 SDK 或只读通道审计推导为手机实测通过。
