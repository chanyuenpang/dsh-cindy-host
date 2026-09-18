# DSH Cindy Host: 手机端“切后台回来入站失效”的已知限制与归属

<!-- state: current -->
## 结论

**在鸿蒙（HarmonyOS）上运行安卓版 Cindy 客户端时，App 从后台回到前台后，这条 device-link 连接的
「读方向」会失效而「写方向」仍然正常**：客户端发出的请求能到达 Host，Host 的答复与所有推送都到不了
客户端。表现是——发送后气泡一直转圈、看不到 agent 的工作进度、顶部没有重连提示、设备仍显示“已连接”；
**退出会话再进（或重启 App）重建连接后一切恢复**。

**归属（2026-09-18 收窄）：触发点是操作系统的应用恢复行为，但「它永远不自愈」是客户端判据缺陷。**
手机端**所有**活性判据量的都是「手机↔relay」：`pong` 由 relay 自己应答（`scripts/device-link/relayFixture.ts:85-86`，
且全仓没有任何一端发 `pong`），而手机的心跳判死条件是「20 秒内没有任何入站帧」
（`packages/device-link/src/client.ts:1913-1945`，其中 `:1918-1919` 是「任意入站帧即清零」），
于是 relay 每 10s 一次的 pong **让半开检测永久失明**；唯一会主动探测并 `restartConnection` 的
`notifyNetworkChanged` 又被 `:860` 的「任意入站帧即证明可达」早退挡住。手机端 timing 见
`apps/mobile/src/device-link/DeviceLinkContext.tsx:831-841`（`pingIntervalMs: 10_000` / `pongMissLimit: 1`）。

Host 侧的边界不变：**我们发出去的任何东西都走那条死掉的方向**，所以 Host 无法自救（包括无法「踢」对端——
`transport-timeout` 也是 routed 帧，且要求先有可靠层，我们只 advertise 了 `history-view-v1`）；
唯一不经该方向的通道是 `notify`（APNs/FCM），而它只能提示**人**去重开 App。

修复已实现，**待真机验证**：见下方「2026-09-18 更新」。

## 依据

1. **官方客户端同样复现**（用户实测）。同一现象在参考实现上出现，排除“某个客户端版本/分支的问题”。
2. **主机侧一切正常**。以 12:29 那次为例：手机入站 `input:enqueue ok=True`（消息确实到了并按
   `turn/start` 落盘）、`watchers=<phone-device>`（订阅一直在）、Host 也按 30s 规则补推了
   `maker:input:projection` 与 `maker:history-view-changed`。也就是 Host 该发的都发了、该答的都答了。
3. **客户端在重复重发同一个读**——这是主机侧可观测的“答复没到达”签名：
   ```
   12:18:03 / :04 / :08 / :09   messages:view + view-intent
   12:20:20 / :21 / :28         同上
   12:29:09 / :10 / :18         同上
   ```
   如果它收到了答复，就不会一秒问两次。这与“读方向死了、写方向还活着”完全一致，也解释了为什么它自认
   健康（它只按“发送是否成功”判断）。
4. **协议没有投递确认**：push 是 routed fire-and-forget（`packages/device-link-protocol`），Host
   对“客户端是否收到”零观测。因此这个方向的故障**在 Host 侧既看不见也无法补救**——任何“我们发出去了”
   的推断都不能当成“它收到了”。

## 对现场的处理（不修，但有绕过）

- 症状出现时：**等约 1 分钟**（入站通道有时会自行恢复，durable 行随后送达）；仍不出现则**退出会话再进**，
  强制重建连接。两条都是绕过。
- **重启 App 同样有效（用户实测，2026-09-17）**：重启会重新订阅，于是 `device-link:subscribe` 时的补帧
  （输入投影 + 一次视图失效）终于到得了它，之前发的东西随即出现——**照片当时就在 Host 这边，从未丢过**。
  这条值得写下来，因为“重启后才看到”很容易被误读成“消息丢了”。
- 若将来客户端愿意改：判据它手上就有——**“发出的请求超过 N 秒没有回复”就该主动重连**（而不是只看发送
  是否成功）。这一点与 Host 无关，是客户端/OS 侧的修复路径。
  **→ 2026-09-18 这条已经实现**（`peerSilenceProbeMs`，见下方「2026-09-18 更新」）。

## 它看起来像“照片的 bug”，其实触发条件是“挑照片”（2026-09-17 复现并定性）

用户报「只发照片没发文字，这个信息也被吞了」，并自己提出可能是选图时 App 进了后台——**这个判断是对的**，
而且解释了为什么同一现象总在照片上出现：

1. **挑照片必然把 App 切到后台**（系统选择器接管前台），回到前台正是本条的触发点；
2. 回到前台后**写方向正常**：照片照旧上传/发送成功，Host 完整收到（会话日志里是持久的 `user/message` +
   `image` 块，`rpcId` 是手机的 clientId，附件也读得出来、水合成了 `images[]`）；
3. Host 推回去的 `local-db:messages:created`（已内联图片）与 `maker:history-view-changed`（当时总共推了
   66 次）**都到不了客户端** —— 推的就是那条死掉的方向。于是屏幕上什么都没有，看起来像“消息被吞”。

**实测签名**（15:31 的 `/status` `recentInvokes`，当时手机仍处于半死状态）：同一秒里
`local-db:messages:view` + `messages:view-intent` 反复出现、**答复字节数完全相同**（14496 / 155）——
如果答复到了，它不会一秒问三次。这与“出站活、入站死”完全一致。

结论：**不是本插件缺陷，也不是之前那个 `carried no text` 的拒绝**（那条早已修掉，且本次 Host 侧数据完整）。
Host 侧无法补救（推送走的就是死掉的方向），能做的只是把“触发条件”写清楚：**选图/拍照这类必然
后台→前台的操作之后，紧接着发的消息可能看不到，需等约 1 分钟或退出会话再进。**

## 2026-09-18 更新：根因收窄 + 客户端修复（待真机验证）

**定位过程**：本 Host 是否重启都不能让手机重连（手机的 pong 来自 relay，重启 host 动不到它那条链路；
relay 的断连契约只会广播 `presence-changed{online:false}`，客户端不据此重建自己的 socket）。
更硬的一条：按 relay 的路由模型（`relayFixture.ts:83-84` 校验发送方、`:107` 投递给目标用的是**同一条**
peer entry），手机帧能到我们 ⇒ 那条 entry 指向的正是手机的活 socket ⇒ 我们回给手机的帧也发到了同一个活
socket ⇒ **丢帧发生在手机进程内部**，不在 relay。结论：这不是 Host 能修的，必须是客户端加判据。

**已实现**（分支 `fix/mobile-peer-silence-probe`，commit `eadedb8d5`；仓库 `G:\Projects\Cindy`，未 push）：

- `packages/device-link/src/client.ts`：新增 opt-in `peerSilenceProbeMs`（默认 0 = 关闭，桌面端曲线不变）。
  开启后：只有带 `src` 的 routed 帧算「对端还在说话」；同一 peer **连续两次**请求超时且对端持续静默 →
  `restartConnection`（自带 link 状态复位）；relay 已判 `DEVICE_OFFLINE` 时不介入；同窗口限速一次。
- 回前台探针改以**对端活性**作为「relay 可达」的证据，并要求已存在超时证据——避免把长执行通道
  （`desktop-cmd:run` 等，运行期间被控端本来就不发帧）在跑的命令打成失败。
- `apps/mobile/src/device-link/DeviceLinkContext.tsx`：手机端显式开启 `20_000ms`。
- 单测 5 条（默认关闭 / 连续两次超时触发 / 对端有帧不触发 / relay 判离线不触发 / 探针闸门）；本包 **414/414**。

**上游**：[makecindy/cindy#4634](https://github.com/makecindy/cindy/issues/4634)（含本次补充的证据评论：
修正了 issue 标题里「所有入站帧丢失」的表述——relay 自己产生的 pong 仍在到达，丢的是设备到设备的路由帧）。

**真机验证交接**：[`doc/cindy-android-verify.md`](../../doc/cindy-android-verify.md)——环境已装好（JDK 17 +
Android SDK，区域 cn、测试包名 `com.xd.cindycn.verify` 可与商店版共存），出包/安装/复现/判定标准、以及
实测跑通的构建配方与 10 个坑都在里面。

**APK 已构建完成（2026-09-18 16:32）**：
`C:\Users\chany\Downloads\Cindy-Verify-0.1.0-arm64-v8a-308b4badc.apk`
（77.2 MB，仅 arm64，JS 已内联所以真机不需要 Metro；SHA256 `8F1B73D9…CA5A`；桌面名 **Cindy Verify**）。

**第一版为什么"装了也没用"（2026-09-18 现场修正，commit `308b4badc`）**：`eadedb8d5` 那版的触发条件
要求「同一 peer **连续两次**请求超时」——而切后台再回前台时，App 往往**只发一轮请求**（每个只超时
一次），连续计数永远到不了 2；回前台探针那条路又额外要求「已存在一次超时证据」。于是**两条路都永远
不会重建**，装了带修复的包也不会恢复。本版改为：**探针超时本身即证据**（前台提示之后一个对端帧都
没来）+「有**短超时**业务请求在等回包」就重建；长执行通道（`desktop-cmd:run` 等分钟级超时）用请求
自身的生效超时排除。已从包内回读确认新逻辑在场（Hermes 字符串表 + sourcemap）。

**只剩真机复现这一步。**

判定标准：日志出现 `peer silence detected, forcing reconnect (peer=…, silentForMs=…, pending=…, timeouts=2)`
且 ~30 秒内自愈（修复前必须杀 App）。

## Host 侧保留的两处缓解（针对偶发丢帧，不针对本条）

| 提交 | 行为 | 仍然有用的场景 |
|---|---|---|
| `a9eb1b0` | `device-link:subscribe` 时补 `maker:input:projection` + 一次视图失效 | 客户端真的重订阅（App 重启、换会话）时少一次陈旧 |
| `da6f6a2` | 设备开口提及某会话时补同样两帧，每会话 30s 最多一次 | 中继抖动、订阅空窗造成的偶发丢帧 |

两者都不能救本条的“半死入站”——那需要一条我们看不见的通道恢复工作。

## 复发时先做的三件事（省下今天花掉的取证时间）

1. 看 `/status` 的 `subscriptions.sessions`：手机是否仍在订阅表里（在 → 不是订阅问题）。
2. 看 `recentInvokes` 里手机是否在**重复发同一个读**：是 → 答复没到它，方向性问题。
3. 看 `pushTotals` 是否仍在自增：在 → Host 有目标可推且在推，问题在通道而不在 Host。
   **不要用 `recentPushes[].watchers` 判断这一条**：它是「算不算已送达」的计数，中继把手机标成离线
   时它就是 0，而那正是这种故障的常态（`recordPush` 收到的是过滤掉 `offlineDevices` 之后的数量）。

## 2026-09-18 18:37 二次真机取证：**另一种卡死，机制完全不同**

用新包（`94f083331`，带对端活性看门狗）复现后，Host 侧的逐 5 秒时间线显示的是**另一回事**：

```
10:37:03–06  一串调用(回前台:重新订阅 + sessions:get + messages:view + list-active)
10:37:06 → 10:37:28   22 秒里「一次调用都没有」        ← 不是"答复没到",是它根本不再问
10:37:28 / :33 / :55  只有用户操作触发的 input:enqueue / steer
同时刻 Host 侧:推送一直在发(watchers=1)、订阅一直在、reconnect=0、handlerErrors 空、
               帧预算 0 抑制、手机 online=True
用户侧: 「思考时间一直不动」;导航、发消息可用;退到会话列表再回来不行;**只有重启 App 才行**
```

**机制**:后台驻留后 RN(Android)的计时器驱动不再装上,而这个 App 的实时行为**全建立在
`setInterval`/防抖上** —— 轮询(`messages:view`/`view-intent`,由 push 到达后的防抖重载驱动)、
对端探针、以及「思考时间」(`app/sessions/[sessionId].tsx` 的 `setInterval(updateElapsed, 1000)`)
一起停;而 AppState 回调、socket 事件、导航、发送这些**事件驱动**的路径照常工作。计时器是
React 实例级的,所以换屏/回列表都不恢复,只有整进程重开。

**两种卡死的区分方法(用户看到的一样,Host 看到的完全不同)**:

| | 手机还在问吗 | 机制 | 归属 |
|---|---|---|---|
| A(本文件上半部分,12:18 那次) | **在问,而且重复问同一个读** | 答复到不了它:读方向死 | 客户端判据缺陷(已有修复,待真机确认) |
| B(本次 18:37) | **完全不问了** | 计时器整体停摆:它不再产生请求 | 客户端生命周期缺陷 |

**B 的修复(commit `04d36977f` + 第二层,新包待验证)**:`apps/mobile/src/device-link/timerLiveness.ts` ——
入站帧与回前台这两个**不经过计时器**的事件当检查点,心跳间隙 ≥3s 判定停摆 → 重建心跳 +
重连/rehydrate,并把停摆与恢复经「未知通道名」上报(`tdiag.stall.s<秒>.r<次数>.<来源>` /
`tdiag.recover.after<秒>s.r<次数>.<来源>`)。**上报即判据**:手机端没有落盘日志,Host 侧新增的
`diagnostics.phoneDiagnostics`(带到达时刻、只被更多自报挤掉、不被普通轮询冲掉)是唯一时间线。

**第二层(即使重建救不回来界面也能恢复)**:停在 `setTimeout` 上的那一跳已定位 ——
push → `HistoryViewController.invalidate()` → **`setTimeout(500ms)`** → 重读
(`packages/maker-shared/src/historyViewController.ts`)。计时器停摆时它永不执行,
这正是「推送一直在到、界面永不刷新、一次 `messages:view` 都不再发」的直接原因。
现在该控制器接受注入的 `timersHealthy`;停摆时改用**挂钟节流 300ms + 立即重读**,
不依赖任何定时器;「思考时间」也改成渲染时按真实时间算。

**下次复现按这条读**:`phoneDiagnostics` 里出现 `tdiag.stall.*` → 证实 B;**紧跟着出现
`tdiag.recover.after*s`** → 重建生效(界面应在 10 秒内恢复实时刷新);只有 `stall` 没有 `recover`
→ 计时器无法从 JS 侧复活,下一步要把 App 的实时循环改成不依赖 `setInterval`(push 事件直接驱动)。

