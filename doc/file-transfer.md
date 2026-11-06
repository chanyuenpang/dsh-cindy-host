# 手机文件直传（0.1.10 起）

## 能力与边界

DSH Host 对接 Cindy 已有 `device-link:file-peer` / `files-v1` 协议。手机端需要包含该能力的版本；无需开启远程桌面画面，文件通道也不复用视频/键鼠通道。

- **电脑 → 手机整文件下载**：最多 **2 GiB**。64 KiB 及以下（含空文件）经授权后内联；更大的文件优先走独立 WebRTC DataChannel。
- ICE 从现有 Cindy 认证接口获取短期 TURN 配置，尝试可用直连或中继；接口不可用时与 Cindy 一样回退公共 STUN。不是保证所有网络都能直连。werift 当前选择配置中的首个可解析 TURN，不具备浏览器完整的多服务器竞速策略。
- **0.1.11 起**，手机文件浏览器两阶段 OSS 导出兜底支持 **2 GiB（含边界）**及调用方更小的maxBytes。Host以64 KiB分块/背压上传，无10分钟总上传截断，但有阶段/无进展时限；手机原30分钟轮询预算不变。聊天媒体旧路径仍限25 MiB。OSS是云端中转，不是P2P直连。
- 手机上传附件仍为旧流程（默认 20 MiB）。本轮**没有新增上传方向、持久断点续传、嵌套 SSH 文件导出或 >2 GiB 支持**。

该能力随 0.1.10 发布；本地必须更新到此版本并重启原 DSH Web，不能以另开服务器代替生效。

## 数据流与安全

1. 手机 `remote-op caps.fileRead` → `fileUrl`；Host 只接受本机绝对 workdir 和相对 relPath。
2. `media:fetch prepareOnly` 与 peer `open` 共用本地文件 resolver：与 Cindy 原生取件一致，目录约束可选；提供 `baseDir` / `workdir` 时执行 realpath containment，未提供时接受绝对文件路径。敏感路径 denylist、常规文件校验仍生效；URL 的 maxBytes 只能收紧上限。
3. Relay 认证的 `Envelope.src` 是唯一设备身份。`caps/offer/open/close` 仅传授权和信令；文件内容走 `files-v1` 的可靠有序二进制块。
4. Host 用连接绑定的随机 ticket，严格连续 offset 与每次 16 块信用。每块最多 16 KiB，按文件句柄读取，零长度二进制块作为 EOF；不将大文件整份读进内存。
5. 源文件 stat/句柄身份变化会终止；这是元数据变更检测，**不是密码学内容快照**。单连接同时一个文件，全 Host 最多四连接，60 秒无进展关闭。
6. 撤销设备、设备离线、link-close、Relay 断开、关闭手机连接、Host stop 都使相应连接立即失效，随后释放文件句柄/RTC/定时器；迟到的异步结果不得恢复连接。取消和授权拒绝不能通过其他入口绕过权限。

现有读取权限仍沿用本项目“同 Cindy 账号且未撤销的控制设备”合同；本次没有放宽成匿名下载接口，也不把 SSH 引用猜成本机路径。

## 图片预览（0.1.39；安装与真机分别验收）

- 项目列表 `thumbnail` 已提供 256px / q70 WebP，最多 48 MiB 输入、4000 万解码像素、128 KiB 输出；共享两路解码并发与 5 秒软时限。软超时不代表原生工作已取消，槽位要等真实结束才释放。读取前后验证文件身份/版本、workdir realpath 与敏感路径边界。失败保留 `THUMB_*` 占位，不阻断独立原图入口。
- 工具结果的原生图片块派生为 Cindy 已有 `xdt_image_urls`，助手原生图片派生为 Markdown 引图；用户原有附件链路不变。仅接受 `xdt-image://dsh-attachment/v1/...` 受限命名空间，每次从可见源会话的原始消息重建完整原生 descriptor，再交原生附件服务读取并核对内容 hash/大小。JSON 内的 `image` / `original` / `localPath` 文字本身没有取图权限，不会被自动上传。
- 聊天缩图最长边 1024px / q80，700 KiB 以内内联；不能缩图时仅 512 KiB 以内原件可内联，其余按需走既有 OSS staging，原图上限保持 25 MiB。原生 MIME 不依赖文件扩展名。传输缓存按内容及连接/source 代次隔离，重复取件合并，`skipCache` 重建传输对象；缺源不重新生成、不回退读取本机路径。
- 首次历史、work details 与实时消息共用确定性投影，不把源图片字节塞入历史帧。未改 Cindy；源码实现、发布、实际激活和配对版本真机验证必须分别确认。Cindy Markdown **文件阅读器**内项目相对图片的接线缺口不在此 Host-only 修复范围。

## 运行时与维护门禁

运行依赖固定为 `werift@0.24.4`（纯 Node，Node >=22），仅请求 peer 时延迟加载，不引入 Electron。该版本直接发送空 Buffer 会消费 SCTP 序号却不发 DATA，使 Cindy EOF 和后续文件卡住。`src/file-peer-rtc.js` 对空包使用同一发送队列、PPID 57 和一个忽略字节，保持顺序及缓冲计数。

**这个小适配依赖固定版本的内部 API**。升级 werift 必须重新跑真实浏览器验收，尤其“EOF 后再传文件”；不能只凭模拟单测升级。`--native-empty` 可复现上游缺陷，不是通过型测试。

## 验证

实现阶段的[完整 Host 回归](<../artifacts/image-preview-tests-verified.log#L1326-L1331>)为 1237 项、1229 通过、8 项可选集成跳过、0 失败，并记录过 Electron 原生 codec 的 PNG/JPEG → WebP 验证。0.1.39 发布门禁另启用实际 DSH 0.2.1-rc.5 Cordis/UserQuestions/Gateway 契约并补充原生可选图片名称兼容回归：1234 通过、4 跳过、0 失败。91 文件固定包在全新隔离 profile 通过 30 项运行检查，并经真实 HTTP `thumbnail` 调用分别将生成的 PNG/JPEG 解为 256×144 WebP（宿主 sharp 0.35.5），不是注入的模拟 codec。当前有界通道审计为 259 项、75 服务、184 明确拒绝、0 未分类；新增的 companion-live/setup-snapshot/setup-transfer 仅补充准确拒绝分类及回归，未启用业务功能，不代表全协议覆盖。原生附件 staging 的真实云端/手机链路和真机显示仍需独立验收。

```powershell
npm test
npm run test:file-peer
# 需要相邻 Cindy 源码、playwright-core 和已安装的 Chromium/Edge/Chrome：
# 可覆盖 CINDY_SOURCE_ROOT / PLAYWRIGHT_CORE_PATH / CHROMIUM_EXECUTABLE
npm run smoke:file-peer
npm pack --dry-run
```

真实 smoke 使用 Cindy 原始 `filePeerRuntime.ts` 接收器、产品 Host manager/resolver/RTC adapter 和临时磁盘 source/sink，不使用 Cindy 账号或用户文件。为避免 werift 对 `iceServers: []` 隐式回退 Google STUN，Node 测试端显式指定 localhost STUN。脚本有硬超时，结束清理浏览器、连接和临时文件。

已在 Node 24.12.0、werift 0.24.4、Edge Chromium 151.0.4129.59 验证：空文件、1B、16KiB、256KiB、跨批次文件以及两次 32MiB+37B，源文件与接收落盘 SHA-256 一致，同一个 peer 顺序复用。单测覆盖路由/身份伪造、越权路径、信用/偏移、文件变化、撤销/迟到结果、连接上限、闲置清理和旧 OSS 语义。

**0.1.11补充验收：**本地真实HTTP完成2 GiB以及约11分钟持续流式上传；真实约1.3 GB文件经OSS上传完成，用户确认手机下载成功。Host有界任务/账号归属/取消清理、显式登录与旧connect竞态已有定向回归。

**仍未确认：**实际手机P2P未建立的原因、前后台行为、跨NAT和公网TURN UDP/TCP/TLS、2 GiB手机整链路、手机端独立hash/安装/系统分享。本次不修P2P，不将OSS成功称为直传成功。

通道审计将当前未实现的远端模型收藏 get/apply/changed 和下一条输入预测明确分类为不支持；分类不代表实现这些功能。
