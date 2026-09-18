# 交接:Cindy 手机端「切后台回来卡死」的调查与现状

> 2026-09-18 夜间整理。给**新开的对话**用:读完这一份即可接手,不需要读旧对话。
> 工作目录 `G:\Projects\DSH-cindy-host`(Host 插件);客户端仓库 `G:\Projects\Cindy`(分支 `fix/mobile-peer-silence-probe`)。
> 详细过程与逐条证据见:`doc/cindy-android-verify.md`(第九/十/十一节)与 `.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`。

---

## 1. 一句话现状

**根因已定位:App 从后台回到前台后,RN(Android)的 `setTimeout`/`setInterval` 定时器驱动整体死亡。**
它在 JS 侧救不回来(下面第 5 节全是实测结论),唯一有效动作是重启 App —— 而**在"内嵌 bundle 的 release 构建"里没有可用的 JS 重启入口**(`Updates.reloadAsync()` 会被原生层拒绝/崩溃)。
**当前给用户的可用版本是 `83d85c547`(能用、不会崩、卡了要手动重开)。**

---

## 2. 现象与可观测判据

**用户可见**:切后台 1–2 分钟回前台后,「思考时间」不再走、消息不刷新;退到会话列表再进来只更新一次;**杀掉 App 重开**才彻底恢复。

**Host 侧(不看手机就能判)**:

| 观测 | 含义 |
|---|---|
| `tdiag.stall.s<秒>.r<次数>.frame` | 手机自报:入站帧发现计时器停摆(渠道名即数据,见第 6 节) |
| `tdiag.sched.t?i?r?` | 停摆时探测哪个调度器还活着。**实测值 `t0i1r0`**:`setTimeout` 死、`setImmediate` 活、`rAF` 没来 |
| 停摆窗口内**零请求** | 客户端心跳/重连/重试全建在 `setTimeout` 上 → 永不重连(Host 实测过一次连续 90 秒) |
| 恢复时刻的 `device-link:subscribe` + 全套重读爆发 | 冷启动(或手动重开)的签名 |

读取工具:`node tools/verify-timer-stall.mjs`(一次打印自报、调用空档、连接层与判读)。

---

## 3. 根因链(证据在代码里)

1. `node_modules/react-native/Libraries/Core/setUpTimers.js:17` —— `setTimeout`/`setInterval` 由 **`JSTimers` 原生模块**提供(平台不再投递定时回调 → 整体停摆)。
2. 同文件 `:97` + `Timers/immediateShim.js:21` —— `setImmediate` 建在 **`queueMicrotask`** 上,所以停摆时它仍工作(实测 `i1`)。
3. `packages/device-link/src/client.ts` —— `pingTimer`(`setInterval`)、`reconnectTimer`、`peer.retryTimer` 全用全局定时器 → **停摆后客户端永不重连**。
4. `apps/mobile/app/sessions/[sessionId].tsx` —— 「思考时间」是 `setInterval(updateElapsed, 1000)`。
5. `packages/maker-shared/src/historyViewController.ts` + `apps/mobile/src/session/remoteSessionStore.ts` —— 视图失效与流式增量 flush 都压在 `setTimeout` 上。

---

## 4. 已经做过什么(逐层结论)

| 层 | 内容 | 真机结果 |
|---|---|---|
| 1 | `timerLiveness` 守卫:入站帧/回前台为检查点,发现停摆就重建心跳 + 上报 | **检测有效**(`tdiag.stall` 稳定出现);**重建无效**(间隙单调增长 81→103→109→…→125,`reviveCount` 停在 1,**从无 recover**) |
| 2 | `HistoryViewController.invalidate` 的 500ms 防抖 → 停摆时改挂钟节流直读 | 有效(数据层) |
| 3 | `remoteSessionStore.scheduleTextDeltaFlush` → 停摆时直接 flush | 有效(数据层) |
| 4 | 停摆时强制 `connectionEpoch` 换代(等价"退出去再进来") | 有效(数据层) |
| 5a | **垫片**:包住全局 `setTimeout`/`setInterval`,用 `setImmediate` 接管 | ❌ **App 卡在 splash**。已回退(`a8b80a893`)。教训:单测只跑了"注入假定时器",**真实全局包装的启动路径从未验证** |
| 5b | **自动重启**:连续两次确认停摆 → `Updates.reloadAsync()` | ❌ **切出去回来就崩**。原因:`reloadAsync` 只对"有 OTA update 被加载"的构建有效,内嵌 bundle 的 release 会被原生层拒绝/崩(仓库自己 `manualUpdateCheck.test.ts` 注释写过)。已停用(`710782b8e`) |

**数据层修复 2/3/4 有效但用户看不见** —— 屏幕仍然不更新,因为渲染/定时器那一层没救。

---

## 5. 不要重复的坑(全是实测)

1. **JS 救不活计时器**:新建 `setInterval` 在停摆态同样不触发(这是判据 `t0i…` 的直接含义)。
2. **别包全局定时器**:会在启动路径上崩(5a)。
3. **这个构建里没有可用的 JS 重启入口**:`reloadAsync` 崩;`DevSettings.reload` 只在 debug;要重启必须加**原生**模块。
4. **别把"回前台"当故障证据**:后台待多久,心跳就"像停了多久"。必须要求**连续两次检查仍停摆**(真死会继续涨,后台假死会在下一个入站帧上消失)。这条已经做进 `timerLiveness.onStallPersisting`。
5. **重启类动作必须先落盘记账**:仓库 `apps/mobile/src/update/otaReloadGuard.ts` 就是为"某台设备累计重启 33 次仍在循环"写的;写不进存储就不许重启。
6. **判据要能在没有入站帧时送出**:上报若只在"检查点"收口,停摆期间可能永远发不出去;回前台是原生事件,必须在那里无条件收口(`flushSchedulerProbe`)。
7. 出包脚本会过滤 Gradle 输出,**失败原因行会丢**;脚本现已自动停 Gradle 守护进程 + 清库产物并在失败时打印原因(见 `tools/build-cindy-verify-apk.ps1`)。

---

## 6. 协议小抄:手机如何"无日志上报"

手机端没有落盘日志。自报方式是 **invoke 一个未知通道名**,Host 以 `CHANNEL_NOT_ALLOWED` 记下通道名与到达时刻:

- `psdiag.s<静默秒桶>.p<pending>.a<短超时在等>.c<累计沉默>.o<对端被标离线>`(device-link 侧对端静默)
- `tdiag.stall.s<秒>.r<重建次数>.<来源>` / `tdiag.recover.after<秒>s.r<次数>.<来源>`
- `tdiag.sched.t?i?r?[.<来源>]`(0/1 = 该调度器是否回调过;来源 `frame` 或 `active`)
- `tdiag.reload.*`(attempt/blocked/noguard/failed —— 注意:重启会把这些还没发出的上报一起带走)

Host 侧读取:`diagnostics.phoneDiagnostics`(0.1.7 起,带到达时刻、不被普通轮询冲掉)。

---

## 7. 未走的路(唯一剩下的方向)

**原生侧方案**,需要用户同意后另开工作项:

- 候选 A:加原生重启模块(如 `react-native-restart`),在"连续两次确认停摆"后调用;必须先落盘闸门。
- 候选 B:原生侧在 `onHostResume` 重新注册 RN 的 Timing/Choreographer 驱动(治本,但要动 RN 集成)。
- 候选 C:降低后台驻留期间的动作面,减少触发概率(治标,不修复已进入的状态)。

**无论哪个,验证要求(吸取 5a/5b 的教训)**:先在**本地**验证"启动安全 + 崩溃安全"(至少:真机冷启动、切后台回来、连续多次),再交给用户;不要再拿用户手机当第一次运行环境。

---

## 8. 资产与索引

- 客户端提交(未 push,分支 `fix/mobile-peer-silence-probe`):
  `eadedb8d5`→`308b4badc`→`bd4ed7e73`→`b72f15a61`→`94f083331`→`04d36977f`→`d4969890c`→`4b200d931`→`83d85c547`→`c3b49e0b1`→`988830d21`→`37fb34db9`→`a8b80a893`(回退垫片)→`10329b4c1`(自动重启)→`710782b8e`(停用自动重启)。
- Host 插件提交:`7025127` `fc5d320`(0.1.5)`c728f11` `3169cdd` `d1bb697`(0.1.7)`97f31c3`(0.1.8)`ac4e303`(0.1.9,401 自动刷新)`b303b85` `9bc49c1` `05070a6`(重启不弹窗,但见坑:那次改动让 WMI 路径失败过,已还原关键部分)`3112425` `8743fa4` `c939e6c`。
- APK(项目内路径,用户只用这个目录):`artifacts\Cindy-Verify-0.1.0-arm64-v8a-<commit>.apk`
  - **可用**:`83d85c547`(sha256 `F6BC31D6…CEB7`)
  - 会崩:**`10329b4c1`**(自动重启)、`37fb34db9`(垫片) —— 不要给用户
- 工具:`tools/export-download-link.mjs`(`--direct` 绕开 Host 陈旧凭据)、`tools/verify-timer-stall.mjs`、`tools/probe-oss-ext.mjs`、`tools/build-cindy-verify-apk.ps1`
- 文档:`doc/cindy-android-verify.md`、`.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`、`.claw/truth/dsh-cindy-host-media-staging.md`

---

## 9. 顺带已修好、与本案无关但别改坏的东西

- **阿里云 OSS 拒发安装包**:`.apk`/`.ipa` 后缀或 APK 的 Content-Type 会被 `400 ApkDownloadForbidden` 拦;Host 现在按不透明字节 staging(0.1.6)。
- **Host 列表读超时让手机判"设备离线"**:`local-db:sessions:list` 现在按缓存应答 + 后台刷新(0.1.8)。
- **Host 凭据轮换后 401**:媒体路径 401 会串行刷新并重试一次(0.1.9);另有 `--direct` 工具用于应急。
- **重启弹控制台窗口**:`windowsHide` 已加;但**不要把看守进程再套一层隐藏包装** —— 那会让 WMI 失败、退化成活不过命令的 spawn,重启静默不发生(实测踩过)。

---

## 10. 验收判据(修正版,别再用旧的那条)

旧判据里「Host 收到**恢复**诊断」**不可满足** —— JS 救不活计时器,`tdiag.recover.*` 永远不会出现。可判定的三条:

1. **用户可见**:停在会话页时思考时间自己在走、新内容自己进来(不需要退出去再进来);
2. 停摆窗口内手机**仍在持续读取**(说明 2/3/4 层生效);
3. 停摆被手机自己发现并上报(`tdiag.stall.*`),且随后出现一次**重新订阅**(层 4 换代生效)。
