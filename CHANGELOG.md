# 变更记录

本文件记录**用户可见**的变化与**每次发布验证过的 DSH 版本**。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [0.1.15] - 2026-09-30

验证环境：DSH **0.2.0-rc.2**（桌面版 `@deepseek-ai/dsh-desktop-runtime`，Electron 44 / Node 24.18.1）
**与** DSH **0.1.5-rc.2**（Web profile）—— 同一份产物同时服务两条线。要求 Node >=22，werift 固定 **0.24.4**。

### Added

- 支持 DSH **0.2** 宿主：`@deepseek-ai/dsh-session` / `dsh-settings` 的 peer 区间加入
  `>=0.2.0-rc.1 <0.3.0-0`。`^0.1.5-rc.2` 匹配不到 `0.2.0-rc.2`（semver 预发布规则），
  缺这一段会在**安装时**被拒（`installation rejected`）、在**启动时**被静默跳过。

### Fixed

- **设置 seam 在 0.2 上不再抛错**。0.2 删掉了 `settings.register`，插件原本会在 mount 时
  抛 `settings.register is not a function`；DSH 把加载失败的 entry 当致命错误，于是**整个
  profile 起不来**。现在按宿主能力选路径：有 `register` 走 0.1.x 的命名空间注册（行为不变），
  没有则用**插件条目自己的 `Config`** —— 0.2 的 `SettingsForms` 按 **profile entry id** 投影它，
  并把解析结果作为 `apply(ctx, config)` 的第二个参数。`SETTINGS_NAMESPACE` 正好就是本 bundle
  的行 id（`dsh-cindy-host`），所以两条路径操作的是同一个面，下游代码无需分支。
- **`@deepseek-ai/dsh-host-apiproxy` 从 `peerDependencies` 移除**。0.2 已删除该包，而
  `evaluatePluginCompatibility` 遍历 peers 的**每一个键、且不查 `peerDependenciesMeta`**，
  所以只要它还在 peers 里，安装与启动两道门禁都会拒绝整个插件（bundle 被跳过后
  `dsh-cindy-host` 行根本不会出现）。该适配器仍是惰性 `require` + 失败降级，运行时行为不变。
- **`.volatile()` 改为特性检测**。只有 0.2 的 schemastery `3.18.4` 有这个方法；`0.1.5-rc.2`
  解析到的 `3.18.2` 没有（仍在声明的 `^3.18.1` 区间内）。无条件调用会在**模块加载**时抛错，
  把 profile 一起拖垮；没有它时纯 schema 仍服务于 0.1.x 的 `register` 路径。
- **`keytar` 移入 `optionalDependencies`**。它是原生模块，没有 C++ 工具链的机器上必然构建失败，
  而普通 dependency 的构建失败会让 pnpm 退出 1（见下面"部署注意"的后果）。

### 部署注意（**必须看**）

pnpm 11 把 `strictDepBuilds` 默认设为 **true**，于是"构建脚本被忽略"从警告变成**硬错误**：
`add` 退出码 1。而 DSH 只在 pnpm 成功时才把 bundle 写进 `dsh.profile.bundles` —— 结果是
**包装上了、行却永远不出现**（这正是历史上要手写 insert 行的原因）。

在没有 C++ 工具链的机器上，安装前请在 profile 的 `pnpm-workspace.yaml` 里**显式承认**这一条：

```yaml
allowBuilds:
  keytar: false
```

这样 `add` 退出 0、bundle 正常登记，插件在没有 keytar 二进制时照常 mount，只是凭据能力不可用。
`strictDepBuilds: false` 也能让安装通过（实测），但它会**全局**关掉这道保护，不建议。

### 发布验证

- 单元测试：**682 通过 / 1 跳过 / 0 失败**（`node --test`）。
- peer 门禁：用宿主自带 semver 复现 `evaluatePluginCompatibility` → **compatible**，无需版本豁免。
- 干净 profile 真机启动（独立 `DSH_HOME`，宿主 `0.2.0-rc.2`，profile 里只装本 tarball）：
  `add exit=0`、`profile-local @deepseek-ai = 0`、`rows disabled 0 / bundles skipped 0 / pending 0`、
  `GET /` → 200 且含 `__DSH_BOOT__`、**`GET /api/dsh-cindy-host/status` → 200
  `{"ok":true,"installed":true,…,"diagnostics":{"dataSource":"session-controller",…}}`**、
  未知 Cindy 路由 → 404（证明路由表确已挂载，而不是被鉴权层统一挡掉）。
- **keytar 未构建时仍能 mount**：本机无 VS Build Tools，`keytar@7.9.0` 未编译，插件照常挂载并
  服务上述路由（`login.authenticated:false` 属预期：沙盒无 Cindy 会话）。§5.2 的说法这次是
  在 0.2 上**实测**的，不是沿用旧结论。
- **0.1.5-rc.2 侧同产物复验**（独立 `DSH_HOME`、0.1.5 CLI 起独立实例）：`add exit=0`
  （该运行时的 pnpm 是 10.33.2）、`profile-local @deepseek-ai = 0`、`GET /` 200 且含 boot manifest、
  **`GET /api/dsh-cindy-host/status` → 200 `ok:true installed:true`**、stderr 干净。
  即这次的双代 seam 不是"只在 0.2 上验过"，两条线各跑了一次真机。

## [0.1.13] - 2026-09-23

验证环境：DSH **0.1.5-rc.2**、Node **24.12.0**；要求 Node >=22，werift 固定 **0.24.4**。

### Changed

- Cindy 任务图标的未知来源/模型默认值由 Pi 改为 Claude；Pi 现在只用于明确识别为 DeepSeek 的来源（即使该来源的模型名未知）。旧会话在重新拉取列表时也按当前来源重新映射。

### 部署注意

- 当前 Web profile 如仍安装旧版（实查曾为 `0.1.10`），单独重启不会自动升级；先安装本版再按预警重启。重启后的短暂凭证恢复/中继重连不能当作 running 通道失败。

## [0.1.12] - 2026-09-23

验证环境：DSH **0.1.5-rc.2**、Node **24.12.0**；要求 Node >=22，keytar 需要原生构建，werift 固定 **0.24.4**。

### Changed

- Cindy 手机任务的三种 agent 图标在 DSH Host 上按会话实际来源和模型展示：DeepSeek 来源（任意模型）→ Pi、GPT 模型 → Codex、其他已知来源模型 → Claude。来源无法确认时回退 Pi；创建时手机所选 agent 平台不决定 DSH 的执行 harness。
- 三种 Cindy agentKind 均为同一 DSH harness 的协议别名，能力列表和模型/权限入口一致。手机的 agent 标签、搜索分类与最近会话草稿也会随图标的 kind 变化，属于本方案已接受的表现。

### 发布验证与限制

- 完整 Host 单测 680 通过、1 跳过；通道审计 `unclassified: 0`；独立沙盒普通验收 79/79、带真实 prompt 的沙盒验收 103/103。手机实际图标表现及文件直传仍需发布后真机复核，不能将沙盒验收视作真机验证。
- 本版本包含当前工作区其他已验证的文件传输、队列与登录修订；传输的真实手机 P2P 连接尚未确认建立，不宣称已修复。仅发布 npm 包不会让运行中的 DSH Host 加载新代码，需另行通知并重启。

## [0.1.11] - 2026-09-21

验证环境：DSH **0.1.5-rc.2**、Node **24.12.0**；要求 Node >=22，原生凭据依赖 keytar，werift 保持 **0.24.4**。

### Fixed

- 手机原 Export 的 OSS 兜底从 512 MiB 提升为 **2 GiB（含边界）**，遵守调用方更小的 maxBytes；采用64 KiB分块读取、SHA-256与网络背压，不再整文件读入内存。
- 持续有进展的上传不再被原10分钟总时限截断；保留阶段与无进展超时、两个活动槽和取消/清理配额。签名401仅受控刷新一次，文件PUT不自动重传。
- Export任务绑定已认证账号和请求设备；撤销、关闭及账号切换阻止迟到结果发布，短暂Relay断线不取消在途OSS上传。显式成功登录/选择账号可替换旧连接，上传与刷新不主动重连。
- 保留25秒peer offer等待预算；在既有status诊断中增加有界、脱敏的传输阶段信息。

### 验证与已知限制

- 已实测本地HTTP完整2 GiB、约11分钟持续流式上传及取消；真实约1.3 GB文件经OSS上传完成，用户确认手机下载完成。
- **本次成功走的是OSS，不是P2P。实际手机P2P未建立的原因仍待后续定位**；不宣称直连、TURN或系统分享问题已修复。
- 手机原30分钟总轮询预算未改；不新增断点续传、手机上传或超过2 GiB支持。OS文件/凭据库阻塞不保证按网络超时收口。

## [0.1.10] - 2026-09-20

验证环境：DSH **0.1.5-rc.2**、Node **24.12.0**、werift **0.24.4**；要求 Node >=22。

### Added

- **手机文件直传**：对接 Cindy `device-link:file-peer` / `files-v1`，电脑到手机按块下载，上限 2 GiB；需要支持该协议的客户端。固定 werift 0.24.4，处理空文件 EOF、连接复用、授权撤销和资源清理；保留 512 MiB OSS 导出兜底。
- 真实 Chromium + Cindy 接收器验证空文件、1B、16KiB、256KiB、跨批次及连续两次 32MiB+37B 文件，落盘 SHA-256 一致。

### Fixed

- **手机显示已插入而 DSH 仍排队**：不再把未消费输入混进正式历史；普通排队和等待插话均保留完整待发送内容，真正回流后才变为正式消息，重新进入会话仍可看到等待中的正文。
- **任务标题退化为 Untitled DSH task**：缓存到期仅触发刷新，不清空已知标题；暂时读取失败、批次缺项或空白标题保留最后有效值。过滤从未输入过内容的空白会话。
- 通道审计明确分类当前不支持的远端模型收藏与下一条输入预测，不再把它们当成未决通道；未新增这两项能力。

### 限制

- 手机真机、前后台行为、跨 NAT 和公网 TURN UDP/TCP/TLS、完整 2 GiB 文件尚未实测。
- 不新增手机上传、持久断点续传或嵌套 SSH 文件导出；直传失败时大于 512 MiB 的文件不能由旧 OSS 导出接管。详见 [文件直传说明](doc/file-transfer.md)。
- 发布/更新安装包不等于运行进程生效；安装后仍需手动重启原 DSH Web。

## [0.1.8] - 2026-09-18

### Fixed

- **Host 忙的时候手机把 Host 判成「设备离线」** —— 线上实测(19:08–19:15):七分钟里 18 次
  `local-db:sessions:list` 以 `TimeoutError` 被中止,而手机把一次失败的列表读渲染成"设备离线"
  (当时本机正在打包,CPU 被占满)。中止发生在 **invoke 层**(列表读 + 标题折叠 + 拼行一起超预算),
  所以数据源里那道陈旧兜底看不到它。`local-db:sessions:list` 同时是手机的**响应性探针**,现在它
  不再等读:有过一次成功读取后按缓存应答(5 秒内零读取),超过 5 秒则"先给旧页、后台刷新"
  (stale-while-revalidate);写路径(归档/删除/置顶/重命名、新建会话)会作废缓存 ——
  `patch-meta` 的回包就是控制器要落库的那一行,回旧行等于叫它撤销用户的编辑。

## [0.1.7] - 2026-09-18

### Added

- **手机自报的诊断单列一条时间线**(`diagnostics.phoneDiagnostics`)。控制器没有落盘日志:它靠
  invoke 一个未知通道、把读数编进**通道名**来自报(`psdiag.*` 来自 device-link 的对端静默判据,
  `tdiag.*` 来自移动端的计时器存活守卫)。这些自报原本落在会被普通轮询数秒冲掉的拒绝环里,
  两分钟前发生的停摆在有人去看时已经读不到。现在它们有独立容量(40),每条带**到达时刻**与来源设备。

## [0.1.6] - 2026-09-18

### Fixed

- **手机端「导出/下载」安装包时秒失败**(实测不到 5 秒),而 Host 侧显示导出成功 —— 失败卡在最后一跳。
  账号暂存区在阿里云 OSS 的**公网裸域名**,阿里云禁止该端点分发安装包:**key 后缀为 `.apk`/`.ipa`**,
  或**对象 Content-Type 恰为 `application/vnd.android.package-archive`**,GET 一律
  `400 ApkDownloadForbidden`(上传 PUT 与 `presign-get` 都成功,所以两边各自看着都对)。
  现在 staging 会把这类对象按**不透明字节**发出(`ext → bin`、`Content-Type →
  application/octet-stream`)—— 两个触发条件都要中性化,只改后缀仍会被拒(实测)。文件字节不动,
  用户看到的文件名也不变:手机按浏览到的文件名自己命名、分享用的 mime 也取自文件名。
  实测 77.2MB 安装包往返 sha256 一致。判因线索也补齐了:`download-failed` 现在带上对象存储的
  错误码(如 `download-failed: ApkDownloadForbidden`)。证据与矩阵见
  [`doc/cindy-android-verify.md`](doc/cindy-android-verify.md) 第九节。

## [0.1.5] - 2026-09-18

### Fixed

- **手机端「导出/下载本机文件」对大文件直接失败** —— 手机点文件时先要 `exportFileStart`，Host 把文件
  交给账号的暂存区（OSS），手机再自己 presign 下载；但 `resolveInsideWorkdir` 复用了
  `device-link:media:fetch` 的 **25MB** 上限，一个 77MB 的安装包被判 `OVERSIZE`，App 只好退回预览
  （1MB 上限），用户看到「超出大小」（线上实测 `file-browser:remote-op / OVERSIZE` ×4）。
  导出现在有独立额度与时限:**512MB / 10 分钟**（媒体取件仍保持 25MB / 30 秒）。导出会把文件整体读进
  内存，注释里写明了这一点；新增测试覆盖「26MB 的文件必须能开始并完成导出」。

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
