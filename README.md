# DSH Cindy Host Demo

A DSH-to-Cindy host adapter. The console demo projects a DSH conversation list and safe lifecycle/status activity to a replaceable sink; the DSH bundle additionally carries the Cindy session, the DeviceLink relay, and the 「Cindy 手机连接」 settings card that lets the Cindy mobile client reach this Host.

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

## 安装要求：需要编译原生模块

装（**0.1.2 起发布在 npm registry**，MIT）：

```bash
dsh plugin --profile <profile> add dsh-cindy-host-demo@0.1.2
```

**不要用 0.1.1 的 tarball 安装**——那个版本会把整个旧一代 DSH 装进你的 profile，让 profile 起不来
（详见 [`doc/publishing.md`](doc/publishing.md) §5.4）。

这个包**在安装时需要编译**，原因是它的凭据存储用的是原生模块：

- `keytar` 是原生模块（Windows 凭据管理器 / macOS Keychain / Linux Secret Service），安装时要编译出
  `keytar.node`。**没有纯 JS 的等价物**——Cindy 的登录会话必须放进操作系统的凭据库，而不是明文写进
  配置或仓库。
- 所以安装需要工具链：Windows 上通常是 **VS Build Tools（含 C++ 工作负载）**，macOS 需要
  Xcode Command Line Tools，Linux 需要 `libsecret-1-dev` 等。
- **pnpm 用户**还要显式允许构建脚本（pnpm 10 默认不执行依赖的构建脚本）：`pnpm approve-builds`，
  或在 profile 的 `package.json` 里加 `"pnpm": { "onlyBuiltDependencies": ["keytar"] }` 后重装。
  npm 默认会执行构建脚本。
- **编译失败不会让插件装不上**（0.1.1 起 `keytar` 已改为惰性加载）：插件照常挂载，只有登录/凭据
  相关能力明确不可用。也就是说"需要编译"影响的是凭据能力，不是能否安装。

细节与实测记录见 [`doc/publishing.md`](doc/publishing.md) §5.2。

**同时：不要用 `0.1.1` 及更早的 tarball 装到别人的 profile 上。** 那些版本的 `package.json` 把 DSH 自己的包声明成了依赖，pnpm 会把**整整一代旧 DSH**（28 个 `@deepseek-ai/*`）一起装进 profile，宿主再组合这个混合体就会启动失败。`0.1.2` 起改为 `peerDependencies` 且不再 import 只在旧代存在的导出，实测干净安装可以启动（§5.4 / §5.6）。

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
