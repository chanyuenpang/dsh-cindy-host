# Cindy 上游同步与协议增量审查（2026-11-04）

## 结论

**需要跟进，但没有发现必须重写现有消息收发链路的证据。** 优先修复通道审计的未分类项与漏扫，再补不支持跨账号 scope 的显式拒绝边界；模型目录、机器状态和用量组件按产品需求安排。这里只完成同步和评估，没有实现这些建议。

## 同步结果与审查基线

- 官方远端：`https://github.com/makecindy/cindy.git`，默认分支 `main`。
- 原本地 HEAD：`dc294b02cadf2339da10c07df8d7c005bcad3dc0`，开发分支有 13 个已跟踪未提交文件。用户明确要求“不需要备份，对齐最新远端”，已据此覆盖这些修改并切换到 main；没有清理未跟踪本地资料。
- 首次同步：`4f2d83c7979ca57f124e330a4caacdb227685281`。中断恢复后重新 fetch，发现上游又前进 9 个提交，已安全快进。
- **最终 HEAD = origin/main = `ac785430449042f120a296b881a25ae52333f1e1`**，提交时间 2026-11-03 23:50:51 +08:00；标题为 `Merge pull request #8630 from makecindy/dash/mobile-swiftui-host-containment`。这是本次最终 fetch 的快照，不保证远端此后不再变化。
- Cindy 已跟踪工作区与暂存区无差异；仅保留原有未跟踪的本地工作流目录。没有安装依赖、构建或启动 Cindy。LFS smudge 已跳过，因此不把源码对齐表述为构建资源齐备。
- Host 工作区已有认证、思考流、九组原生能力等修改，本轮未覆盖、提交、发布或重载它们。
- 两层比较：原本地 dc294b0 → 最新版，识别旧本地视图遗漏；另用我们已有[固定回归基线](<G:/Projects/DSH-cindy-host/fixtures/cindy-source/README.md#L3-L7>) `1dba6f01eee35d5b2ead174f00c7524079c81383`（2026-10-28）→ 最新版，识别真正新增内容。不能把九组已经实现的子集重新计作缺口，参见[当前适配范围](<G:/Projects/DSH-cindy-host/doc/native-capability-adaptation-20261103.md#L9-L21>)。

## 1. P1：先跟进审计工具，不把“分类覆盖”当作兼容认证

对最终 Cindy 快照运行当前 Host 审计：

```text
node tools/channel-audit.mjs --cindy G:/Projects/Cindy
扫描词表 234：served 72 / declined 160 / unclassified 2
退出码 1
未分类：device-link:usage-widget:snapshot:v1
未分类：maker:model-catalog:read
推送扫描：Host sends 12 / unclassified 0
```

这是确实需要处理的审计失败，不是手机端故障的实测证明。还发现两个盲点：

- [审计解析器](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L241-L261>)仅解析字面量及当前文件内的 DL 常量，不解析导入的通道常量；因此漏掉新版[机器状态入口](<G:/Projects/Cindy/packages/device-link/src/machineStatus.ts#L1-L6>) `maker:machine:status`。234 不是官方完整协议总数。
- [手机/桌面调用扫描](<G:/Projects/DSH-cindy-host/tools/channel-audit.mjs#L197-L222>)只匹配特定字面量写法。报告中两个新入口显示 0 call sites，不代表无人使用：[手机组件实际调用](<G:/Projects/Cindy/apps/mobile/src/widgets/usageWidgetSync.ts#L108-L123>)和[模型目录实际调用](<G:/Projects/Cindy/apps/desktop/src/renderer/hooks/useControlledModelLocations.ts#L46-L53>)均存在。新版[目录变更推送](<G:/Projects/Cindy/packages/device-link/src/allowlist.ts#L780-L784>)也不能由当前“手机推送未分类 0”推导为覆盖完整。

建议：补导入常量、双引号/泛型调用和独立消费模块的覆盖；对新增入口明确支持或拒绝并记录理由。不能只加宽泛拒绝规则，让审计变绿后宣称全面兼容。

## 2. P1：跨账号 scope 的防御性边界需要明确

新版信封允许 `sharedTask`、`providerShare`，见[官方信封定义](<G:/Projects/Cindy/packages/device-link-protocol/src/protocol.ts#L50-L64>)。它们不是同账号设备的等价标识；官方[scope 解码](<G:/Projects/Cindy/packages/device-link/src/providerShareEnvelope.ts#L31-L63>)要求严格解析，不能失败后退回普通设备权限。

Host 的[授权说明](<G:/Projects/DSH-cindy-host/src/authorization-policy.js#L8-L13>)仍假定 relay 只会路由同账号；[实际授权判定](<G:/Projects/DSH-cindy-host/src/authorization-policy.js#L43-L45>)只有启用与设备撤销检查，[link-open](<G:/Projects/DSH-cindy-host/src/host.js#L2245-L2251>)与 invoke 分支没有显式 scope 拒绝。

**这是应加固的边界，不是已证实的线上越权。** [官方 hello 契约](<G:/Projects/Cindy/packages/device-link-protocol/src/protocol.ts#L110-L116>)要求共享任务双端声明能力，而 Host 当前[握手](<G:/Projects/DSH-cindy-host/src/host.js#L2359-L2374>)没有声明这些能力；未读取独立 relay 服务端实现，也没有测试真实跨账号请求是否能到达。

建议保持“只支持同账号”范围，在入站任何关联、订阅、读取、投递或副作用之前，显式拒绝带不支持 scope 的信封（包括畸形和双 scope），并补无副作用回归；不要为了跟版本直接开启共享任务/供应商分享。该变化相对旧本地 dc294b0 很重要，但不是全部首次出现在 10 月 28 日之后。

## 3. P2：模型目录新入口有价值，但旧 Host 有回退

新增 `maker:model-catalog:read` / `maker:model-catalog:changed`，用于从任务所在电脑的视角发现模型来源，而不是借用控制端的授权目录，见[契约](<G:/Projects/Cindy/apps/desktop/src/shared/controlledModelCatalog.ts#L1-L18>)和[官方 reader](<G:/Projects/Cindy/apps/desktop/src/main/maker-ipc/controlledModelCatalog.ts#L14-L78>)。

当前 Host 不支持新入口，但新版[消费端明确保留旧 Host 直读回退](<G:/Projects/Cindy/apps/desktop/src/renderer/hooks/useControlledModelLocations.ts#L81-L90>)；不能据此断言现有模型选择全部失效。建议如需跟进，只公开真实本机 DSH 模型目录与严格只读操作；不虚构跨设备/分享来源，不把它实现成任意 IPC 转发。变更推送须与真实目录失效来源配套。

## 4. P2/P3：可选产品能力，不应伪造成功

| 增量 | 当前影响与建议 |
|---|---|
| `maker:machine:status` | [官方契约](<G:/Projects/Cindy/packages/device-link/src/machineStatus.ts#L1-L28>)为只读 CPU/内存/磁盘/电源/运行任务快照；旧端会显示需要更新。可按需求适配，未知字段为 null，不用伪造的零值冒充空闲。先修审计漏扫。|
| `device-link:usage-widget:snapshot:v1` | [手机消费](<G:/Projects/Cindy/apps/mobile/src/widgets/usageWidgetSync.ts#L140-L147>)遇 CHANNEL_NOT_ALLOWED 可能提示更新电脑；不影响普通聊天。DSH 统计不等于各厂商账户额度，不能伪造完整快照。官方[兼容说明](<G:/Projects/Cindy/docs/dev-rules/protocol-compatibility.md#L61-L73>)将此入口标为尚未发布，源码存在不代表用户已装的手机版本启用。|
| `git-context:pr-refs:manage`、`git-context:github-read` | 新 Git 产品能力，现按 Git 通道族拒绝；没有已验证的 Host 等价接口，不强行接入。|
| `maker:project-automation:pending-imports` | [官方导入授权变化](<G:/Projects/Cindy/docs/dev-rules/protocol-compatibility.md#L51-L59>)涉及 approvedHash 与预览确认，不是提醒 CRUD；Host 仍拒绝完整自动任务族。|
| `maker:usage:kimi-coding` | 厂商额度读取，仍在明确拒绝的 usage 范围，不回退成控制端本地账户数据。|
| `local-db:bots:dm-thread:list/ensure` | Cindy Bot 主题会话能力，不等于 DSH 普通会话/子代理；维持拒绝。|

相对 1dba6f0 的 allowlist 增量共 9 个 invoke 和 1 个 push；其中机器状态是导入常量，不在现有审计新增未分类数内。

## 5. 暂不需要改动现有适配的部分

- **核心协议没有升版**：[PROTOCOL_VERSION 仍为 1、单帧上限仍为 2 MiB](<G:/Projects/Cindy/packages/device-link-protocol/src/protocol.ts#L19-L29>)。相对 1dba6f0，基础信封定义、输入投递契约、invoke 超时策略、auth-client 和端点配置无文件差异；这不是整个 DeviceLink 包完全没变化。
- **历史详情引用瘦身可兼容**：手机类型从完整摘要改用[HistoryWorkReference](<G:/Projects/Cindy/packages/maker-shared/src/historyView.ts#L59-L91>)；Host [details](<G:/Projects/DSH-cindy-host/src/host-history-view.js#L345-L367>)只依赖消息范围端点，[intent](<G:/Projects/DSH-cindy-host/src/host-history-view.js#L392-L408>)依赖 key，未要求额外摘要统计。实时工作行/增量 patch 仍属于可选增强，不能直接开启未实现能力。
- **压缩与内容标签是可选优化**：[官方传输契约](<G:/Projects/Cindy/packages/device-link/src/invokeTransfer.ts#L4-L14>)明确允许旧 Host 忽略 transfer 并返回普通结果；无须为基础互通立即实现 gzip/缓存。
- **定时任务新增运行位置能力位**缺省 false；Host 不应声明支持，且[现有输入白名单](<G:/Projects/DSH-cindy-host/src/dsh-reminders.js#L9-L19>)会拒绝未知或不能表达的模型覆盖，不静默接收。
- **rewind 新 requireLatestUser 参数**不改变当前拒绝原地 rewind 的边界；普通 fork 不能冒充 rewind。
- 恢复后额外 9 个提交主要修改直连容量、排队、忙碌保活和匿名诊断；[directCapacity](<G:/Projects/Cindy/packages/device-link/src/directCapacity.ts#L1-L15>)明确是本地资源策略而非 wire 限制。Host 未协商通用直连能力，不必照搬；已有 files-v1 文件 DataChannel 也不是这套通用直连的自然等价实现。

## 验证与后续顺序

已对最终快照重新执行只读审计，结果如上；Host 定向回归 **50 passed / 0 failed**：

```powershell
node --test test/host-history-view.test.js test/native-capability-lifecycle.test.js test/host-input-delivery.test.js test/dsh-reminders.test.js
```

这些测试只验证现有 Host 模块和模拟生命周期，不是最新版 Cindy 真机兼容认证。没有运行 Cindy 测试、复制执行其源码、全量 Host 回归、真实手机弱网测试、跨账号测试、发布或重载。

建议下一轮顺序：**审计准确性与明确拒绝分类 → 不支持 scope 的拒绝边界 → 视需要接本机模型目录/机器状态 → 其他产品功能**。源代码完成、生产部署和手机实测必须分别确认。

## 0.1.33 发布准备时的审计跟进

发布前再次执行发现上述两项未分类确实阻断门禁。本轮仅修改维护工具和 Host 测试：静态读取相对导入的标量通道常量（不执行上游代码），补泛型/双引号与独立手机消费模块的调用扫描；将不能证明是远程调用的本地 IPC 字面量单列，不混为 wire 通道。新增入口按真实 `CHANNEL_NOT_ALLOWED` 回归逐一登记拒绝原因，没有开启模型目录、机器状态、usage widget、云交接、任务迁移或供应商分享。

该 Cindy 快照下的更新结果为 **249 个枚举项：73 served / 176 declined / 0 unclassified**，调用位置 **229**。旧版扫描漏掉的 file-peer 现能由导入常量识别；计数增长不代表新增实现。审计仍是有界静态发现，不是完整 TypeScript 求值、所有上游协议或手机兼容认证。跨账号 scope 的防御性边界与新产品能力仍未在此轮实现。
