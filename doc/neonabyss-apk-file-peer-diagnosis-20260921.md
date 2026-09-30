# NeonAbyss2.apk 手机下载超限：功能开发者有限诊断

- 检查时间：2026-09-21 01:03–01:11（UTC+08）。
- 状态：**手机接收仍未成功；精确 peer 失败点尚未证实。** 本轮完成有限定位，不等于修复或端到端验收。
- 范围：只读既有运行诊断/源码、两份目标文件的路径授权与元数据准备；仅新写本报告。未发布、部署、改生产设置、重启、启动另一 DSH、改 Cindy 源码、发起 RTC offer/open/receive、重传 APK、访问 OSS 或读取/输出 token/凭据。旧“发布”动作未恢复，冻结的 session-bridge 升级未触碰。

## 结论先行

1. **不能再将“当前进程没重启，未加载文件 handler”当作首要结论或据此直接重启。** 现有 3080 运行实例已经实际响应 `caps.fileRead:true` 与 file-peer `{version:1,maxBytes:2147483648}`，并能对本次 1,315,101,941 字节 APK 完成新协议的 prepareOnly。
2. **文件大小在新通道范围内；工作区副本的正确 root/relPath 也可用。** NAS 原文件以它自身父目录为 workdir 时同样通过。不能推断历史手机请求用了这些正确参数，因为原请求未被日志保留。
3. 已将现阶段问题收窄为：历史客户端入口/构建是否走新读取流程，或 peer 在客户端注册、ICE/WebView、握手、手机磁盘/落盘等阶段放弃/失败，随后被旧 OSS 的大小错误覆盖。**目前不能单独断言手机过旧、TURN 故障或空间不足。**
4. 已证实一个诊断缺口：手机客户端的 peer 失败被 `catch → null` 吞掉；共享读取层随后进入 OSS fallback。1.315 GB 大于旧 512 MiB 上限，因此最终只见超限文案，与该失因链一致，但还缺同次完整错误和阶段证据确认本次确实如此。

## 实时证据

### 运行实例与磁盘版本

- `Get-NetTCPConnection -LocalPort 3080 -State Listen`：127.0.0.1:3080，PID **8932**。
- `Get-Process -Id 8932`：node，启动时间 **2026-09-20 19:27:34（UTC+08）**。
- `C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/package.json:3`：磁盘版本 **0.1.10**。
- 上述信息不能精确证明整个内存模块树的包版本或解释期间如何重载；但以下实际响应足以证明**新文件能力目前已在运行**。不拿包版本标签替代功能探针。

### 既有安全入口与请求结果

使用项目既有 `GET /api/dsh-cindy-host/status` 和 `POST /api/dsh-cindy-host/selftest`，均为 127.0.0.1:3080；没有寻找 token 或绕过认证。`src/host-routes.js:179–200,225–250` 明确定义 selftest 的本地 loopback 信任边界；本轮只调用元数据操作。`src/host.js:2433–2436` 给该类请求标记 `src:selftest`，它不是手机发来的请求。

| 检查 | 实际响应 | 可证明的边界 |
|---|---|---|
| Host 状态 | connected，projectionRunning=true | Host 当时在线 |
| `file-browser:remote-op / caps` | `{ok:true,fileRead:true}` | **手机询问 Host** 的能力合同可用；不是手机声明该能力 |
| `device-link:file-peer / caps` | `{version:1,maxBytes:2147483648}` | 新 file-peer handler 已提供服务；尚未建立 RTC |
| workdir=`G:/Projects/助手`，relPath=`delivery/NeonAbyss2.apk`，`fileUrl` | `{ok:true,url:"xdt-file://open?..."}` | 工作区副本路径通过本机绝对根、相对路径和真实路径授权 |
| 对该引用 `media:fetch {prepareOnly:true}` | `{ossKey:"",size:1315101941,mimeType:"application/octet-stream",transferRequired:true}` | 大小可接受，要求后续传输；没有读取整文件或上传 |
| NAS workdir=`Z:/[3] Veewo游戏项目/NeonAbyss2/游戏包/Android/Feature/shop-entitlement/2026.9.20.99b5007f212`，relPath=`NeonAbyss2.apk` | fileUrl 成功；prepareOnly 返回同样大小和 transferRequired=true | NAS 在**这个明确的自身目录根**内可准备；不代表从助手 root 能越界读 Z: |

两份文件元数据准备发生在 01:07:36–01:07:37。工作区副本通过 Get-Item 独立确认大小为 1,315,101,941 字节。本轮未重新计算 1.3GB 哈希；此前交付报告记录两者 SHA-256 相同，本轮不将其写成独立重验。

### 运行诊断的已有信息与局限

在本轮 selftest **之前**，01:03:53 状态快照的累计调用数：file-browser:remote-op=25，media:fetch=2，file-peer=6。累计拒绝：file-browser=2；media/file-peer 没有拒绝计数。

- 这是所有设备及此前自测合计，不足以将 6 次 file-peer 归属本次手机、某个 action 或某个文件。不要据此声称手机已完成握手/传输。
- 读取时 recentRefusals 已没有文件类条目；其上限 30 条对外展示，invoke success 环也会被会话轮询挤掉。
- handlerErrors=11：10 项 `invoke:maker:list-active` 超时，1 项 `user-questions-request` 远端取消；未见文件类边界异常。这不证明 peer 无失败，预期错误可成为 RPC 错误、关闭连接或在手机客户端被吞掉。
- `src/host.js:1743–1801` 的 askOf 没有记录文件 op、peer action、root/relPath；`1662–1701` 仅有通道级计数和有限环。因此既有接口不能恢复本次的 caps → fileUrl → prepare → offer/open → fallback 完整链路，也没有可用的同次 ICE/连接事件记录。

## 源码确认的交互与失因路径

以下是现有 Cindy 源码合同，**不等同于证明手机安装包正是这份构建**：

1. `apps/mobile/app/files/[sessionId].tsx:465–503`：原“导出/分享”非图片分支调用 `exportRemoteFileToUrl`，不需要寻找新直连按钮。
2. `apps/mobile/src/session/fileBrowserExport.ts:43–49`：调用 `fileBrowser.readBytes`，普通分享默认不是 stream 模式。
3. `mobileMakerTransport.ts:1209–1225`：询问 **Host** `caps.fileRead`；为真则取 `fileUrl`，并把两阶段 `exportDeviceFile` 作为 fallback。
4. `mobileMakerTransport.ts:880–909`：media prepareOnly、`tryMobilePeerFile` 与 fallback 接到共享 `readDeviceFile`。
5. `packages/device-link/src/fileAccess.ts:43–54`：需要稳定播放 URL 的 stream 分支可能跳过 transient peer；普通分享则尝试 peer，返回 null 时进入 fallback。不能把预览流与整文件分享混为一谈。
6. `peerFileTransport.tsx:173–223,247–250`：caps → ICE 配置 → WebView offer → Host answer → WebView answer → Host open → 手机空间检查 → receive。忙碌、不可用、异常等可返回 null；异常在 catch 中丢失，除了取消不会保留原错误。
7. `peerFileRegistry.ts:67–71`：手机临时文件预算要求剩余空间至少 `2*size + 256MiB`。本 APK 对应 **2,898,639,338 字节（约2.70GiB）**，并受累计临时文件 4GiB 预算约束。空间不足只是一个待验证候选，不是本次已证实原因。
8. `src/host.js:208,255–286`：旧 exportFileStart 对超过 **536,870,912** 字节返回 `OVERSIZE`，消息为 `the file is 1315101941 bytes, over the 536870912 byte export limit`。本轮**未调用**该会启动上传的操作，仅核对源码的前置拒绝。若现有截图包含这个上限/文案，就能确认最后失败是旧 export guard。若是 26,214,400，则更像旧 media 路径，不能混同。
9. `remoteMediaDiskCacheExpo.ts:21–24,43–68`：peer 的 file:// 结果走本地复制，未发现另一个固定分享大小上限；复制失败映射一般下载失败，不能据此解释现有“超限”。

## 最小下一步（只提出，不在本轮实施）

### 主助手统一补充的最少信息

先取**已有失败**的完整错误文字/截图（尤其上限数字）与大致操作时间、手机 Cindy 版本/构建号。不让用户重复1.3GB下载，不让用户重做 Host 端基础检查。若这些已有于原对话/截图，直接复用，不重复问。

### 启用/修复分支

- **现在没有“必须重启才能启用新 handler”的证据。** 不把本问题与冻结的 session-bridge 升级合并，不直接重启或重装。
- 若手机构建确实不含这条 readBytes/file-peer 路径：由主助手交 Cindy 手机开发 agent 确认最小客户端更新，不由文件交付 agent 排障，也不在这里改 Cindy 项目。
- 若构建支持：由对应 agent 优先保留 peer 的**阶段+安全错误码**（注册/WebView/ICE/answer/open/空间/receive），同时避免把 >512MiB 文件的原始 peer 失败覆盖成泛化 OSS 超限。不要记录 SDP、TURN/账号凭据或文件内容。Host 侧可另案补有界 action/状态/字节数诊断；本轮未改生产或源码。
- 后续经授权可先用极小、非敏感文件验证同手机 peer；只有协议/存储/网络链路有明确证据后再决定大文件重试。不要通过提高旧 OSS 上限绕过问题，它仍是整缓冲上传路径。

## 本报告对前序有限报告的订正

`G:/Projects/助手/docs/neonabyss-apk-direct-download-diagnosis-20260921.md` 的能力方向应改为“手机询问 Host caps.fileRead”；并且本项目确有既有运行内诊断与 selftest 入口。本轮已补上运行 handler 和正确两种路径的实际证据。未改写前序报告以保留原调查边界；新事实以本报告为准。

**最终交付状态不变：文件副本存在，但手机未确认收到；故障未宣布修复。**

## 回报回执

已用 session_manage prompt 向 `session-b19a5c27-8bc6-4ba9-a2ea-4786ba88815f` 成功提交一次报告。

- idempotency_key：`host-file-peer-apk-diagnosis-report-20260921-01`
- receiptId：`9f3e92a8336512dbc66c105510a5fc67642e84d42c92aac05f6a6dd68b3bead7`
- requestId：`assistant-35514f14-dccc-46a7-a1bf-863a76d873a0`
- admission：accepted。仅证明主助手收件队列已接纳，不等于已处理、根因已修复或手机已接收。后续等待安排，不主动重传/重启。
