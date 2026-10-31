# Cindy 最新版兼容性调查（2026-10-28）

## 结论

需要做一版有明确边界的 Host 兼容修复，优先修复输入队列回包；不需要为此改动 Cindy relay 或重写整个适配层。

现场所说“消息发出后 Cindy 崩溃重启”，存在一条高度吻合且可离线复现的因果链：Host 把 DSH content-block 数组用作排队条目的 UI 正文，桌面端在投影出队时直接升格为消息，再调用只接受字符串的提问导航解析器。消息已提交与随后显示失败可以同时发生。

## 版本和获取范围

- 已安装 Cindy 桌面应用：0.1.115（可执行文件 ProductVersion）。
- 已安装 DSH Host 插件：0.1.25；其队列构造器仍输出数组正文。
- 当前项目包清单仍为 0.1.13，包含大量既有未提交开发改动；不能直接把此工作区整包覆盖线上 0.1.25。
- 原 Cindy 本地分支：fix/mobile-peer-silence-probe，HEAD dc294b02ca（2026-09-19），有本地改动。未清除这些内容。
- 已 fetch 上游 main：2ef024d78443011b2fbf7e4b601d3c703a5b3ceb，2026-10-28。
- [独立稀疏源码目录](<G:/Projects/Cindy-host-audit-20261028>) 固定于上述 commit。已检出此次调查所需协议、发送、投影和导航源码，未声称完整下载/构建整个 Cindy 仓库。
- 网络上先后发生普通 fetch 连接重置及过宽检出 HTTP 408；浅 fetch、缩小检出范围后成功。

## 现场证据

[当日日志](<C:/Users/chany/AppData/Roaming/Cindy/logs/main-2026-10-28.log#L6026-L6028>) 在 16:08:56 记录：

- renderer console：TypeError: e.split is not a function。
- React Router：caught the following error during render。
- route-error-fallback：route render crashed，variant=section。
- 栈进入 gitSafetySettingsStore / mergeSessionSources 对应的引用标记清理与消息导航链。

16:08:58 后重新出现 renderer app_start。它证明了会话页渲染异常/恢复，不能单独证明 Electron 主进程或 DSH Host 进程在该时刻崩溃。凌晨 01:40 的 Object has been destroyed 是另一次生命周期错误，不混为本次发送故障。

Host 当前在线，诊断另有 sessions:get 的 session observation was aborted；这些读取取消也不能直接当作桌面渲染异常的原因。

## 协议缺口与调用链

1. [Host 队列构造器](<../src/host-input-queue.js>) 的 toQueuedRemoteMessage 与 queuedRowFromController，把 DSH content block 数组赋给 chatMessage.content；text 字段本身已经是字符串。
2. 最新 [makerChatStore](<G:/Projects/Cindy-host-audit-20261028/apps/desktop/src/renderer/lib/makerChatStore.ts#L4922-L4929>) 在队列出队/settling 时直接展开 item.chatMessage，未把数组正文转换为字符串。
3. 最新 [消息导航](<G:/Projects/Cindy-host-audit-20261028/apps/desktop/src/renderer/components/chat/messageNavRailModel.ts#L261-L262>) 把可见正文交给 stripChatQuoteMarkerLines 后 split。
4. 最新 [显示文本投影](<G:/Projects/Cindy-host-audit-20261028/apps/desktop/src/renderer/components/chat/userMessageDisplayText.ts#L84-L98>) 对普通消息返回原 content，不会为错误的数组 shape 兜底。
5. 最新 [引用标记清理](<G:/Projects/Cindy-host-audit-20261028/packages/maker-shared/src/chatQuotes.ts#L54-L58>) 直接 content.split，不接受数组。
6. 最新 [手机队列校验](<G:/Projects/Cindy-host-audit-20261028/apps/mobile/src/session/inputProjection.ts#L367-L381>) 仅校验 chatMessage.role，不保证 content 类型；校验通过并不代表桌面消费安全。

使用 Host 两个真实构造器产出测试排队行，调用 Cindy 真实 stripChatQuoteMarkerLines，均复现 content.split is not a function，无需发送线上消息。该证据解释了现场症状，但部署后的真实发送/回执仍需复核。

## 更广的适配债务

针对最新稀疏源码运行现有通道审计，退出码 1：226 个可见通道，52 served、154 已分类拒绝、20 未分类。这里 desktop call-site 扫描只有此次检出的 5 个文件，不能视为全桌面覆盖；allowlist 字面量与手机 transport 已读。

未分类项包括：ghosts:composer-list、maker:agent-task:stop、maker:background-task:output-tail、maker:session-background-activity、maker:session-background-tasks:stop、maker:session:prewarm、maker:side-chat:list:v1、maker:side-chat:v1、maker:images:retry、maker:turn-change-set:apply、maker:input:cancel-usage-limit-wait、maker:review:start、maker:mcp-apps:v1、maker:provider-share:received-catalogs、maker:get-context-window-bounds、maker:set-context-window-budget、local-db:project-aliases:list、local-db:task-tags:execute、agent-island:completion-action、maker:session:handoff。

这些项不是 20 个已证实崩溃原因，也不应一律实现或假装成功。需逐项核对能力声明、拒绝后的客户端回退，再决定支持/明确拒绝。手机 push 审计因未检出对应接收文件而跳过；7 个可能耗时操作没有手机侧超时覆盖，属于独立兼容风险。

## 本轮最小修复和验证边界

优先只把两个队列 UI chatMessage.content 改为已经计算出的字符串 text/value，不改模型输入、原始队列内容、clientId、派发时序或生产安装目录。历史 SDK 正文与 persistedContent 的结构化附件保真不在这两个字段的修复中重构。

已修复并验证：[两个 UI 正文字段](<../src/host-input-queue.js#L96-L99>) 与 [回归测试](<../test/host-input-queue.test.js#L15-L42>)。

- 新增回归修复前 2 项失败，修复后通过，覆盖接受回包、队列基线/steering/重入及空正文。
- 队列/顺序相关测试 49/49 通过；最终基线用例调整后重跑 16/16 通过。
- pinned 最新 Cindy 真实 stripChatQuoteMarkerLines 前后对照：修复前两个构造器均抛 split TypeError；修复后普通文本、中文多行、空正文共 6 例通过。运行时只有上游 package 的 MODULE_TYPELESS_PACKAGE_JSON 提示，未为压制提示修改上游包清单。
- 完整 Host 测试 710 项：709 通过、1 跳过、0 失败；[测试日志](<../artifacts/cindy-compatibility-tests-20261028.log>)。改动 diff 格式检查通过。
- 最新通道审计仍退出 1（20 项未分类），不改审计分类来伪造兼容通过。它与本次源码修复的测试结果分别报告。

未升级/重启任何应用，未替换安装版 0.1.25；不声称手机真机或现场发送/恢复已验收。后续宜基于线上同版本分支移植这些修复，再安排一次真实桌面与手机发送、队列等待、出队和重入验收。

## 第二轮：手机后续发送持续转圈（Host 单侧修复）

### 硬边界

用户明确所有修复仅在我们的 Host。Cindy 桌面/手机源码仅只读对照，不改源代码、不重编、不要求安装特制客户端。下述变更仅在本 Host 的实现、测试和说明中。

### 已复现的问题

这不是上文桌面的数组 split 错误本身，而是同一条 Host→客户端契约链中的状态时序错误：

1. DSH 已消费消息，插件从正式 user/message 的 rpcId 调用 Host retireQueuedItem；此时发送请求尚未返回。
2. 旧实现只移除当时已存在的队列行，不记住“已经消费”。事件早于合成队列行时，这次 remove 是空操作。
3. enqueue ACK 随后看到会话在运行、inbox 没有该行，又合成 pendingQueue；steer 路径则重加 steeringQueueClientIds 并推送。
4. 最新 [手机待发送模型](<G:/Projects/Cindy-host-audit-20261028/apps/mobile/src/session/pendingSendItems.ts#L439-L451>) 对 steering/sending/settling 显示转圈。[发送回执处理](<G:/Projects/Cindy-host-audit-20261028/apps/mobile/app/sessions/[sessionId].tsx#L7198-L7239>) 在请求完成后仍依赖权威队列、正式历史和 settling 状态收敛；一个旧状态可以使已消费消息重新变成待发送。

使用真实 Host startHost、FakeSocket、真实路由、订阅及队列投影，分别复现 enqueue ACK 的假排队及 steer 推送的假插话状态；修前两例均失败，修后均通过。未直接修改或运行手机应用。

验证结果：本轮 tracker/runtime 针对性测试 63/63 通过；队列/命令/消费顺序测试 49/49 通过。新增凭据边界测试覆盖旧 baseline/queue/inbox、晚 ACK、真实等待项不被隐藏、跨会话 clientId 隔离、取消不冒充消费、2048 条容量及 clear 生命周期。完整测试共 715 项，714 通过、1 跳过、0 失败（[本轮日志](<../artifacts/mobile-host-receipt-tests-20261028.log>)），diff 检查通过，独立上游检出 git status 干净。

### 实施

- [队列 tracker](<../src/host-input-queue.js>) 增加按 sessionId/clientId 隔离的已消费凭据，上限 2048 条最近记录；不保存消息正文，不把它当成第二份持久队列。
- [Host retirement](<../src/host.js>) 在正式消息事件路径记录凭据，而不仅是删除队列当前行。
- 合成 markQueued/markSteering、旧 baseline/queue/adopt、显式 inbox 投影及 pending ACK 全部尊重已消费凭据。
- 取消/界面删除不冒充消费，普通未消费消息不被隐藏；凭据在 runtime teardown/断连 clear 时清除，超容量淘汰最旧记录。它是有界竞态保护，不是跨重启永久去重账本。
- 没有改变发送 primitive、请求 clientId 或任何客户端代码；模型输入保持原样。

### 证据边界与后续现场验收

当前在线 Host 的累计完成请求诊断没有捕获本次手机 enqueue，Android 设备快照为 offline，也没有用户给出的精确失败时间/clientId。因此只能说修复了可在 Host 侧复现、与症状相符的状态缺陷，不能认定它是现场唯一原因。尤其现有 invokeTotals 在 handler 完成后才计数，“没有完成记录”也不能证明“请求根本没到 Host”。

不能把旧鸿蒙后台恢复问题直接套到本次，也不能把“Host 发出了 push”当成“手机解析并确认了它”。本轮不以重启客户端绕过来冒充修复。

部署时应基于线上 0.1.25 对应代码移植，随后记录连续两条普通发送、运行中插话、排队后出队、退出会话重入的 clientId 与队列/历史收敛。若仍转圈，再在 Host 侧对照请求到达、接受回执及正式消费证据，不改 Cindy 客户端。

