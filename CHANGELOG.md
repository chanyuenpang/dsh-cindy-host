# 变更记录

本文件记录**用户可见**的变化与**每次发布验证过的 DSH 版本**。格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

## [0.1.0] - 2026-09-17

首个发布版本。验证于 **DSH `0.1.5-rc.2`**（Web profile，Windows）。

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

[Unreleased]: https://github.com/chanyuenpang/dsh-cindy-host/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chanyuenpang/dsh-cindy-host/releases/tag/v0.1.0
