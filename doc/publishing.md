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

# c) registry（正式发布）
dsh plugin --profile <profile> add dsh-cindy-host-demo@<version>
```

装完后 profile 的 `package.json` 里会出现 `dsh.profile.bundles` 含 `dsh-cindy-host-demo`，
依赖形态分别为 `link:` / `file:` / 版本区间。**生效仍然需要重启 `dsh web`**（见 `doc/releasing.md` §4）。

## 3. 发布前的硬前提

1. **必须在没有 `apiProxy` 的 profile 上挂得上**。当前 DSH Web（`0.1.5-rc.2`）不再挂 `apiProxy`，
   改由 Typert remotes 暴露会话；本插件在缺席时安全挂载并在通道层回 `NOT_AVAILABLE`。发布前用
   一个干净 profile 复核这一点（`dsh --profile <p> --dump-config` 能 compose、`dsh --profile <p>`
   起得来且没有 Cindy 登录提示）。
2. **只依赖版本锁定的公开 DSH 包，绝不去解析 DSH 自己的嵌套 `node_modules`**。依赖里写
   `@deepseek-ai/dsh-session` 这类公开包是可以的；`require` 到 `dsh/node_modules/...` 的内部路径
   在别人机器上必然碎。
3. **原生依赖要写清**：`keytar` 是原生模块（Windows 凭据管理器）。发布说明里必须写明平台/Node ABI
   要求（本包 `engines.node >= 22`），否则会出现"装上了但起不来"。
4. **`private: true` 必须改成 `false`**（当前为 `true`，这是防止误发布的开关，不是发布配置）。
5. **包内容必须是白名单**，而不是"整个目录"。`.sandbox/`（含凭据与会话）、`.claw/runtime`、验收日志、
   `.claw/tasks` 的开发记录**都不该进包**——它们在 git 里是资产，在 npm 包里是负担与风险。

建议的 `files` 白名单：

```json
"files": ["src", "lib", "cordis.patch.yml", "README.md", "doc/"]
```

（`test/`、`tools/`、`.claw/` 留在仓库里；需要随包分发测试时再加。）

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

- **pnpm 用户**：需要显式允许构建脚本，否则 `keytar` 没有二进制。二选一：
  - `pnpm approve-builds`（交互式勾选 `keytar`）；或
  - 在 profile 的 `package.json` 里加 `"pnpm": { "onlyBuiltDependencies": ["keytar"] }` 后重装。
- **npm 用户**：默认会跑构建脚本，通常无需额外操作；需要编译工具链（Windows 上通常是 VS Build Tools）。
- **没有凭据库也能装**（0.1.1 起）：插件照常 mount，只是登录/凭据相关能力明确不可用——这是刻意的降级，
  不是"装坏了"。

### 5.3 测 tarball 时的一个陷阱

**同名同版本的 `file:` 依赖，pnpm 不会刷新**：修改后重新 `npm pack`、再 `dsh plugin add` 同一个
`dsh-cindy-host-demo-0.1.0.tgz`，装上去的还是**旧副本**（实测：tarball 里已是新代码，profile 里仍是
旧代码）。要么先删掉 `profiles/<p>/node_modules/dsh-cindy-host-demo` 再装，要么——更贴近真实发布
流程——**每次测试都升版本号**。

## 6. 回滚与撤版

- **未发 registry（tarball 分发）**：装回上一个 tarball 即可，最干净。
- **已发 npm**：`npm deprecate dsh-cindy-host-demo@<bad> "原因"` 并立刻发一个修复版本；
  `npm unpublish` 有 72 小时窗口且被 registry 策略限制，不要把它当成回滚方案。
- **插件侧**：`dsh plugin --profile <p> add dsh-cindy-host-demo@<上一个版本>` + 重启。
- 回滚后仍要留下痕迹：`.claw/adr` 里追加 `Decision evolution`（为什么发坏了、下次怎么防）。

## 7. 检查清单（可直接复制）

```
[ ] 门禁四项全绿（unit / audit / 沙盒 / 真机 105-105）
[ ] 版本号已升，CHANGELOG 写明验证过的 DSH 版本
[ ] private=false；files 白名单；依赖无内部路径
[ ] npm pack --dry-run 清单已人眼确认（无凭据/沙盒/日志/开发记录）
[ ] 干净 profile：compose 通过 + 起得来 + 卡片被服务
[ ] 发布（npm 或 tarball），并打 tag 推远端
[ ] 真机：告知 → 60s → 重启 → 复测现象
[ ] 失败路径已想好（deprecate + 修复版本，而不是 unpublish）
```
