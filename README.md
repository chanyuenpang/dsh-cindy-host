# DSH Cindy Host Demo

A DSH-to-Cindy host adapter. The console demo projects a DSH conversation list and safe lifecycle/status activity to a replaceable sink; the DSH bundle additionally carries the Cindy session, the DeviceLink relay, and the 「Cindy 手机连接」 settings card that lets the Cindy mobile client reach this Host.

## Quick Start（从 npm 安装）

需要 **Node.js 22 或更高版本**。下面将插件安装到默认 Web profile：

```bash
# 从 npm 安装当前发布版本
bunx @deepseek-ai/dsh plugin --profile web add dsh-cindy-host-demo

# pnpm 10 需要显式批准 keytar 的构建脚本
bunx @deepseek-ai/dsh plugin --profile web approve-builds
```

在批准列表中选择 `keytar`，然后**重启 DSH Web**。重启后可在 **设置 → Plugins** 找到「Cindy 手机连接」：使用手机号和验证码登录，再开启手机连接。

有关 `keytar` 的编译环境、失败降级与替代配置，请见[安装与原生模块说明](#安装与原生模块说明)。

## Console demo scope

- Conversation list: opaque session ID, title, phase, update time.
- Activity feed: added, removed, and status summaries only.
- Safe recovery: stream failure emits a generic stale marker and refreshes the list baseline.

The projection deliberately excludes message bodies, prompt input, tool calls/results, approval/question payloads, file paths/content, credentials, and command sending. The Cindy transport consumes only what the projection already produced.

## Run

Requires Node 22 or newer. There are no package dependencies for the fixture demo.

```sh
npm test
npm run demo
```

## Cindy login MVP

The Host can request a verification code and exchange it for a Cindy session. It never prints tokens; the host runtime stores a session in the operating-system credential store for refresh. It defaults to the China mainland Cindy auth endpoint (`https://auth.cindy.com.cn`):

```sh
npm run login
```

`CINDY_AUTH_BASE_URL` remains an optional override for an explicit non-mainland environment.

The command displays only the newly generated Host device handle on success, and persists the session so the settings card picks up the same login.

## Cindy phone link (Settings → Cindy 手机连接)

The bundle adds its own page, **设置 → Cindy 手机连接**, registered into the
shell's `settings.section` slot — a feature owning its settings page is the
documented seat for this, so no shell change was needed. Turning **连接手机** on
signs this Host in to Cindy, joins the DeviceLink relay, and makes the Host show
up in the Cindy mobile client's device list; turning it off closes the socket,
stops the projection, and forgets every device and subscriber.

The page shows the five states the Host can be in (未连接 / 登录中 / 等待手机连接 /
已连接 / 连接失败), collects the Cindy verification-code login when no session
exists yet, and lists the connected devices with their name and `deviceId`.

There is **no QR code**: Cindy has no pairing protocol, and its own "connect your
phone" QR is just the regional app-download page. The four protocol questions and
their source evidence are recorded in
[Cindy phone link](doc/cindy-phone-link.md), together with the design.

## 手机大文件下载（0.1.10 起）

原 Export 入口按 inline → peer → OSS 回退。**0.1.11 起 OSS 兜底也支持最多2 GiB（含边界）**，流式上传，不再受旧512 MiB上限限制；约1.3 GB真实文件已经OSS下载到手机。实际手机P2P连接问题仍待定位，本次不宣称直连已修复。需更新/重启Host后生效，不含手机上传或断点续传。验证于DSH 0.1.5-rc.2 / Node 24.12.0；Node要求≥22，keytar为原生依赖。详见[文件传输说明](doc/file-transfer.md)。

## 手机任务图标（0.1.12 起）

DSH Host 仍只有一种执行 harness；手机任务行把 Cindy 的三种 `agentKind` 用作模型图标别名：DeepSeek 来源任意模型显示 Pi，GPT 模型显示 Codex，其他来源已知模型显示 Claude；**0.1.13 起**无法确认来源的图标改为 Claude，Pi 只保留给确认是 DeepSeek 的来源（0.1.12 的未知来源仍显示 Pi）。手机新建时选择的 agent 平台不会更换 DSH harness，实际模型和来源仍以 DSH 会话选择为准；手机的 agent 筛选、标签和最近会话默认项也会跟随图标 kind。手机端无需更新，但 Host 安装新版后必须重启才生效。

## Safe isolated DSH smoke test

Do **not** add this package to the DSH profile you use every day. Use a disposable `DSH_HOME`; it gives the smoke profile its own bundles, settings, and credentials. These PowerShell commands run from this repository:

```powershell
# Every following dsh command in this terminal uses only this disposable home.
$env:DSH_HOME = Join-Path (Get-Location) '.sandbox/dsh-home'

# Create an isolated Web profile without starting a server, then add this local bundle.
dsh --profile cindy-smoke --from-default-profile web --dump-config
dsh plugin --profile cindy-smoke add .

# Gate 1: parse and compose the profile only. Do not continue if this fails.
dsh --profile cindy-smoke --dump-config

# Gate 2: start a separate UI without opening a browser or sharing port 3080.
# transportEnabled is false by default, so this cannot log in or connect to Cindy.
dsh --profile cindy-smoke --no-open --port 3081
```

Run `npm test` before Gate 1. A clean Gate 2 must show a running DSH host on port 3081 and no Cindy authentication prompt. Stop it with `Ctrl+C`; removing `.sandbox/dsh-home` removes the whole test profile and its credentials. Do not enable `transportEnabled` until the mount, RPC, and lifecycle smoke checks are clean.

**Never start port 3081 with `--profile web` and the normal `DSH_HOME`.** A second process then shares the production Host's DeviceLink identity; the relay may route a phone's `maker:input:enqueue` to the wrong process, where resuming a session owned by the 3080 process fails with `SessionAlreadyOwnedError` and appears as `[INTERNAL] DSH Host failed to serve this channel`. It can also make the phone's queue/sync status oscillate. Use only the isolated `cindy-smoke` profile above, and check both `/api/dsh-cindy-host/status` endpoints for duplicate `status.host.deviceId` before testing phone sends.

With Gate 2 running, two Host surfaces answer over loopback:

```
GET /api/dsh-cindy-host/status   # the card's only source of truth
```

The card itself is served as the `dsh-cindy-host-demo` entry of
`window.__DSH_BOOT__`; `npm test` renders it with React so its markup and state
rules are covered without a browser.

## DSH API compatibility boundary

`DshHostSource` has contract tests for the older public `InProcessApiClient(toFetchHandler(ctx.apiProxy))` adapter. Current DSH Web (`0.1.5-rc.2`) does not mount `apiProxy`; it exposes Typert remotes instead. Therefore this bundle mounts safely without a live DSH source when `apiProxy` is absent, and the isolated smoke test validates composition/lifecycle only.

**DSH's own packages are `peerDependencies`, never `dependencies`** — the host supplies them, and a plugin that installs its own copy drags a whole DSH generation into the profile and stops the profile from booting. That is what `0.1.1` did; see [`doc/publishing.md`](doc/publishing.md) §5.4 and §5.6 for the measured failure and the rule.

## 安装与原生模块说明

[Quick Start](#quick-start从-npm-安装) 已给出从 npm 安装、批准构建脚本和重启的最短路径。本节说明其中 `keytar` 构建步骤的原因与替代方案。

### 为什么要批准 `keytar`？

`keytar` 将 Cindy 登录会话保存在系统凭据库（Windows 凭据管理器、macOS Keychain 或 Linux Secret Service），因此需要下载预编译二进制；没有适配的预编译包时，会回退到本机编译。对 pnpm 10 而言，这一步需要显式批准构建脚本。

- Windows 通常需要 **VS Build Tools**（含 C++ 工作负载）；macOS 需要 Xcode Command Line Tools；Linux 需要 `libsecret-1-dev` 等构建依赖。
- 如果未批准或编译失败，插件仍会安装并挂载；仅 Cindy 登录和凭据存储不可用，并会给出明确错误。
- 不要使用 `0.1.1` 或更早版本的 tarball；它们会向 profile 装入不兼容的一代 DSH 依赖。请始终从 npm 安装当前版本。

发布、干净 profile 验证和替代的 `onlyBuiltDependencies` 配置见 [`doc/publishing.md`](doc/publishing.md) §5.2。

## 发布指南

- [doc/publishing.md](doc/publishing.md) —— **插件发布**：把本插件做成别人/别的 profile 能装上的 npm 包（bundle 三要素、三种消费方式、包内容白名单、干净 profile 验证、撤版）。
- [doc/releasing.md](doc/releasing.md) —— **改动上线**：门禁 → claw 留证 → 脱敏 → 部署（重启才是生效点） → 回滚。

## 仓库治理

分支 `main`，远端 `origin` = <https://github.com/chanyuenpang/dsh-cindy-host>（公开）。`v0.1.1`
已打 tag、推远端，并以 GitHub Release 形式附 tarball 分发（**不进 npm registry**，见
[`doc/publishing.md`](doc/publishing.md) §5.5）。

**入库的内容**：`src/`（插件与运行时）、`lib/`（设置页客户端入口）、`test/`（单测）、
`tools/`（验收脚本与活体探针）、`doc/`、`package.json` / `package-lock.json`、
`cordis.patch.yml`，以及 claw 的**项目记忆** `.claw/{tasks,adr,truth}/` 与 `.claw/project.json`。

**不入库的内容**（见 `.gitignore`）：

- `node_modules/`；
- `.sandbox/` —— 沙箱用的 DSH home，带它自己的凭据与会话存储。
  注意：`.sandbox/dsh-home/profiles/<profile>/node_modules/dsh-cindy-host-demo` 是指向本仓库的
  **junction**（不是副本），所以任何**跟随链接递归**的工具（`git status --ignored`、部分索引器）
  会绕圈并报 `Filename too long`。普通 `git add/status` 因为整目录被忽略不会进去；不要据此
  「清理」出一个递归副本，磁盘上并没有重复的仓库。
- `.claw/runtime/`、`.claw/logs/`、`.claw/memory.sqlite*` —— claw 守护进程的运行时状态；
- 仓库根目录的一次性探测残留（`.claw-*.txt|log|mjs|cjs|report`）与 agent 生成的图片。

**验证入口**：

```bash
npm test                                                              # 单测（463 项）
npm run audit:channels                                                # 通道判定表（served 52 / declined 140 / unclassified 0）
node tools/acceptance.mjs --base http://127.0.0.1:3080 --with-prompts # 端到端（105 项）
npm run verify                                                        # 上面三者的串行组合
```

`tools/probe-*.mjs` 是活体探针（分页耗时、媒体缩图、todo 投影、会话日志、历史视图形状），
它们只读本地 DSH 状态，用来把「手机上看到什么」量化成数字。

## Documents

- [Research](doc/research.md)
- [Architecture](doc/architecture.md)
- [Development plan](doc/development-plan.md)
- [Cindy phone link](doc/cindy-phone-link.md)
- [Projection read probe](doc/projection-read-probe.md)

## Next boundary

Cindy device-link integration requires a separate design and security review. It must not be added by swapping the console sink without defining identity, opt-in, topic contracts, and privacy policy.
