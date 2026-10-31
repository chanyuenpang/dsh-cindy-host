# Host 与最新版 Cindy 协议复核（2026-10-28）

## 审查结论：不完全兼容，默认手机发送链存在高优先级阻断

**0.1.26 已成功发布、安装并加载，但不能视为“新版手机发送问题已解决”。** 已确认新版手机的持久 outbox 确认链与 Host 现有接口不对应。此前把所有拒绝通道都归为可降级能力边界，是不充分的审查方法。

本次只做协议复核和报告，没有修改 Host 运行代码、没有修改或重编译 Cindy 客户端、没有发布下一版本。

## 需求与架构依据

- 只在 Host 侧适配；不要求用户修改或降级手机/桌面客户端。
- Host 是 DSH 到 Cindy 的协议适配层，不是完整 Cindy 原生服务。未实现的高级功能必须诚实声明，但**不能把默认发送链的依赖接口当作可选功能拒绝**。
- 项目已有的[协议边界说明](<../.claw/truth/dsh-cindy-host-device-link-protocol.md#L4-L11>)要求以 Cindy 真实协议决定可宣告的能力；以调用方是否有实际回退决定兼容性，而非以路由是否返回格式正确的错误决定。
- “完全对应”至少要求：调用签名、返回结构、状态含义、确认/持久化语义、错误分类及调用方回退全部一致。通道计数不满足这个验收条件。

## 证据范围和版本

- 审查 Host：实际运行及发布的 0.1.26；以[发布候选源码](<../.release/compat-0.1.26/package/package.json#L1-L4>)为准，不以根目录旧 demo 源码替代。
- Cindy 最新核对 HEAD：[9a77f779c485841992131f94dffe2aced1b58bd9](<https://github.com/makecindy/cindy/commit/9a77f779c485841992131f94dffe2aced1b58bd9>)。独立 reviewer 冻结在 81a96e4；主代理重新 fetch 并比较至 9a77。手机发送页、DeviceLink、持久 outbox 确认模块在两提交间未变；共享 queue 的新增改动是粘贴文本展示范围处理，已读取差异，不能据此假定整个 renderer 没有变化。
- 最新关键协议源码另存为[只读回执定义](<../.release/compat-0.1.26/review-refs-9a77/packages/device-link/src/inputDelivery.ts>)、[outbox bridge](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/MobileOutboxBridge.tsx>)、[投递状态机](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/durableOutboxDelivery.ts>)、[手机历史缓存确认](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/outboxHistoryCache.ts>)。
- 独立只读 reviewer 已完成：核对默认发送入口、确认/重试/FIFO、发布包路由与队列测试，并以隔离 fixture 重现接口缺口；没有向真实 Host 发送测试输入。
- 正式 Host 重启后：pluginVersion=0.1.26、connected、projectionRunning=true、handlerErrors=0。现场已记录完成 enqueue 1 次，以及手机反复调用 sessions:get / input:get-projection / around-client-id，最后一项返回 CHANNEL_NOT_ALLOWED。
- 未读取实际 APK 构建 hash、手机 AsyncStorage/outbox、真实消息的完整关联 trace；未证明此缺口是现场唯一故障。
- 广泛 renderer 稀疏补料发生网络阻滞，已停止，参考 checkout 最后恢复为 clean。**本报告不声称每个 renderer 调用点均已穷举或全部功能已逐项通过。**

## 已确认问题

### P1：默认手机发送的历史确认接口被拒绝

新版普通文本默认进入 durable outbox，不是仅依靠页面直接 enqueue 的旧分支。见[发送入口](<G:/Projects/Cindy-host-audit-20261028/apps/mobile/app/sessions/[sessionId].tsx#L6618-L6633>)。

[bridge:320–337](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/MobileOutboxBridge.tsx#L320-L337>)调用：

```ts
aroundMessagesByClientId(sessionId, clientId, { radius: 1 })
// 返回数组必须有 role === 'user' 且 clientId 精确相同的正式历史消息。
```

对应 wire channel 为 local-db:messages:around-client-id，返回 RemoteMessage[]。Host 的[支持列表](<../.release/compat-0.1.26/package/src/cindy-channels.js#L208-L255>)没有该通道；[默认拒绝](<../.release/compat-0.1.26/package/src/cindy-channels.js#L1713-L1714>)返回 CHANNEL_NOT_ALLOWED。

[hasHistory:92–99](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/durableOutboxDelivery.ts#L92-L99>)只把明确 NOT_FOUND 当作未找到。CHANNEL_NOT_ALLOWED 会抛出，**没有 messages:list/view 回退**。[legacy 确认门禁:265–281](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/durableOutboxDelivery.ts#L265-L281>)因此无法完成历史确认；即使 messages:list 里确实存在该用户消息，也不会自动替代这个调用。

**影响：** 已发送的本地 outbox 记录可能一直不能交接/清理，并可能挡住同会话后续 FIFO。失败后的具体图标/动画还取决于手机记录 state；不能从截图断言所有永久错误都会保持纯 spinner。

### P1：当前只支持 legacy 投递确认，不能宣称新版持久交接

手机[projection 请求:175–185](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/MobileOutboxBridge.tsx#L175-L185>)带 deliveryClientIds；Host 的[get-projection:1577–1596](<../.release/compat-0.1.26/package/src/cindy-channels.js#L1577-L1596>)只读取 sessionId，没有读取这项查询参数。

[新版可选扩展定义](<../.release/compat-0.1.26/review-refs-9a77/packages/device-link/src/inputDelivery.ts#L1-L10>)为 inputDeliveryVersion:1 及 deliveryReceipts（clientId/state）。Host 的[完整 projection 返回](<../.release/compat-0.1.26/package/src/host-input-queue.js#L356-L393>)没有这些字段，也没有 clearBoundaryMs。

**注意：省略扩展本身允许用于旧 Host，不是单独的封包格式错误。** 问题是省略后必须把 legacy 确认链做完整；目前其必经历史定位又被拒绝。[投递状态机:208–212](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/durableOutboxDelivery.ts#L208-L212>)明确规定旧式 queue projection/enqueue 回应只证明内存接收，不构成持久交接；[382–390](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/durableOutboxDelivery.ts#L382-L390>)也不会仅因旧式 enqueue 成功就宣告完成。

不能仅添加 inputDeliveryVersion:1 或伪造 accepted receipt。它会改变手机的持久交接、重放、取消、清空边界判断，需要真实生命周期保证。

### 中：之前的通道审计和测试并未覆盖调用方确认语义

[原路由审计](<../.release/compat-0.1.26/release-audit.log#L1-L8>)统计 226 个允许命名的通道，54 个在审计集合内被支持、172 个被分类拒绝，未分类为 0；其当时只看到了 5 个 desktop renderer 文件。Host 声明总共 55 个 invoke handler（含审计集合外的协议通道），10 个 push 通道。

这些数值表示**路由目录分类**，不是 226 个协议契约全部兼容。独立 reviewer 运行队列和 fail-closed 匹配测试 35/35 通过，同时仍能重现本次确认阻断：测试只证明“未支持通道按正确错误格式拒绝”，没有证明“手机真的能回退”。

此前 826 项通过/3 跳过的生产基线回归和 30 项已安装 runtime smoke，同样不能替代最新版手机 outbox 全链验收。0.1.26 对 queued chatMessage 文本类型和早消费/迟 ACK 的修复有独立价值，但没有覆盖这条新确认链。

## 协议差异矩阵

状态说明：“基础支持”仅代表实现/已有测试或现场交互存在，不是最新客户端全边界认证；“待验收”不得当作通过。

| 协议面 | Host 0.1.26 | 最新客户端要求/判断 | 结论 |
|---|---|---|---|
| envelope v1、hello、link-open/link-accept | 已实现；现场 connected | 支持当前连接与调用 | 基础可用；不能推导业务全兼容 |
| capabilities | 宣告 history-view-v1 | 能力必须与真实实现对应 | 分组历史有实现；未宣告 durable input 扩展 |
| sessions:list/get/patch-meta | 已实现 | 原生列表、行及元信息语义 | 基础支持；新字段与全部 UI 仍待逐项验收 |
| create-session 模型/provider/effort/权限 | 生产基线已适配，未被此次发布回退 | 以实际应用选择为准 | 保留现有支持；非本次手机实测结论 |
| maker:send / input:enqueue | legacy 接受与队列 projection | 新版默认 outbox 还要确认持久消息 | 仅入队成功不充分 |
| idle enqueue 后 pendingQueue=[] | 可立即 admit 并返回空队列 | 消息可已被消费而不在队列 | 本身正确，不应伪造 pending 来补显示 |
| get-projection(sessionId,{deliveryClientIds}) | 忽略第二参数，无回执扩展 | 新版可查 clientId 对应投递状态；旧 Host 进入 legacy 路径 | legacy 部分支持，确认路径有缺口 |
| messages:around-client-id | CHANNEL_NOT_ALLOWED | 默认 outbox 必须找到同 clientId 的 user row | **P1 已确认阻断** |
| messages:around（按 row ID） | 未支持 | 页面聚焦定位可能使用 | 能力缺失；不能与 outbox 的无回退路径混为一谈 |
| messages:list | 已支持，返回正式 transcript | 不是默认 outbox 历史确认的自动替代 | 有接口不等于有回退 |
| history-view-v1 三个 grouped-history 通道 | view/work-details/view-intent 已支持 | 视图刷新、分页、落盘需能覆盖已确认消息 | 基础支持；outbox cache gate 尚待真机验证 |
| input:remove / clear / replay | legacy 队列命令存在 | durable 取消封口/重放/clearBoundary 有额外语义 | 未提供完整 v1 承诺，不得伪宣告 |
| clientId | 已把手机 clientId 传入 DSH requestId 并保留到历史行 | 确认必须同 clientId，不能换 envelope id | 有基础映射；现场全链关联仍待验证 |
| input:projection / history-view-changed 等 push | 声明 10 个现有 push；现场收到投影/历史刷新 | 发送确认仍依赖拉取回执/历史与缓存 | 推送通不等于确认完成 |
| 模型/能力/权限/effort、goal、交互 | 有生产基线实现与测试 | 需要逐调用方校验签名、结果及失败语义 | 部分功能支持；不签发全兼容结论 |
| 文件浏览、附件、媒体/RTC | 有现有实现与边界 | 需要凭据、权限、大小、缓存等真实链路 | 不能用本次文本审查认定全通过 |
| 新增高级功能（side-chat、handoff、review、MCP apps、task tags 等） | 多项明确拒绝 | 是否可选须看实际调用方 | 不支持；不能宣传最新版全功能 |
| 超时与重试 | Host 有慢操作；旧审计已提示部分无手机 override | 响应 deadline、重复请求与真实交接须一致 | 风险保留，需冷启动/大历史/网络故障验收 |

## 不应混淆的降级路径

- 页面路由定位在 history-view unavailable 时可 requestSync，这不是 durable outbox 的 hasHistory 回退。
- 临时 settlingQueueItems 的 10.5 秒清理，不清除持久 outbox。
- legacy 直接 enqueue 页面的 finally，不控制普通文本默认 durable outbox 路径。
- CHANNEL_NOT_ALLOWED 是正常业务拒绝，因此 handlerErrors=0 完全可能；“没有异常”不是手机确认成功的证据。

## 修正路径与取舍（尚未实施）

### 推荐：先补真实历史确认兼容层，再考虑完整 durable v1

最小 Host 单侧修正是实现真实 around-client-id：复用[完整 transcript 数据源](<../.release/compat-0.1.26/package/src/dsh-message-fold.js#L583>)和[现有 clientId 映射](<../.release/compat-0.1.26/package/src/cindy-message-row.js#L329-L342>)，返回对应会话内真实持久 user history 的 RemoteMessage[]。至少覆盖 radius 1（对账）及 0/60（定位），并保留会话绑定、授权和帧预算约束。

未落库时必须如实未找到，之后能够查到才完成确认；不能把待处理队列伪装正式用户历史，也不能只把拒绝改成固定空数组。补接口之后仍要验证[history cache gate](<../.release/compat-0.1.26/review-refs-9a77/apps/mobile/src/session/outboxHistoryCache.ts#L25-L53>)，因为“远端找到”之后，手机还要拥有可重入的本地历史表示。

**取舍：** 这保留诚实 legacy 模式，范围小，直击默认发送链的已确认阻断；不等于完整持久 v1 交接/重放/取消保证。完整 v1 是第二阶段，需要 Host 领域持久状态和清空/取消边界设计，不能作为几个响应字段的补丁。

### 必须补的调用方驱动验收

1. idle enqueue 成功且空队列 → 首次未落库 → 后续同 clientId 历史可查 → 手机历史缓存成功 → 本地 outbox 清理。
2. busy 真排队 → 消费先于 ACK → 不复活旧 pending；仍能完成历史确认。
3. 第一条记录确认后，同会话第二条 FIFO 能继续发送；永久拒绝不应被当作兼容通过。
4. ACK 丢失、重连及 Host 重启：按真实持久证据对账，不伪造 accepted，不重复正式用户消息。
5. 取消、清空与迟到请求保持一致；未实现 durable v1 不宣告该能力。
6. desktop queued 文本类型、引用、多附件、分组历史分页/缓存与帧预算不回归。
7. 真实新版手机完成以上验证后，才能把本次发送问题标为修复；同时记录 APK 版本/构建及 clientId。

## 未验证边界

实际 APK 是否精确对应目标 HEAD、手机 outbox 的真实 state、测试消息的最终落库与历史缓存、UI 动画的唯一成因，尚未读取和闭环。当前事实足以否定“完全对应”，不足以承诺“补一个接口后所有功能都好”。本次是证据化复核完成，不是下一版本修复完成。
