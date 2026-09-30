# 大文件 peer：已复现的 Host 协商截止缺陷

## 结论

找到并最小修复一个**确定的 Host 缺陷**：合法的慢 ICE 配置响应叠加 TURN UDP→TCP 重试，能超过旧 offer 的 15 秒截止，导致已有可用本地候选的连接被提前关闭。它足以触发“peer 失败 → 旧 OSS 512MiB 超限”。**尚未证明用户那次 1,315,101,941 字节 APK 就命中此条件**；如果当时几乎立即报错，而非等待约15秒以上，此候选不吻合。

本轮没有 Android 打包、手机更新、发布、部署、DSH 重启、游戏 APK 内容读取/重传或凭据提取，也没有新派诊断 agent。Cindy 未提交的产品修复未修改。

## 确定链路与触发条件

- `src/host-file-peer.js:179–209`：总 offer 计时先开始，再 loadIceServers，再 `await pc.setLocalDescription(answer)`，最后才调用 `gatherIce(c)`。旧总预算15秒。
- `node_modules/werift/lib/webrtc/src/peerConnection.js:714–725`：`setLocalDescription` 内部已经 **await gatherCandidates**；后置的4秒 gather 等待不能限制这一 await。
- `node_modules/werift/lib/ice/src/ice.js:701–702,881–920`：等待所有候选任务；UDP TURN 分配失败后再尝试同端点 TCP。即使 host candidates 已产生，也要等待这条重试链结束。
- `src/host-file-ice.js:28–52`：配置请求合法预算为3秒。
- `Cindy/packages/device-link/src/allowlist.ts:714`、`invokePolicy.ts:73–86`：file-peer RPC 实际给30秒，不是 mobile 默认15秒。Host 自己提前截断了这段合法预算。

复现仅使用本机 UDP/TCP 黑洞服务、模拟用户名/口令和 **2.75秒配置响应延迟**，不触达公网 TURN、不传文件内容。配置加载在依赖注入边界模拟；显式localhost STUN替代werift隐含的公网STUN，不更改其TURN串行重试逻辑：

| 场景 | 实测 |
|---|---|
| 对照：只有本机 STUN 超时，无 TURN | ~5.06秒得到 answer |
| 只有 UDP TURN 不响应、TCP立即拒绝 | ~6.47秒得到 answer；**这个更弱条件没有触发缺陷，不能笼统说 TURN 不通必超时** |
| UDP和TCP均不响应 + 配置2.75秒，旧15秒总截止 | **15.006秒 FILE_PEER_TIMEOUT**，已有2个 host candidates，仍在 gathering |
| 完全相同条件，25秒总预算 | **15.621秒得到 answer，随后本机 ICE/DTLS 连接 established** |

## 为什么旧手机版只显示大小超出

原 `peerFileTransport.tsx` 在 offer/answer 异常后 catch 返回 null → 原 shared `fileAccess.ts:43–54` 调 fallback → Host `src/host.js:285–286` 的旧导出 guard 拒绝 >536,870,912 字节。1,315,101,941 <2GiB，所以“超限”不是新协议的上限，而可能是覆盖原始协商错误的第二次失败。

当前 Cindy 未提交修复已在 `peerFileTransport.tsx:197–213,259–263` 保留 answer 阶段错误，shared fileAccess 防止大文件错误 fallback；它修复失因掩盖，**不修复 Host 的15秒提前截止**。无需先打完整 Android APK才能复现或修本 Host 点。

## 最小修复和验证

- 仅将 `src/host-file-peer.js:185–189` 的 offer 上限从15秒改为**25秒**，保留 RPC 回程5秒。没有提高文件大小、改框架、改60秒进度空闲截止或权限/并发约束。
- `test/host-file-peer.test.js:373–397`：新增16秒完成 gathering 的回归（修改前确实失败、修改后通过），并校验24.999秒尚未超时、25秒超时且迟到工厂资源仍关闭。
- 针对性 manager 测试 **53/53**；最终两项时间边界测试 **2/2**。未跑无关全量回归。
- `tools/file-peer-ice-deadline-probe.mjs`：真实 werift + 产品 manager + 本机黑洞的可重现验证；默认验证修复后，`--legacy-budget` 仅在隔离进程注入旧15秒截止。复现进程退出释放未结束的库内重试，无生产修改。
- `tools/file-peer-mobile-boundary-probe.mjs`：真实移动端 HTML/CSP/生成 runtime 在 Chromium 运行；发送65,540条有序小消息，再执行16KiB接收+EOF，共**81,924字节合成内容**，成功跨过相当于16KiB块传到1GiB处的SCTP序号回绕。排除“>1GiB序号回绕必坏”候选；这不是Android原生真机验收。

## 其他已核对边界

- 当前分享入口默认整文件，预览页下载显式 stream=false；没有发现把APK分享误作 stream 的代码错误。layout 挂载 PeerFileTransport；手机询问的是 **Host caps.fileRead**。
- Android Expo标准 file:// 的 File.open 默认读写，不是只读；16KiB分块刷新的是进展超时，并非整个1.3GB下载必须60秒完成。
- GitNexus：Host索引停在2026-09-18/205a24b；已用 context确认owner，但新功能以实际文件为准。登记的 Cindy-markdown-preview 是另一工作树，没有重建索引或把它当本分支事实。当前Cindy为 fix/mobile-peer-silence-probe / dc294b02ca，未提交修复按磁盘文件核对。
- 14:18实时状态显示3080已是 **PID40916，11:10:11启动**，不是上轮PID8932；这是本轮开始前的现场变化，本轮没重启。当前file-peer调用/拒绝计数为空，旧失败环已不可用于还原当次原因。

## 给主助手的最小后续

Host源码修复**尚未部署**。先交付这个已证修复，不把 Android 构建障碍当根因或前置。Cindy诊断改动继续由22890原会话持有，不覆盖其文件。

当次归因仍只缺一条：**同次 Host offer 的 FILE_PEER_TIMEOUT 及约15秒耗时**（而不是再拿一份APK）。旧记录已丢失时不能补造；以后经用户同意的正常操作可直接读取既有Host recentRefusals/counters配合请求时间，无需为此先重打Android。若签名不符，继续定位手机ready/空间/接收阶段，而不把本确定缺陷冒充唯一历史根因。

回传：指定 key `file-peer-original-owner-root-cause-report-20260921-01` 已成功提交一次；receiptId=`d22dbd766fa1082dcea18845f4f187811a5d3e1e0e022a81e53217e4f7608ea3`，requestId=`assistant-d10baf91-87f1-453b-921f-03ac3af25c04`，admission=accepted（仅入队，不冒充主助手已处理或手机成功接收）。
