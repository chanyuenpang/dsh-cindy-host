# 变更记录

本文件记录**用户可见**的变化与**每次发布验证过的 DSH 版本**。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.1.3] - 2026-09-17

### Fixed

- **手机又看不到自己发的照片了** —— 这是修过的回归，但**修复本身没有失效**：它只挂在一条读取路径上。
  图片水合（把行里的 `imageRef` 读成内联 `images[]`）当年只接在 `local-db:messages:list`（旧转录读取）；
  后来控制器改用 `local-db:messages:view`（历史视图，广告了 `history-view-v1`），而那条路从没接过水合
  —— 照片于是又变成"没有可展示的远程路径"的文件条目。线上实测：那一行确实带着 `imageRef` 被服务出去，
  而 `diagnostics.attachmentReads` 是 `{attempted:0, served:0, failed:0}`，即水合一次都没跑。
- **刚发完的那一刻同样看不到**：实时推送 `local-db:messages:created` 也从不水合，所以承载照片的那一帧
  到达时渲染不出图片，要等某次"刚好走水合路径"的重读才会出现。

现在**三条路（`messages:list` 页面、`messages:view` 页面、实时推送）共用同一个水合器**，因此
"live append 与 transcript read 产生同样的行"这句注释重新成立；水合失败只损失那一张图片，绝不损失消息。

### Tests

- 历史视图页面：带 `imageRef` 的行返回时必须带 `images[]`、`imageRef` 被剔除，**且不在页内的旧行一次读都不产生**；
  没有水合器时页面照常应答（退回文件 chip，不崩）。
- 实时推送：承载图片的那一帧里就有 base64；水合器抛错时消息照发（未水合）。

## [0.1.4] - 2026-09-18

验证于 **DSH `0.1.5-rc.2`**（Web profile，Windows）。

### Fixed

- **新建对话时选的模型被丢掉，首个 prompt 跑在默认模型上**：`maker:create-session` 只读 `id` /
  `workingDir`，把控制端**一起提交**的 `model` / `providerId` / `effort` 全丢了。新建页没有会话可以调
  `maker:set-model`（手机管线是 create → getSession → enqueue，`setModel` 在仓库里连一个生产调用点都没有），
  所以这套 runtime 只有这一条路能到达 Host。丢掉它 = 新会话没有任何会话级选择，DSH 的 `selectionFor`
  于是回落到 profile 的 `agent-default-model`（deepseek-flash），首个 prompt 就跑在它上面；而手机随后从
  权威会话行读到 `modelSelection.next ?? lastUsed` 也是 deepseek——用户看到的就是「新对话选了 gpt，
  一运行又变成 deepseek」。现在 create 会把这三个字段转给 seam，并在**创建成功后立刻落成会话级选择**
  （DSH 只允许这个顺序：选择必须属于某个会话）；`providerId` 缺省时按 `maker:set-model` 已有的口径从本
  Host 目录解析 provider，若整个目录里都没有能路由该模型的 provider，则回拒绝码 `NOT_AVAILABLE` 而不是
  回一个假的成功（会话此时已存在，控制端的 create 幂等且重试前会 probe `getSession`，所以老实的拒绝只花
  一次重试，而静默的错模型会毁掉一整段对话）。
- 同一条路径上 `maker:set-effort` 与 create 现在共用同一个 `applyModelSelection`，避免第二份 provider 解析；
  并把 DSH 自己的 `session/model-unavailable`（来源在挑选与创建之间掉线等）翻成 `NOT_AVAILABLE`——原样抛出去，
  控制器读到的 `THREW` 是「Host 崩了」，而不是「这个模型在这里不可用」。
- **同一个 create 还丢掉了权限档，这一处更危险**：手机的权限选项**就是**本 Host 广告的
  `capabilities.permissionModes`（DSH 预设表里的 `read-only` / `workspace-write` / `danger-full-access`），
  草稿里不在表内的值还会被手机的协调器改写成表内第一项。于是用户选 `read-only` 新建对话，会话照样跑 profile
  默认的 `danger-full-access`——**他以为被限制住了，实际是最高权限**。现在 create 会在建会话后用与
  `maker:set-permission-mode` 同一个写入（`installPermissionMode`）安装它，但**只安装本 Host 广告过的
  名字**：控制端自己的词表（`ask`/`auto`/`acceptEdits`/`bypassPermissions`…，只在能力读取失败时才发）
  既不翻译（等于替用户决定权限级别），也不拒绝（那会让那台手机建不出任何会话），而是保留 profile 档位、
  记一条 `ctx.logger` 告警，并由权威会话行如实回报。
- **会话行补上模型的来源**：`providerId` 与 `model`/`effort` 同在 `modelSelection` 投影里，本 Host 的行
  却从不带它，于是手机「跟随最近会话」推导出的是「有模型没来源」的下一个对话草稿。现在两个折叠点读同一个
  投影（`next ?? lastUsed`），没有选择过的会话则**不带这个字段**（缺失 = 走被控端默认路由，正是它实际跑的）。

### 文档与注释（无行为变化）

- 一次独立复核（更强模型对抗式核对）发现若干**与实现相反**的说法，已修正：presence 报离线
  **不会**删除设备订阅（它只决定一次推送算不算「已送达」）；运行工作组的「钉底」只作用于升序的
  `messages:view` 页，新到旧的 `local-db:messages:list` 不重排；`pulseRepair` 补的是输入投影与
  视图失效，turn 状态由 `markDeviceReachable` 补发。`src/host.js` 里 5 处描述旧行为的注释一并更正。
- 陈旧的数字断言更正：单测 446（README 原写 407）、通道 52 served / 140 declined
  （`doc/cindy-phone-link.md` 原写 48 / 144）；README 的「尚未配置远端」改为已推送到公开远端并发了
  `v0.1.1` Release；CHANGELOG 补上 `[0.1.1]` 链接、去掉并不存在的 `v0.1.0` 死链。

## [0.1.2] - 2026-09-17

**这是 0.1.1 那个附件的修复版。0.1.1 装进别人的 profile 会让那个 profile 起不来**，所以请不要再用
0.1.1 的 tarball 安装。本版**发布到 npm registry**（MIT）：`dsh plugin --profile <p> add
dsh-cindy-host-demo@0.1.2`。

### Fixed

- **不再把 DSH 自己的一代装进 profile**：`@deepseek-ai/dsh-session` / `@deepseek-ai/dsh-settings` 由
  `dependencies` 移到 `peerDependencies`，`@deepseek-ai/dsh-host-apiproxy` 改为 optional 的 peer
  （`optionalDependencies` **不是**"可以不装"——pnpm 默认会装它）。此前它会牵出
  `dsh-host-apiproxy@0.1.1-rc.2` 的 **28 个 `@deepseek-ai/*@^0.1.1-rc.2`**，整代装进 profile；
  宿主 `0.1.5-rc.2` 再去组合这个混合体就失败：`ctx.commands.registerFileReceiptResolver is not a
  function`（`dsh-client-file-upload`）、`@deepseek-ai/dsh-llm does not provide an export named
  'CallId'`（`dsh-session`）。
- **不再 import 只在旧代存在的导出**：`settingsNamespace` 只存在于
  `@deepseek-ai/dsh-settings@0.1.1-rc.2`；`0.1.5-rc.2` 的导出面是 `SettingsProvider` /
  `SettingsConflictError` / `redactSecrets` / `default`。它是"校验后原样返回字符串"的 brand，现已内联
  到 `src/dsh-plugin.js`。这就是此前必须把旧代声明成依赖的原因。

### 验收（干净安装，全新 `DSH_HOME` + `--from-default-profile web`）

```
dsh plugin add <0.1.2 tarball>   → exit 0
profile-local @deepseek-ai       → 0        （不再拖任何一代 DSH 进来）
dsh --profile <p> --dump-config  → exit 0，含 dsh-cindy-host 行
dsh web                          → 启动，监听端口
GET /api/dsh-cindy-host/status   → 200 installed=true
npm test                         → 446/446
```

### 文档

- `doc/publishing.md` §5.4 的结论**更正**：原先写"全新 profile 起不来是 DSH 侧的问题、与本包无关"，
  这是错的，根因正是本包把旧一代 DSH 装进了 profile。§5.6 新增依赖规则与写死的检查步骤。

## [0.1.1] - 2026-09-17

> **这个版本的附件有缺陷，不要用它安装**（见 0.1.2）。缺陷是"装进别人的 profile 会让它起不来"，
> 不是插件功能本身。

打包与安装修复：两者都只在**干净安装**（干净 DSH_HOME + tarball）下才会出现，本地 link 装法不会暴露。

### Fixed

- **插件不再因为可选依赖而装不上**：`@deepseek-ai/dsh-host-apiproxy`（只有老 DSH 的 `apiProxy`
  路径需要）由顶层静态 import 改为惰性加载，并移入 `optionalDependencies`。它在干净环境里会拖入不兼容的
  `@deepseek-ai/dsh-agent-presets`，原先会让插件加载失败、整个 profile 起不来；现在缺失或不兼容时降级为
  "该 seam 不提供服务"。
- **`keytar` 缺失不再致命**：pnpm 10 默认不执行依赖的构建脚本，干净安装下没有 `keytar.node`，原先顶层
  `import keytar` 会让插件加载失败。现在惰性加载：读凭据回"无会话"，写凭据抛
  `CREDENTIAL_STORE_UNAVAILABLE`，插件照常挂载。（装法见 `doc/publishing.md` §5.2。）

## [0.1.0] - 2026-09-17

首个发布版本。验证于 **DSH `0.1.5-rc.2`**（Web profile，Windows）。

> 这一版**没有打 tag、也没有分发**：它的干净安装缺陷（见上）由 `0.1.1` 修掉，实际发布并从
> `v0.1.1` 起算。所以这里没有 `[0.1.0]` 的链接可指——它没有对应的 release。

### Added

- **手机通道（52 个被服务，140 个显式拒绝）**：会话列表/详情、消息窗口与工作分组视图
  （`local-db:messages:view` / `work-details` / `view-intent`，广告 `history-view-v1` 能力）、
  输入队列（排队/插话/编辑/移动/删除/清空/停止）、审批与提问的往返、todo 计划卡、goal 读写、
  文件浏览与导出、图片取件（`thumbnail` 降采样 + 内联，逐级降级到 `ossKey`）。
- **设置卡片**：手机连接开关、控制器授权、设备状态与诊断面板（`/api/dsh-cindy-host/status`）。
- **诊断面（可观测而不是尽力而为）**：`invokeTotals` / `refusalTotals` / 带设备归属的
  `recentInvokes` / 带 watcher 数的 `recentPushes` / `handlerErrors`（`where` 带通道名）/
  `boundaries` 判决（`recovered` | `starting` | `silent`）/ `suppressedNotices`。

### 手机端实时性（本轮修复的现象）

- **不再长时间转圈**：中继报设备离线时不再删除订阅集（presence 只决定"是否计入已送达"）；
  设备再次开口时撤销该判定并重播回合终态。
- **进度可见**：会话回合状态的权威来源改为 DSH 自己的边界（`liveTurnState`），并显式接入视图控制器
  —— 此前正在跑的回合被标成"未在跑"，于是既没有实时卡片，也没有可锁定的工作项。
- **排序可预期**：待发送消息按**接受时间**归并进页面（按你打字的位置出现）；**正在运行的工作组锁定
  在页面最后**，你刚发的话永远在它上面。
- **插入（steer）不再丢话**：没有正在跑的回合时按普通消息发送；回合已走过可插入点时，被拒的 steer
  会**重试为普通消息**（原先会以 `current turn no longer accepts steering` 报错并吞掉内容）。
- **重订阅/开口即补帧**：`device-link:subscribe` 与任何点名了会话的入站帧，会补一次权威输入投影 +
  一次视图失效（每会话 30 秒最多一次），用于修复中继抖动造成的丢帧。

### 健壮性

- **不因一个未处理的 rejection 拖垮整个 `dsh web`**：队列提交改为真异步（原先未 await 的拒绝会让
  进程 `exit(1)`）；宿主面监听器统一走 `guarded()` 单入口，并有源码级不变量测试。
- **长会话不再永久失去视图**：移除 >20000 行即回 `UNSUPPORTED_CAPABILITY` 的拒绝（该码会让客户端
  永久降级，且当时的拒绝并未省下任何读取）。
- **列表读抗压**：并发读单飞；错过预算时用最近一次成功的列表兜底；冷启动无兜底时重试一次。
- **通知不再冒充用户消息**：harness 的后台任务通知（`source.kind === 'plugin'`）不再投影到手机，
  隐去条数在 `diagnostics.suppressedNotices` 可查。

### 已知限制

- **App 切后台回前台后入站失效**（鸿蒙 + 安卓兼容层）：官方客户端同样复现，判定为客户端/OS 侧，
  本 Host 不再为此投入；现场绕过是"等约 1 分钟，或退出会话再进"。详见
  `.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`。
- 真机 219 会话冷启动时，`local-db:sessions:list` 仍可能出现超时（已有上述三层保护）。
- 当前 DSH 不再挂 `apiProxy`；本插件在没有它时安全挂载，并在相关通道回 `NOT_AVAILABLE`。

[Unreleased]: https://github.com/chanyuenpang/dsh-cindy-host/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/chanyuenpang/dsh-cindy-host/releases/tag/v0.1.1
