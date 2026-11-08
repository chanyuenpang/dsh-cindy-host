# DSH 0.2.2-rc.1 兼容验证

日期：2026-11-08。最初检查的是基于 0.1.31、版本暂标 0.1.32 的本地原型；它不是 npm 上已发布的 0.1.32。发布准备时发现 npm 已到 0.1.40，因此正式候选改为基于 Git 标签 v0.1.40 的 0.1.41，保留全部已发布更新并重新验证。下文早期 0.1.32 结果仅属于该旧基线原型，不代表 0.1.41 的发布检查。目标是 npm `latest` / `next` 当时均指向的 `@deepseek-ai/dsh@0.2.2-rc.1`，不是所有未来 RC。

## 0.1.41 正式候选验证

在当前目录快进至已发布标签 v0.1.40 后，合入本次 fork 分类修正，并为 Agent/Session/Settings 精确 peers 增加 0.2.2-rc.1。保留 v0.1.40 的全部功能，包括无需 keytar 的系统凭据存储、来源标记、媒体、历史、中断和控制适配；旧原型的可选 keytar 依赖没有进入候选。

- Node 24.18.0，开发 DSH SDK 统一到 0.2.2-rc.1，Cordis 4.1.0 / Schemastery 3.19.0。
- `npm test`：1243 项，1235 通过、8 跳过、0 失败。
- 额外设置 `DSH_TEST_NATIVE_MODULES` 指向真实 RC SDK，运行 `test/user-question-native.test.js`：4/4 通过，覆盖双向先答、重连重放和原生取消。
- 实际候选 tarball 与独立 RC SDK 的 `dsh-compat-smoke.mjs`：7/7，含兼容门禁、Session 折叠、原生 Loader/作用域技能和插件挂载。
- `credential-store-native-smoke.mjs`：真实 Windows DPAPI、原生 DSH 密文持久化、全新上下文恢复、续期和注销全部通过，仅使用隔离临时文档及假凭据。
- 通道审计：165 项，65 served、100 declined、0 unclassified。本地 Cindy 源码不含 invokePolicy.ts，超时策略审计仍跳过。
- 使用独立 DSH_HOME，通过原生 `dsh plugin --profile release add <0.1.41.tgz>` 干净安装成功；自动加入 bundle 选择，没有链接源码或绕过安装版本门禁，也没有 keytar 构建步骤。
- 在独立 3094 端口冷启动，状态确认 0.1.41、session-controller 和空 handlerErrors；实际运行时 smoke 30/30 通过。

候选证据位于本地 `.sandbox/release-0.1.41/`。此前广泛验收脚本的 60/76 属于旧原型，未冒充候选或手机验收。此次发布验证不包含手机实连、真实 OAuth 或模型发送，也不改动或重启默认日常 profile。

## 契约与改动

- 对比 npm 发布的 0.2.1-rc.5 与 0.2.2-rc.1 的 Session、Session Query、Session Controller、Settings 类型及实现。Session Query 类型未变；插件使用的 controller 创建、列表、模型、队列、control 和 resolveAgent 接口仍在。插件不使用新版移除的 controller.inspect。
- 新版 SessionHeader 明确规定：历史普通 fork 也可能保留 `parentSession`，是否子代理应看 `origin: 'subagent'`。修正列表、活动会话与精确读取共用的过滤逻辑，保留父会话信息；子代理仍隐藏。
- 两个 DSH peers 增加精确的 `0.2.2-rc.1`，保留已接受的 0.2.1-rc.3/4/5。使用实际 `evaluatePluginCompatibility` 测试安装门禁，并拒绝未验证的 alpha、后续 RC、正式版与 0.3 版本。
- 锁文件统一使用 0.2.2-rc.1 的 DSH 开发载体、Cordis 4.1.0 与 Schemastery 3.19.0；DSH 包仍仅由宿主提供。非 DSH 依赖保持原版本。
- 插件仍要求 Node >=22.16。DSH 0.2.2 CLI 发布包自身声明 Node >=24.9；本轮机器为 Node 24.18.0，不将这个宿主要求误写为全部旧载体的插件要求。

## 已完成验证

1. `npm test`：927 项，924 通过、0 失败、3 跳过。包括 fork 可见性、子代理隐藏、精确读取释放 observation、安装门禁、持久输入交付与原有媒体回归。长时间/可选环境测试按现有条件跳过。
2. `npm run audit:channels -- --cindy <本机 Cindy 源码目录>`：165 个通道，53 served、112 declined、0 unclassified。该本地 Cindy 源码没有 `invokePolicy.ts`，超时策略审计跳过。默认脚本仍保留旧电脑路径，直接不带 `--cindy` 运行会找不到源码。
3. `npm pack` 后，将实际 tarball 挂到独立 `DSH_HOME` 的全新 Web profile，使用 npm 安装的 `@deepseek-ai/dsh@0.2.2-rc.1` 启动。未复制真实登录、设备身份或会话，也未重启真实宿主。
4. `HOST_SMOKE_BASE=<隔离地址> node tools/release-smoke.mjs`：30/30。确认插件版本、session-controller 数据源、无启动 handlerErrors、provider 列表与可选功能拒绝行为。
5. 隔离测试插件通过真实 Settings 服务读取 Host descriptor，写入测试 deviceName、读回并恢复；volatile 更新成功，transportEnabled 始终 false。
6. `node tools/acceptance.mjs --base <隔离地址>`：60/76。真实的创建会话、精确读取、空历史页、文件浏览、goal 创建/读取/更新/清除、归档/置顶/恢复、plan mode 和订阅等路径通过；没有发送真实 prompt。

## 未通过的广泛验收与边界

这次不是完整手机验收。16 个失败断言分别为：

- 账户或外部依赖：未连接中继；持久输入 projection、两项输入校验与队列广播缺少认证账户；图片缺少上传凭据；effort/model 缺少可用模型。
- 新 profile 无历史：旧页游标、work item 及两项 work-details 断言无素材；删除后列表断言依赖可发现的非空会话。
- 旧断言/原生约束：脚本仍期望 provider:list 被拒绝，而当前实现已支持；固定 permission mode 不在新 profile 公布的列表；goal 默认单轮预算耗尽后，原生 resume 正确拒绝，脚本没有先增加 maxGoalRounds。

上述失败保留在本地 `.sandbox/compat-0.2.2-rc.1/` 的日志中，没有通过改写断言制造全绿。没有验证真实手机、认证后模型发送、跨平台 Desktop 或生产升级；没有发布 npm 或部署到真实 DSH。

## 同日后续：本地默认 profile 安装

按用户要求，随后将 DSH `0.2.2-rc.1` 安装为全局 CLI，并将本地 `artifacts/dsh-cindy-host-0.1.32.tgz` 安装至 `%USERPROFILE%/.dsh/profiles/web`。操作前备份了原 profile 清单、锁文件、patch 与旧设置文件。本机 3080 当时没有运行实例；新启动默认 web profile，未重启已有 DSH。

- 本机 pnpm 11.15.1 首次以 `ERR_PNPM_IGNORED_BUILDS` 拒绝 keytar 构建，安装未成功启用 bundle。仅执行该 profile 的 `pnpm approve-builds keytar`，成功编译原生模块，再重试安装。
- 首次失败已留下 dependency，因此重试没有补上 bundle 选择。通过 DSH 导出的 `evaluatePluginCompatibility` 检查实际包兼容性，再使用 `writeProfileBundles` 将已安装包加入启用列表；没有设置版本豁免。运行中的 Web profile 热加载后，状态接口确认 `installed: true`、`pluginVersion: 0.1.32`、`dataSource: session-controller`、`handlerErrors: []`。
- 在实际本地 3080 实例执行 `release-smoke.mjs`：30/30 通过；从实际安装目录检查 `credentialStoreAvailable()` 为 true。证据保存在本地 `.sandbox/compat-0.2.2-rc.1/local-installed-smoke.log`。
- Cindy 通道处于 disconnected，没有更改开关来强行连接，也没有发送真实 prompt。手机实连仍未验收。
- 原 profile 的 `dsh-openai-codex-auth@0.3.2` 要求旧 0.1.1 SDK，被新版 DSH 明确跳过。其依赖和 bundle 选择仍保留；本轮没有升级、删除或豁免该登录插件，因此不声称该提供方可用。
- 本地安装不等于 npm 发布；0.1.32 仍是本地 tarball。

## 同日后续：修复用户终端启动

用户随后报告 `startup failed: 2 required plugins did not activate`。复现日志确认，直接原因是验证后台实例仍占用 3080：`webserver` 报 `EADDRINUSE`，必需的 `web-runtime` 等待 `webServer`。旧 auth 的版本告警是独立问题，不能仅凭相邻日志将其当成必需插件失败的原因。

确认自建验证实例没有活动会话后，仅结束该实例；备份 profile，再通过原生插件命令将 `dsh-openai-codex-auth` 从 0.3.2 更新至明确支持 DSH 0.2.2-rc.1 的 0.6.5，未设置版本豁免。默认 `web --no-open` 随后在 3080 冷启动成功，没有必需插件失败或旧 auth 兼容性告警；stderr 随后记录一条 DeepSeek 模型列表成功加载的信息。提供方列表包含 `openai-codex`，Cindy Host 0.1.32 的 30/30 runtime smoke 通过。没有测试真实 OAuth 或模型请求。

验证结束后关闭本次临时启动进程并确认 3080 不再响应，交还用户执行 `dsh web`。证据：本地 `.sandbox/compat-0.2.2-rc.1/duplicate-start.log`、`auth-upgrade.log`、`startup-fixed-smoke.log` 与 `startup-repair-verification.json`。

## 上游依据

- [DSH 0.2.2-rc.1 发布元数据](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.2-rc.1)
- [Session 0.2.2-rc.1 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-session/-/dsh-session-0.2.2-rc.1.tgz)：`lib/types/types.d.ts` 的 SessionHeader，以及 `lib/types/index.d.ts` 的 store announcement 规则。
- [Session Controller 0.2.2-rc.1 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-api-session-controller/-/dsh-api-session-controller-0.2.2-rc.1.tgz)
- [Settings 0.2.2-rc.1 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-settings/-/dsh-settings-0.2.2-rc.1.tgz)：读取 effectiveConfig，并适配 Cordis 4.1 fiber。
