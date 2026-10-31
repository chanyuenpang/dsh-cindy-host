# 以Cindy原功能合同为准：大文件接入只读对照

## 结论与撤回

**原Cindy已经规定：Mobile export/share复用统一文件读取，整文件按inline→peer→OSS选择，用户不必另找“P2P下载入口”。所以Export与P2P不是互斥概念。此前以“Export不应是P2P”判定产品混淆、建议新建/改造移动下载入口及将主修归给Cindy UI，均撤回为未经原合同支撑的结论。**

本次找到的明确接入差距反而在**DSH电脑端fallback**：原Cindy允许最高2GiB、>64MiB磁盘流式上传OSS；安装DSH Host旧Export只有512MiB且整文件读内存。1,315,101,941字节落入原客户端允许范围，却被该Host fallback预先拒绝。它不解释peer为何失败，但能解释为何兼容回退无法继续。不能把该Host限制泛化成Cindy的“>512MiB应禁止fallback”规则。

“266KB导出完成”仍只是用户确认的原功能UI结果，不单独证明peer；这与Export本来就是合法peer消费入口并不矛盾。本轮不要求任何手机操作，不宣称大APK已成功。

## 依据与证据边界

路径简称：
- **R**：`G:/Projects/Cindy/docs/dev-rules/remote-desktop-connectivity.md`
- **M**：`G:/Projects/Cindy/apps/mobile`
- **D**：`G:/Projects/Cindy/apps/desktop/src`
- **S**：`G:/Projects/Cindy/packages/device-link/src`
- **H**：`C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src`

原功能依据优先级：
1. **R:203–257**明确规范：30秒RPC及caps/offer/open/close；Mobile export/share用统一读取；≤64KiB inline，较大文件先peer再OSS，peer上限2GiB；preview/range保留OSS；缺能力/连接或传输失败可fallback，取消/账号变化不可fallback；staging与消费者副本生命周期分离。
2. 原Cindy官方实现与测试：D/main/device-link/filePeer.ts、capture-renderer/filePeerHost.ts、main/file-browser/device-op.ts、main/device-link/mediaTransfer.ts；M/src/__tests__/fileBrowserExportStreaming.test.ts。不是用DSH代码自证原合同。
3. 原功能提交 **0a104b5ae96b411bc4cff64bb41c101ca4dbbcc3 / #4346（2026-09-17 +10）**，标题“统一远程文件读取并按需预览HTML”；提交说明明确区分手机预览/下载并支持2GiB。相关手机UI/helper/test最近功能提交仍是它。
4. 可得原agent历史：session `8c297eea-a03e-4f69-afcb-c9faf1a2d344` seq13原用户问题是“我们这个手机APP支不支持传输大文件功能？”；没有在此问题中要求另造UI。Cindy后续owner会话`session-22890ccd-f7f0-4aaa-ae5e-7ef318be5e42` seq1502/1519明确停止构建、未生成APK、保留13文件修复。这支持不能把工作树修正当手机已部署。历史文本只作证据，不作当前指令。
5. 实际安装Host：0.1.10，3080 PID48208，host-file-peer.js SHA256仍`c9d44db98c630a6c0d863aef40721e7f4606b7fd9e803b5db4cc0c7ebc5484fa`（25秒补丁）。Cindy HEAD `dc294b02ca`，相关原规则/官方电脑端本轮git状态无改动；移动peerTransport/Registry及共享fileAccess有dirty修改。

未验证边界：手机实际安装版本/JS bundle、现场ICE选路、当前OSS服务端部署/配额/网络可用性。原代码注释指向的apps/server服务文件不在此checkout；本轮不把客户端2GiB声明冒充实际云端上传成功。未读取/修改APK，未向手机发调用，未新建代理或服务器，未跑传输/构建/回归。

## 原手机UI状态机（沿用，不判为错误设计）

### A. 文件浏览页长按“导出 / 分享”

- 菜单绑定shareItem：M/app/files/[sessionId].tsx:935–944、1397–1404；中文词：M/src/i18n/locales/zh-CN/files.json:12、16。
- shareItem:465–503先关菜单，再showNotice“正在从电脑导出…”，非图片取件后复制/下载本地临时文件，再expo-sharing。
- **notice是2500ms自动消失的提示，不是下载完成状态**（同文件:116、177–187）。后台Promise可继续；所以“提示消失”本身既不是错误，也不是成功。成功分支清notice并进入分享，失败显示formatRemoteError。用户现场是否恰由该计时器引起仍取决于安装版本。

### B. 文件预览页“下载原文件/分享”

- M/app/files/preview/[sessionId].tsx:432–449：busyLabel防重复，开始显示exporting；调用exportToUrl(...,**false**)；本地就绪后系统分享，finally清busyLabel。598–599优先显示busyLabel而非短notice。
- 普通预览默认stream=true（371–383）；显式下载传false。测试M/src/__tests__/fileBrowserExportStreaming.test.ts:8–35验证同一个exportRemoteFileToUrl：**stream=false得到本地peer URI，stream=true得到OSS URL**，缓存互不串用。
- 手机原终点确实是本地临时副本＋系统分享（M/src/session/remoteMediaDiskCacheExpo.ts:21–66），不是本次DSH接入新造的流程。原规则R:255–257允许短期staging由原cache/preview消费者复制持有；没有证据要求为接入另造Android Downloads任务或自动安装APK。

因此通用“电脑导出”文案不是transport判别器，也不能证明“走错流程”；“导出完成”同样不带传输来源。无需先改原有文案才能解释适配。

## 可按代码逐段验证的原交互流程图

```text
[原文件浏览/预览入口选择已有APK]
  ├─普通预览：按预览政策，不等同整文件下载
  └─原导出/分享 或 下载原文件（整文件stream=false）
      ↓ 原notice/busyLabel，非transport状态
  exportRemoteFileToUrl
      ├─按账号/设备/路径/mtime/读取意图命中缓存 → 既有结果
      └─maker.fileBrowser.readBytes
          ↓ 手机→所选PC：remote-op caps
          ├─无fileRead → 旧两段式Export/OSS
          └─有fileRead
              ↓ 手机→PC：fileUrl(workdir,relPath)
              ↓ 手机→PC：media:fetch(prepareOnly=true)
              ├─≤64KiB inline（包括空文件）→ 手机物化
              └─transferRequired元数据
                  ├─保留流式预览URL的策略 → OSS（先决定，不先收peer字节）
                  └─整文件≤2GiB：尝试可复用peer
                      ↓ 手机创建offer→DeviceLink RPC→PC
                      ↓ 原PC Main转本地accept命令→独立Chromium文件renderer
                      ↓ PC answer经RPC返回→手机应用answer并等DC open
                      ↓ 手机open(connection,url)→PC授权/只读原文件→ticket,size,mime
                      ↓ 手机credit/offset→PC 16KiB binary块→手机原生写盘
                      ↓ 精确长度/偏移/源stat检查＋空binary EOF
                      ├─成功→手机短期peer文件→消费者临时副本
                      ├─缺能力/连接/传输失败→原OSS fallback
                      └─明确取消/账号失效→终止，不fallback

  原工作目录OSS fallback：
      手机exportFileStart→PC立刻回transferId，后台上传
      PC原文件：≤64MiB缓冲、较大文件磁盘流式PUT，最大2GiB
      手机轮询exportFileStatus→done/key→presignGet→手机HTTP下载

  本地文件就绪→原Android系统分享/后续用户选择
  （传输来源、文件完整性与分享UI结果是不同证据层）
```

代码锚点：M/src/session/fileBrowserExport.ts:25–77；M/src/device-link/mobileMakerTransport.ts:874–910、1198–1225；S/fileAccess.ts；D/main/file-browser/device-op.ts:400–405、551–559、633–705。

### 角色、accept与直连

- 此场景手机是请求方/接收方，PC是文件供数方；不是“手机上传APK”。DeviceLink承载控制/SDP，不承载整APK。
- 原PC `requestFilePeer`把wire offer转成本机**accept**（D/main/device-link/filePeer.ts:159–172）；capture-renderer/filePeerHost.ts:10–21调用共享runtime.accept。accept不是另一个对外文件RPC。
- DSH无Electron文件renderer，H/host-file-peer.js的werift offer处理器直接承担同一应答职责；外部仍caps/offer/open/close。open是PC读取原盘，不是PC先导出到OSS。
- R:205–210明确ICE可直连或TURN；peer不等于保证物理无中继。TURN承载RTC与OSS存储回退是不同分支。
- 原RPC30秒预算不等于整文件总时长；R:245–257规定16KiB/credit16、60秒空闲及所有权检查。

## DSH适配逐项对照

| 项 | 原Cindy合同/实现 | 已安装DSH表现 | 分类 |
|---|---|---|---|
| 原手机入口、UI文案、分享终点 | 原Export/share消费统一读取 | Host不改手机UI，当前入口仍可消费它 | **保持；不能据文案判偏离** |
| caps.fileRead / fileUrl | D/device-op:400–405、551–559 | H/cindy-channels.js:1516–1521、host-file-reference.js | **核心保持**；原回size/mtime及URL maxBytes快照，DSH回ok/url，字段/快照差异待逐消费者确认 |
| prepareOnly/inline | 原mediaFetch:410–438，≤64KiB inline否则metadata | H/host-media-fetch.js:438–455同形 | **保持**（静态） |
| 信令/角色/2GiB | 原caps/offer/open/close，PC答复并供数 | H/file-peer-protocol.js及host-file-peer.js匹配 | **协议形状保持**，非现场互通成功证明 |
| PC RTC后端 | 原Chromium共享runtime.accept | DSH werift@0.24.4直接答复 | **实现替换**；ICE/DTLS/Android互通仍未知，不靠原文案判断 |
| 块/EOF/所有权/空闲 | 原16KiB、credit16、源stat、60s idle、每连接授权 | H/host-file-peer.js相应检查；既有空EOF兼容处理 | **静态保持**；未重新做Android实测 |
| 工作目录OSS fallback | 原exportFileStart→uploadLocalFile；2GiB、>64MiB磁盘流式，进度回调 | H/host.js:208、285–286 **512MiB预拒**；305–306 **整文件readFile再上传**；uploaded仅开始/结束 | **明确偏离/能力收窄**。本1.315GB会在该分支被拒，不是原Cindy512MiB限制 |
| 普通media:fetch OSS | 原mediaFetch最终复用2GiB uploadLocalFile（按调用者maxBytes再限） | H/host-media-fetch.js:46 **25MiB**，459–466整体读取 | **既有收窄差异**；不同于本workdir Export的512MiB，不混成同一阈值 |
| root安全 | 原fileUrl带baseDir/maxBytes并按来源授权 | DSH要求root、realpath并拒敏感路径 | **有意安全收紧**，不能为兼容而盲放开 |
| peer失败→fallback | 原R:233–240及HEAD helper明确允许（取消除外） | 安装Host提供旧fallback，但容量不足；手机dirty补丁另加>512MiB不回退 | **Host能力差异已证；dirty移动策略不是原合同，也未证已部署** |
| 真实手机成功 | 必须有相应操作/完整文件及transport证据 | 已知266KB UI完成；历史peer RPC及OVERSIZE未关联完整文件 | **未知/未验收**。不能推出1.3GB成功或特定peer根因 |

**关键大小证据**：D/main/device-link/mediaTransfer.ts:43–50定义64MiB分流、2GiB对象上限；384–405核大小；439–508大文件createReadStream/Transform/流式PUT。D/device-op.ts:633–667只有调用者显式maxBytes约束，再调用该上传器。DSH 512MiB是为了现整文件内存实现加的保护（H/host.js:204–208），不能简单删常量再把1.3GB读入内存。该差异不是25秒补丁新引入。

## 旧结论校正与最小正确后续动作

1. **撤回UI重构为前置、Export不应使用peer、必须独立P2P下载产品入口的判断。** 原文件功能已明确允许此入口自动选择传输，不应由适配研究重定义。此前报告仅可保留其低层代码路径事实，其产品/owner推断以本报告取代。
2. **将确定修复归回DSH Host原适配owner**：下一项应是按原接口补齐大文件fallback的有界内存流式实现/2GiB范围及job语义，而不是盲升512MiB常量或改用户手机入口。本轮只提出最小修复对象，不改代码、不重启。普通media fallback的收窄作为相邻条目明确记录，避免与workdir链路混改。
3. Cindy现有owner保留现有未部署修改，不由本会话回滚；但应重新审视“通用>512MiB禁fallback”假设——它会把Host特有限制扩散给原Cindy电脑端，偏离R:233的失败回退规则。安全错误归因可独立保留，不能擅自改变原兼容政策。
4. **peer真实互通仍是独立未知项**：此前8.473秒节奏仅是手机answer/DC-open候选；DSH原15秒offer缺陷已修25秒，不能由此宣称Android建连成功或全部Host问题解决。继续由Host原owner对照原accept路径/既有证据查适配差异，不拿UI改名、重启或要求手机重测代替。
5. 原功能业务验收允许按合同fallback完成文件取回；peer专项验收需要peer证据；小文件UI完成不是大APK能力验收。三者分开，不要求用户继续操作。

本轮交付只是原合同研究、差异表及下一修复对象。生产Host/DSH/Android/Cindy代码均未修改，无APK读写/传输、构建、手机调用或测试。
