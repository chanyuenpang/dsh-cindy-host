# 会话列表统一同步：实现与验收边界

## 当前实现

正式版本 `0.1.44` 以已在用户环境加载验收的 `0.1.44-local.6` 为运行实现基线；正式发布只调整版本身份与发行说明。发布不自动更换或重启当前运行实例，也不把源码/安装检查等同于手机验收。DSH 原生会话/投影/工作区注册表仍拥有业务事实。发行门禁与范围见 [0.1.44发布记录](<releases/0.1.44.md>)。

- `src/dsh-session-source.js` 现在承载单一、可丢弃的列表投影。构造时先订阅原生事件；精确观察建立 core，native title projection 是标题来源。有源/行版本围栏，没有 5 秒结果 TTL、60 秒空标题缓存或失败时返回旧成功页。
- 普通并发读取只共享在途工作；fresh 不复用已开始的旧 catalog 查询，可以共享请求后才开始的排队查询。catalog 串行、精确 core 修复并发 2、等待队列最多 128，重复变化/缺 core/超过读取预算明确返回不可用。已验证 core 在连续源观察下复用；缺 checkpoint 的真正冷恢复可能超过单次预算，不把部分集合伪装为完整快照。
- `updatedAt` 与 `lastActivityAt` 使用同一个原生时间：`max(createdAt, lastPromptAt ?? 0)`。首次可显示用户消息时间 `userSendAt` 是独立证据，不承担最近活动排序。标题、模型、turn-end、发送和后台输出不生成 `now()` 排序；旧错误的未来时间允许被权威值纠正。
- 状态/置顶覆盖以后，先选最近窗口并补齐窗口外 pinned，再为被选行按最多 2 并发补消息证据。证据 memo 最多 1024 条、只保存允许的标量，不允许覆盖 title/time 等 core。补齐后主动发字段更新；不后台预热全部历史。
- `src/dsh-message-fold.js` 的 list evidence 冷读只保留行身份/计数/首次用户时间等标量，不生成 work/history 视图、不挤占三会话 detail LRU；已有热详情仍可复用。冷证据仍需读取/扫描对应历史，因此它不进入列表响应关键路径。
- router 不再持有独立 settled page。Host 不再清空并重建另一份 native 全表缓存；native 列表、精确 get、诊断和推送从同一 source 投影读取。旧 API/fixture 的 map 仅保留在明确的 legacy 分支。

## local.4 回归修复与已确认的旧格式范围

真实运行时证明 local.3 会在一个旧 v0 会话的原生 v4 迁移拒绝后持续处于 rebuilding，导致手机所有 list 重试失败；此前合成性能测试没有覆盖这一生产 corpus 组成。

用户已明确选择优先恢复新会话：仅对原生列表明确声明 `formatStatus: 'migration-required'` 的条目，在手机发现视图暂不纳入。`diagnostics.listing.migrationRequired` 显式计数；不尝试迁移/修改旧日志，不把 operational error 当不存在，不隐藏 current-format 的 I/O/replay 错误。原生列表以后将该 ID 声明为 current 时，自动重新验证并纳入；显式 get 保留原生查询结果/真实拒绝。这是已确认的远端可操作范围，不是全历史格式都完成兼容的承诺。

行签名现在按该行版本和 core generation 提交，不再因另一行发生事件丢掉进度。新建只失效新 ID；fork 只做 membership barrier；compaction 只重读其目标。未知来源的全局 core invalidation 仍保留原围栏语义。rc3 优先通过原生 `inspectSession` 在同一精确切面只计算 title/list-metadata/model/permissions 四个列表域，不再为每行计算所有已安装插件的历史/工具/费用投影；缺该接口的兼容路径才保留 all-projection observation。

## local.5：辅助信息不能饿死列表读取

local.4 将每次 evidence 完成同时当作 source list-version 变化和 router 全局失效；真实原生全表约 1620 个 Session（包括子会话），单次查询约 1–3 秒，后台补齐过程中不断重做便可耗尽 5 秒预算。APP 重启或补齐暂时停止只会短暂掩盖问题。

现在 `viewRevision`/原生 epoch 仍约束核心事实；独立 `enrichmentRevision` 记录辅助信息更新，不撤销在途 core 证明，不重启完整 catalog，也不重复重建不含辅助字段的 Host model。证据仍按自身行版本校验、选定窗口补齐和现有 latest-wins patch 推送。列表返回的是其物化切面的已知辅助值，后续补齐通过 patch 到达，不等待整个窗口补齐；核心重命名/模型/权限/源与授权变更的旧结果围栏没有放松。

临时回环只读探针用运行中的原生 list/inspect、实际 source/router 及相同版本 guard 进行对照，既记录首次冷覆盖超预算，也记录已热覆盖在补齐中的成功/失败；这不等同于手机 transport/UI 已验收。诊断包必须在收尾移除，不随主包发布。多组探针同时补齐会超过生产单 source 的两 worker 负载，额外压力下原生查询自身仍可能超预算，不作为正常双 worker 时延承诺。

## local.6：行失效不是集合失效

local.5 重启后，用户重新登录并确认特定服务管理任务已出现、刷新正常，但后台追加读取仍有一次5053ms超时，后两次4435/907ms成功。因此仅记录当时UI恢复，不能把重新登录当作已证明的根因修复。

残余复现：即使列出的标题/模型/权限等字段完全不变，活动会话的每个 request/header 都 bump 原始 epoch；catalog、外层 source 和 Host 的多个全局围栏因此重复整表读取。新版本分为：原始行 dirty revision（诊断）、集合结构 revision、全局 core generation、规范化 core view revision，以及已有 enrichment revision。

已知行的脏通知只重新获取该 ID 的原生精确切面，不取消整份 catalog。物化前重新排空所有支持行的 dirty 版本，真实读取失败仍拒绝整表；成员增加/移除、未知 ID、全局失效仍有集合围栏。返回携带已验证结构代次的内部 cut，避免已在内部重新协调后又因旧起始代次做一次无谓目录读取。实际行变化仍增加 core view revision，重命名/权限/来源与编码期间变化的旧值围栏保留。已确认的 subagent 生命周期不影响普通任务集合，普通 fork 仍属于任务。

没有改 fresh 的“查询开始后才可共享”约束、没有结果 TTL/旧成功回退、没有扩展已确认迁移范围，也没有延长5秒预算。真实原生服务上仅在诊断实例模拟每秒20次 raw invalidation（不发送提示、不改变原生业务数据），已安装local.5约4999ms失败；候选719/730/835ms连续成功，raw revision递增、集合及规范化view保持不变，均一次attempt。首次冷覆盖仍约16–19秒，未宣称消除。该对照不等于新版本手机UI已验收。

## 交付与恢复

`src/session-list-delivery.js` 是有界状态协调器，不是持久 outbox 或可靠事件流。每 peer 的工作受源、账号连接代次、授权 revision 和订阅 lease 围栏保护；标题等字段 250ms latest-wins 合并、每轮最多 8 行，状态/运行边界立即合并发送。全局 patch 字节、行数、peer 数和 socket 背压都有上限。撤权、源替换、退订和停止释放旧工作。

新行必须先在 native core 中可读/可见，再发送带真实 ID 的 `sessions:created`。已有行发送允许字段补丁，并携带同一活动时间对。native live removed 只是重新观察提示，不等同于删除；catalog 缺席也需精确身份确认。

**通用 reseed 发布门禁：默认关闭。** 原生 `sessions:created {sessionId}` 与泛化的 `sessions:created {}` 不是同一个生产语义。当前官方源码消费者忽略 payload 并重拉，允许在经目标版本验证的支持范围复用 `{}`。本实现只有集成 owner 提供 `listReseedValidated(peer) === true` 才启用首次/恢复/变更与名义 60s（加有界 jitter）的泛化通知。生产插件没有根据 peer 自报版本或 capability 自动放行，也没有默认打开此 gate。

源码 consumer 片段测试、fake socket 或最新 checkout **不能生成目标 APK 的验证记录**。必须测目标版本完整 transport → payload 校验 → store mutation epoch → fresh 重拉链路，包含空列表、全删除、满窗口补位、通知在途、后台/重连。未完成前不得启用该兼容复用、宣称该版本全链路支持或发布整体策略。普通真实创建通知和字段 patch 不依赖此泛化 gate。

`send=true` 只表示交给本地 socket。官方已有可选 transport ACK，但本次未实现/声明 `reliable-transport-v1`、新业务 ACK 或 delta；也不把发送/ACK当成 UI 已应用。名义 60s 是拟采用的 Host 补偿周期，不是手机 pull 周期，也不是固定可见性时延承诺。

## 传输

`src/session-list-transfer.js` 仅对成功的 `local-db:sessions:list`，依据当前请求的 `payload.transfer` 做编码：

- 旧调用方/错误回复保持 plain；不缓存、跳过或复用业务 handler 的执行结果。
- JSON 达 4096 UTF-16 字符时附 SHA-256 tag；同内容的合法 `ifNoneMatch` 返回 `notModified`。
- `gzip:1` 且 UTF-8 至少 1 KiB、包装后节约超过 10% 才异步 gzip/base64；并发最多 2，容量不足或压缩失败回 plain。
- delta 声明可以得到合法全文 fallback，不产生或声称 delta。源/授权/连接/订阅/列表版本在异步编码后再检查，随后对最终 wire frame 预算检查。超限显式拒绝，不截断逻辑会话集合或丢置顶。

## 验证

当前 canonical `npm test` 仅运行工作区 `test/*.test.js`，避免把 `.release` 等历史包副本也当成当前测试。没有删除历史副本或为它们改代码。

```powershell
$env:CINDY_LIST_SOURCE_ROOT='G:\Projects\Cindy'
$env:CINDY_HISTORY_SOURCE_ROOT='G:\Projects\Cindy'
npm test
```

新增测试覆盖 source 的 fresh/旧 completion/空标题/订阅先 baseline、确定性窗口/证据、交付合并/背压/容量/撤权/恢复、Host 无后续 poll 改名/创建、异步压缩期间变更、官方真实 InvokeResultCache 解码和排序 helper。官方创建消费者测试执行当前源码分支，不冒充整 app/APK 验收。

`test/session-list-performance.test.js` 使用 20/200/2000 行合成 catalog 检查 hot 读取不重复精确 core 修复、不重复 header 全库扫描、不读取历史正文；同时记录 cold/warm 算法耗时。这不是实际 DSH 磁盘、网络或手机渲染 p95。生产验收还要单列 checkpoint 热、真正冷恢复、大历史、多 controller、事件循环延迟及端到端耗时。

诊断入口：已有 status 的 `diagnostics.listing` 增加 coverage/core/evidence 状态；其 `delivery` 给出 pending 字节/条数、重试、compatibilityBlocked、staleDropped 以及 transfer 计数。不要据本地 sent 计数声称手机收到或应用。
