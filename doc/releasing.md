# 发布指南

本仓库的"发布"不是打 tag 推包，而是**把一次改动安全地送上真机并留下可复查的痕迹**。下面这条链路
是今天一整天（39+ 次提交、多次真机复测）实际走出来的顺序，按它走可以避免重复踩坑。

适用：`dsh-cindy-host-demo`（DSH ⇄ Cindy 手机客户端桥接插件）。

---

## 0. 一句话流程

```
隔离验证（沙盒） → 门禁全绿 → 用 claw 留证（plan/task/truth/ADR） → 脱敏 → 部署（重启才是生效点）
```

**核心判断**：改动是否"生效"只取决于 `dsh web` 有没有重启过。代码合并、文件保存、测试通过
**都不等于生效**。

---

## 1. 发布前门禁（四项，必须全绿）

| # | 命令 | 期望 | 说明 |
|---|---|---|---|
| 1 | `npm test` | 全绿 | 单元与契约测试；任何一项失败都不发布 |
| 2 | `npm run audit:channels` | `unclassified: 0` | 每个通道要么被服务、要么被显式拒绝，不允许"没分类" |
| 3 | `npm run sandbox` + `npm run acceptance:sandbox` | 沙盒 80+/81（唯一允许失败：未连中继） | 隔离实例验证，不打扰用户 |
| 4 | `npm run acceptance -- --with-prompts` | **105/105**、52/52 served、10/10 push | 对**真机**的端到端验收（会发真实 prompt） |

第 3 项是这一轮新增的能力：`tools/sandbox.mjs` 起一个**独立 DSH_HOME + 独立凭据 + 独立中继设备**的
第二实例（插件条目是指向本仓库的 link），所以功能迭代可以在那里反复重启验证，不必每次打扰用户。
它的局限也要记住：**会话少、规模小**，规模类问题（219 会话冷启动、超长转录）只能在真机验。

---

## 2. 用 claw 组织这次发布

claw 的价值不是流程仪式，而是**让"做过什么、依据是什么"在会话结束后仍然可查**。发布这种跨多轮、
多证据的活尤其需要它。

```bash
# 主代理侧（DSH 里一律走 claw_run，不直接跑 CLI）
claw_run plan.create   { title, goal, scope: "session" }
claw_run plan.start    { requirements, acceptance: [...], add_tasks: [{title, detail}, ...] }
claw_run task.done     { id }
claw_run plan.done     { retrospective, key_decisions, what_worked, issues, follow_ups }
```

三条纪律：

1. **每个 `task.done` 之前，前一条消息里要给出证据**（测试数、真机时间戳、日志片段）。`task.done`
   本身不接受结论字段——结论写在消息里。
2. **plan.start 的 `acceptance` 就是发布的验收标准**，发布时逐条对照，不凭感觉。
3. **计划文件不在仓库里**（写在 `~/.claw/runtime/sessions/<session>/tasks/...`）；仓库里的
   `.claw/{truth,adr,tasks}` 才是要随代码发布的**项目记忆**。发布前确认：本轮新增的事实进了
   `.claw/truth/*.md` 的 `<!-- state: current -->` 段，新增的**决策**进了 `.claw/adr/*.md`（含
   `Decision evolution` 段，写清"当初为什么这么定、后来为什么改"）。

判断哪些结论值得进项目记忆，用这一条：**"如果下一个接手的人不知道这件事，他会不会重犯？"**
今天写进 truth 的三类都是这个标准：手机端"切后台回来入站失效"的归属与一分钟复现法、turn 状态的
权威来源、以及"通知不是用户消息"这类投影决策。

---

## 3. 脱敏（只要仓库会公开，就必须做）

顺序很重要，**今天在这里出过一次事故**：

```bash
# 1) 先扫（两类都要扫）
git grep -I -E 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY' 
#    以及环境痕迹：手机型号、设备 UUID、用户名、本机路径、手机号、账号 id

# 2) 替换 + 重写历史（新建提交删不掉旧痕迹）
git filter-branch -f --tree-filter "node .sandbox/redact.mjs ." -- --all
rm -rf .git/refs/original && git reflog expire --expire=now --all && git gc --prune=now
git push --force origin main

# 3) 验证：拉一份干净副本复扫（不要相信本地结论）
git clone --depth 1 <url> /tmp/verify && grep -r <pattern> /tmp/verify
```

**两条教训（都来自今天）**：

- **要删/改名仓库，先把它改成 private，再动名字。** 重命名会**带走可见性**：我们先把旧仓库设成
  public、之后才 rename，结果那个"待删除"的壳带着**未脱敏历史**公开了 1–2 分钟。
- **`gh repo delete` 需要 `delete_repo` scope**（默认的 `repo` 不够）。优雅做法：旧仓库**先改私有**，
  再用网页 Danger Zone 删除（不需要额外 scope），别为了删除去改 token 权限。

---

## 4. 部署到 DSH（重启才是生效点）

插件以 bundle 形式挂在 profile 里（`link:` 指向本仓库，或 `cordis.patch.yml` 覆盖行）。**改完代码必须
重启 `dsh web` 才生效**。重启有三条路：

| 场景 | 做法 |
|---|---|
| 迭代/功能验证 | `npm run sandbox`（3081，独立实例）→ 我自己重启，不打扰用户 |
| 真机生效 | `node tools/restart-host.mjs --apply`（默认 60s 缓冲，通过 WMI 启动 supervisor） |
| **别的 agent / 别的项目** | 全局 skill **`dsh-restart`**：`~/.agents/skills/dsh-restart/scripts/restart-dsh.mjs`（同一套逻辑，去掉了仓库依赖；日志在 `~/.agents/logs/dsh-restart/`）。任何 agent 触发「重启 dsh」时都会用到它，规则同样遵守 ADR-0009 |

**重启的硬规则**（写进 ADR-0009）：

1. **必须先告知，并留足被读到的窗口**——默认 `--grace 60`。"与掉线同时到达的提醒不算提醒"。
2. 重启会**杀掉正在跑的那一轮**；会话日志是持久的，但**没有任何东西会自动续上**——需要一条新消息
   唤醒（手机发最稳，因为它不依赖网页 token）。
3. 新实例会自己打开新标签页（旧页面的 token 失效）。
4. 失败模式：**DSH 停在那里**，只有人能手动起。日志在 `.sandbox/host-restart.log`（全局 skill 那条路写在
   `~/.agents/logs/dsh-restart/host-restart.log`，新实例自己的输出在 `dsh-web.log`，新 token 在其最后一行）。

重启后自检三件事：`/status` 的 `boundaries`（`recovered`/`starting`/`silent`）、`handlerErrors`（应为空
或已归因到具体通道）、以及本轮新增诊断字段是否在场。

---

## 5. 回滚

- 代码：`git revert <sha>`（**不要 force push 已公开的历史**）→ 走第 1 节门禁 → 第 4 节重启。
- 真机出问题时的最快止损：`node tools/restart-host.mjs --apply` 重启本身就能清掉运行态故障；
  要回到上一版就先 `git checkout <上一版> -- src/ && 重启`，再正式 revert。
- 诊断面永远是第一手证据：`/status` 的 `invokeTotals` / `refusalTotals` / `recentInvokes`（带 src 归属）
  / `recentPushes`（带 watchers）/ `handlerErrors`（`where` 带通道名）/ `boundaries` / `suppressedNotices`。

---

## 6. 发布检查清单

```
[ ] npm test 全绿
[ ] npm run audit:channels → unclassified 0
[ ] npm run sandbox && npm run acceptance:sandbox
[ ] 真机 acceptance --with-prompts → 105/105
[ ] 本轮事实进了 .claw/truth（state: current）
[ ] 本轮决策进了 .claw/adr（含 Decision evolution）
[ ] 若公开仓库：密钥 + 环境痕迹扫描 → 需要则 filter-branch + 干净副本复扫
[ ] 推送前确认没有把 .sandbox / 凭据 / 日志带进版本库
[ ] 部署：告知 → 留 60s → 重启 → 自检 boundaries/handlerErrors
[ ] 用真机复测本轮改动所针对的现象（不是只跑测试）
```

最后一条是最重要的：**发布是否成功，由真机现象决定，不由测试数决定**。今天所有真正的缺陷都是
测试全绿时用户在手机上发现的。
