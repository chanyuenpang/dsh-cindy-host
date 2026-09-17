# 插件发布指南（DSH plugin bundle）

本文说的"发布"是**把这个 DSH 插件做成别人（或别的 profile、别的机器）能装上的东西**。
它的载体是 npm 包 + 一个 bundle 补丁层；git 提交与推送只是前置，不是发布。

---

## 1. 发布物是什么

一个 DSH 插件 bundle 由**三样东西**定义，缺一不可：

| 位置 | 字段 | 作用 |
|---|---|---|
| `package.json` | `dsh.bundle.patch: ./cordis.patch.yml` | 声明自己是 bundle，并指向补丁层 |
| `cordis.patch.yml` | 插件行（见下） | 装载进 profile 的**那一条** |
| `package.json` | `main` / `exports["."]` / `exports["./client"]` | 服务端入口与**客户端卡片**入口 |
| `package.json` | `dsh.client.platform: "web"` | 卡片在 Web 面渲染；缺 `exports["./client"]` 时 DSH 会解析失败（ADR-0006） |

本仓库当前的行：

```yaml
- insert:
    - id: dsh-cindy-host
      name: dsh-cindy-host-demo
      inject: [settings]
```

`insert`（而不是覆盖）意味着它**叠加**在基础 profile 上；`inject: [settings]` 是它唯一硬依赖的服务——
其余能力（`sessionController`、`fs`、`webServer`…）都是**运行时探测**：有就服务，没有就拒绝并给出准确的
错误码。这是插件能在各种 profile 下"挂得上"的关键，也是发布前必须回归的一点。

## 2. 别人怎么装上它（三种消费方式）

```bash
# a) 本地目录（开发期，link 语义）
dsh plugin --profile <profile> add <本仓库路径>

# b) tarball（不发 registry 也能分发）
npm pack                       # 产出 dsh-cindy-host-demo-<version>.tgz
dsh plugin --profile <profile> add ./dsh-cindy-host-demo-<version>.tgz

# c) registry（**0.1.2 起这是正式渠道**）
dsh plugin --profile <profile> add dsh-cindy-host-demo@<version>
```

装完后 profile 的 `package.json` 里会出现 `dsh.profile.bundles` 含 `dsh-cindy-host-demo`，
依赖形态分别为 `link:` / `file:` / 版本区间。**生效仍然需要重启 `dsh web`**（见 `doc/releasing.md` §4）。

## 3. 发布前的硬前提

1. **必须在没有 `apiProxy` 的 profile 上挂得上**。当前 DSH Web（`0.1.5-rc.2`）不再挂 `apiProxy`，
   改由 Typert remotes 暴露会话；本插件在缺席时安全挂载并在通道层回 `NOT_AVAILABLE`。发布前用
   一个干净 profile 复核这一点（`dsh --profile <p> --dump-config` 能 compose、`dsh --profile <p>`
   起得来且没有 Cindy 登录提示）。
2. **DSH 自己的包一律 `peerDependencies`，绝不进 `dependencies`（也绝不进
   `optionalDependencies`）**。宿主提供它们；插件自己装一份，就等于把**另一代 DSH** 装进别人的
   profile，宿主再组合这个混合体便起不来。0.1.1 犯的正是这个错，实测与规则见 §5.4 / §5.6。
   `dependencies` 里只放宿主不提供的库（本包是 `keytar` 与 `ws`）。
3. **原生依赖要写清**：`keytar` 是原生模块（Windows 凭据管理器）。发布说明里必须写明平台/Node ABI
   要求（本包 `engines.node >= 22`），否则会出现"装上了但起不来"。
4. **`private` 必须是 `false`**（发布到 registry 的必要条件；它是防止误发布的开关，不是发布配置。
   0.1.2 起本包为 `false` + `license: MIT`，仓库根有 `LICENSE`）。
5. **包内容必须是白名单**，而不是"整个目录"。`.sandbox/`（含凭据与会话）、`.claw/runtime`、验收日志、
   `.claw/tasks` 的开发记录**都不该进包**——它们在 git 里是资产，在 npm 包里是负担与风险。

建议的 `files` 白名单：

```json
"files": ["src", "lib", "cordis.patch.yml", "README.md", "CHANGELOG.md", "doc/"]
```

（`package.json` 里的实际白名单和这里一致；`test/`、`tools/`、`.claw/` 留在仓库里，需要随包分发
测试时再加。）

## 4. 版本与兼容性声明

- 语义化版本；插件对 DSH 的**兼容区间**要写进 README 顶部与 CHANGELOG：例如"验证于 DSH
  `0.1.5-rc.2`"。
- 每次发布记录**验证过的 DSH 版本**，因为 DSH 的公开 API 仍在 rc 阶段滚动。
- 破坏性变更（例如撤下 `history-view-v1` 能力、改变通道语义）必须同时更新 README 的兼容性边界与
  `.claw/truth` 里的对应条目。

## 5. 发布步骤

```
[ ] 1. 门禁：npm test / npm run audit:channels / 沙盒 acceptance / 真机 acceptance --with-prompts 105/105
[ ] 2. 版本号 + CHANGELOG（写清验证过的 DSH 版本与本轮用户可见变化）
[ ] 3. package.json：private=false、files 白名单、dependencies 里没有内部路径依赖
[ ] 4. npm pack --dry-run → 人眼过一遍文件清单（不得出现 .sandbox/、凭据、日志、.claw/runtime）
[ ] 5. 干净 profile 安装验证：Gate 1 compose 通过；Gate 2 起得来、无登录提示、卡片作为
       window.__DSH_BOOT__ 的 dsh-cindy-host-demo 条目被服务
[ ] 6. 发布：npm publish（或私有 registry / 仅发 tarball）
[ ] 7. 装到真机 profile → 按 doc/releasing.md §4 重启（先告知、留 60s）→ 真机复测本轮针对的现象
[ ] 8. 打 tag 并把 tag 推到远端，便于回滚与追溯
```

第 5 步是**唯一能证明"别人装得上"的一步**，不能省：本地 link 装法掩盖掉的白名单、原生依赖、
入口导出问题，都会在这一步暴露。

### 5.1 干净安装实际踩到的两个坑（2026-09-17，0.1.0）

1. **可选能力被静态 import 变成硬要求**。`src/dsh-plugin.js` 顶层 `import` 了
   `@deepseek-ai/dsh-host-apiproxy`（只有老 DSH 的 `apiProxy` 路径才用到），它的传递依赖
   `@deepseek-ai/dsh-agent-presets` 在干净环境里解析到没有 `InvalidPresetIdError` 的副本，
   **插件加载失败 → 整个 profile 起不来**。修法：改惰性 `require` + 失败降级，依赖移入
   `optionalDependencies`。**规则：可选能力一律不得阻断 mount。**
2. **原生依赖在 pnpm 10 下不会自动构建**。`keytar` 需要编译 `keytar.node`，而 pnpm 10 默认
   **不执行依赖的构建脚本**，于是干净 profile 里没有二进制，顶层 `import keytar` 直接让插件加载
   失败。修法同上（惰性 + 降级：读凭据回"无会话"，写凭据抛出 `CREDENTIAL_STORE_UNAVAILABLE`）。

### 5.2 安装方须知（写进面向用户的说明）

**这个包在安装时需要编译一个原生模块**，这不是可选项，是它的依赖决定的：

- `keytar` 是**原生模块**（Windows 凭据管理器 / macOS Keychain / Linux Secret Service），
  安装时必须编译出 `keytar.node`。**原因**：Cindy 的登录会话必须存放进操作系统的凭据库，
  而不是明文写进配置或仓库——这是本插件的凭据存储方式，没有纯 JS 的等价物。
- 因此安装需要**编译工具链**：Windows 上通常是 VS Build Tools（含 C++ 工作负载），
  macOS 需要 Xcode Command Line Tools，Linux 需要 `libsecret-1-dev` 等。
- **pnpm 用户**还必须显式允许构建脚本（pnpm 10 默认不跑依赖的构建脚本）：
  `pnpm approve-builds`，或在 profile 的 `package.json` 里加
  `"pnpm": { "onlyBuiltDependencies": ["keytar"] }` 后重装。npm 默认会跑构建脚本。
- **编译失败也能装上**（0.1.1 起）：插件照常 mount，只是登录/凭据相关能力明确不可用。
  换句话说，**"要编译"只影响凭据能力，不影响插件能否挂载**。

### 5.3 测 tarball 时的一个陷阱

**同名同版本的 `file:` 依赖，pnpm 不会刷新**：修改后重新 `npm pack`、再 `dsh plugin add` 同一个
`dsh-cindy-host-demo-0.1.0.tgz`，装上去的还是**旧副本**（实测：tarball 里已是新代码，profile 里仍是
旧代码）。要么先删掉 `profiles/<p>/node_modules/dsh-cindy-host-demo` 再装，要么——更贴近真实发布
流程——**每次测试都升版本号**。

### 5.4 全新 profile 起不来：根因是我们把旧一代 DSH 装进了它的依赖树（0.1.1 的缺陷，2026-09-17 更正）

**这一节原先的结论是错的，错误本身值得留着。** 当时写成「新建 profile 会回落到 DSH 嵌套依赖，
是 DSH 侧的问题，与本包无关」，理由是失败栈里出现的是 DSH 自己的包。实际上：

```
@deepseek-ai/dsh-client-file-upload
  ctx.commands.registerFileReceiptResolver is not a function
```

失败栈里出现 DSH 的包**不代表** DSH 有问题——它也可能是我们把它**换成了另一代**。真正发生的是：

1. `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` 的依赖是 **28 个 `@deepseek-ai/*@^0.1.1-rc.2`**
   （`dsh-commands`、`dsh-llm`、`dsh-session`、`dsh-tools`…）。它当时在 `optionalDependencies` 里，
   而 **pnpm 默认连 optionalDependency 也安装**，于是这一代被整体装进 profile。
   实测：安装前 profile-local `@deepseek-ai` 为 0，安装后 21 个，全部 `0.1.1-rc.2`。
2. 宿主是 `0.1.5-rc.2`。组合里于是混了两代：`file-upload` 拿到的是另一代的 `ctx.commands`
   （缺 `registerFileReceiptResolver`）；`loader entry session (@deepseek-ai/dsh-session)` 里
   0.1.1 的 `dsh-session` 去 import 宿主的 0.1.5 `dsh-llm`，后者没有 `CallId`。
3. 我们之所以把旧代声明成依赖，是因为**代码 import 了只在旧代存在的导出**：
   `settingsNamespace` 存在于 `@deepseek-ai/dsh-settings@0.1.1-rc.2`，而 `0.1.5-rc.2` 的导出面只有
   `SettingsProvider / SettingsConflictError / redactSecrets / default`（直接 import 验证过）。
   也就是说插件一直靠"把旧那代装进来"才能加载。

**0.1.2 的修法**：把 `settingsNamespace` 内联进 `src/dsh-plugin.js`（它的实现只是个 brand：
校验 `/^[a-z][a-z0-9-]*$/` 后原样返回字符串），DSH 的包全部改 `peerDependencies`，
`dsh-host-apiproxy` 另标 `optional`。修完的实测（全新 `DSH_HOME` + `--from-default-profile web`）：

```
add exit=0；profile-local @deepseek-ai = 0
compose exit=0（有 dsh-cindy-host 行）
dsh web: http://127.0.0.1:3095/?token=…
/api/dsh-cindy-host/status → 200 installed=true state=disconnected dataSource=session-controller
```

**教训（比结论更值钱）**：

- 失败栈里出现别人的包，**先问"这个包是从哪解析来的、是哪一代"**，再问"谁的锅"。我们当时只看了
  包名，就把它判给了 DSH。
- `optionalDependencies` **不是**"可以不装"：pnpm 默认会装。想表达"宿主有就用、没有就算了"，
  正确写法是 `peerDependencies` + `peerDependenciesMeta.optional`。
- 一个**只在一个方向成立的现象**（"`file:` 装法坏、`link:` 装法好"）要当心：这里的真变量不是
  安装形式，而是 pnpm 有没有**真的**把依赖图装进 profile。第一次改回 `link:` 时 pnpm 打了
  `resolved 71, reused 1, added 0`（什么也没干），所以那次"好"是假象。

### 5.5 发行渠道的历史：0.1.1 走 GitHub Release，0.1.2 起走 npm registry（2026-09-17）

**0.1.1（历史，且附件有缺陷）**：当时按上面第 6 步的"仅发 tarball"分支执行——发 GitHub Release
`v0.1.1` 并把 `dsh-cindy-host-demo-0.1.1.tgz` 作为附件，同时打 tag 推远端。选它的理由是当时
`license` 还是 `UNLICENSED`（公开进 registry 等于以未授权状态分发），而"干净 profile 冷启动"那一层
又失败（后来查明是**我们自己的依赖污染**，见 §5.4）。**那个附件会让装它的 profile 起不来**，不要再
用它安装。

**0.1.2（当前渠道：npm registry）**：`private: false` + `license: MIT` + 仓库根 `LICENSE`，然后

```bash
npm publish --access public          # → dsh-cindy-host-demo@0.1.2
npm view dsh-cindy-host-demo version # 读回来确认（刚发布时会有几十秒的复制延迟，404 不等于失败）
```

安装方向就变成按包名（§2 的 c）：

```bash
dsh plugin --profile <profile> add dsh-cindy-host-demo@0.1.2
```

实测（全新 `DSH_HOME` + `--from-default-profile web`）：`add` exit 0、profile-local
`@deepseek-ai` = 0、`dsh web` 启动、`/api/dsh-cindy-host/status` → `200 installed=true`。
`registry` 上读回的 `dependencies` 只有 `keytar, ws`（§5.6 规则一的直接证据）。

**撤版方式也随之改变**：见 §6。

### 5.6 依赖规则：DSH 的包只能是对等依赖（写死的检查）

**规则一**：`dependencies` 里不出现任何 `@deepseek-ai/*`。装完后在 profile 里查：

```powershell
(Get-ChildItem "$env:DSH_HOME\profiles\<p>\node_modules\@deepseek-ai" -Directory -ErrorAction SilentlyContinue).Count
# 期望 0 —— 非 0 就是我们把某个 DSH 代装进了别人的树
```

**规则二**：`peerDependencies` 的区间必须覆盖宿主当前那一代。semver 的预发布规则下
`^0.1.1-rc.2` **匹配不到** `0.1.5-rc.2`（比对符的 `[major,minor,patch]` 必须一致），所以要写
`^0.1.1-rc.2 || ^0.1.5-rc.2` 这样的或区间。生态里的参照：
`dsh-codex` 用 `^0.1.5-rc.2`，`dsh-cost-meter` 用
`^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0`。

**规则三**：`import` 的每一个具名导出，都要在当前宿主上验一遍。发布前跑一次：

```powershell
dsh --profile <干净 profile> --dump-config   # compose 必须 exit 0 且含我们的行
dsh --profile <干净 profile> --no-open --port <port>
# 然后 GET /api/dsh-cindy-host/status → 200
```

只做 compose 不够：**缺一个导出同样能让 compose 通过**，它到加载时才炸，而且 DSH 把加载失败的
entry 当作致命错误（整个 profile 起不来）。`0.1.1` 就是 compose 通过、加载失败。

## 6. 回滚与撤版

- **未发 registry（tarball 分发）**：装回上一个 tarball 即可，最干净。0.1.1 的实例正是这条：
  它是 GitHub Release 附件而不是 registry 版本，所以"撤版"只需要一条说明加一个修复版本
  （0.1.2），不需要动 registry。
- **已发 npm**：`npm deprecate dsh-cindy-host-demo@<bad> "原因"` 并立刻发一个修复版本；
  `npm unpublish` 有 72 小时窗口且被 registry 策略限制，不要把它当成回滚方案。
- **插件侧**：`dsh plugin --profile <p> add dsh-cindy-host-demo@<上一个版本>` + 重启。
- 回滚后仍要留下痕迹：`.claw/adr` 里追加 `Decision evolution`（为什么发坏了、下次怎么防）。

## 7. 检查清单（可直接复制）

```
[ ] 门禁四项全绿（unit / audit / 沙盒 / 真机 105-105）
[ ] 版本号已升，CHANGELOG 写明验证过的 DSH 版本
[ ] private=false；license 是 MIT 且有 LICENSE 文件；files 白名单
[ ] dependencies 里没有任何 @deepseek-ai/*（§5.6 规则一）
[ ] npm pack --dry-run 清单已人眼确认（无凭据/沙盒/日志/开发记录）
[ ] 干净 DSH_HOME + web 派生 profile 装 tarball：add exit 0
[ ] 装完 profile-local @deepseek-ai 计数 == 0（没把某一代 DSH 拖进去）
[ ] compose 通过 **并且真的启动**，GET /api/dsh-cindy-host/status → 200 installed=true
      （只做 compose 不算数：缺一个具名导出同样能 compose 通过，却在加载时让整个 profile 起不来）
[ ] 发布：`npm publish --access public`，再用 `npm view dsh-cindy-host-demo version` 读回确认
      （刚发布后几十秒内可能 404，那是复制延迟，不是失败）；同时打 tag 推远端
[ ] **从 registry 再装一次**到干净 home 并启动成功（发布渠道自己也要走一遍验收，不能只验本地 tarball）
[ ] 真机：告知 → 60s → 重启 → 复测现象
[ ] 失败路径已想好（deprecate + 修复版本，而不是 unpublish）
```
