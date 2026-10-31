# （产品推断已撤回）Export、手机P2P下载与大APK

> **此报告的产品判断、UI改造建议和主修owner判断已撤回，不得据此实施。** 原Cindy规则明确Mobile export/share消费统一inline→peer→OSS策略；Export并不排斥P2P。且原OSS上限为2GiB流式上传，512MiB是DSH适配限制。以 `file-peer-original-contract-alignment-20260921.md` 的原功能合同、保持/偏离/未知对照及owner为准；下文仅保留历史取证过程。

## 历史审查结论（已撤回为结论；参见上方纠正）

**当前是“手机取回电脑文件→临时文件→系统分享”的混合传输入口：底层可用peer，也可用旧电脑导出/OSS；上层统一叫导出。不是方向接反，也不是保证P2P、保证保存到手机的独立下载入口。** 用户指出的产品语义问题成立。此前让用户用原Export小文件验证P2P的建议撤回；266KB“导出完成”仅保留为用户观察，不计入大APK或peer验收，不再要求手机测试。

但也必须纠正另一个可能推论：**出现“正在从电脑导出…”不证明调用了PC旧Export任务**，因为文案在传输选择之前就显示；真正的peer分支不调用exportFileStart。仅改文案也不能修好未证实的peer链路。

## 范围、依据与版本界限

用户目标明确：手机通过P2P下载电脑已有的大APK，不以“电脑导出/分享完成”代替。此处只复核已有实现，不替用户决定保存目录、自动安装或小文件是否允许云回退，不修改实现。由原实现者本人定向取证，未委派新代理。

路径简称（以下锚点均已实际读取）：
- **M** = `G:/Projects/Cindy/apps/mobile`
- **S** = `G:/Projects/Cindy/packages/device-link/src`
- **H** = `C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src`（实际安装Host，而非dirty工作树）

Cindy HEAD为`dc294b02ca`；本次只读git状态/diff确认 `peerFileRegistry.ts`、`peerFileTransport.tsx`、`S/fileAccess.ts`仍有未提交改动。尤其“大文件不再吞掉peer错误后回退OSS”的修正是工作树差异，**未验证用户手机装载这些代码**。未读/改APK。GitNexus注册表没有本Cindy checkout（另一个Cindy-markdown-preview不能替代），故以已知路径和受限搜索取证，未刷新索引。

## 1. Android文案与入口：发生在传输选择之前

| 证据 | 代码实际行为 |
|---|---|
| M/src/i18n/locales/zh-CN/files.json:12,16 | 菜单“导出 / 分享”；进度“正在从电脑导出…” |
| M/app/files/[sessionId].tsx:935–944、1397–1404 | 菜单share绑定shareItem，不是独立P2P下载按钮 |
| 同文件:465–503 | **469行先显示通用exporting**；非图片再调用exportRemoteFileToUrl；494–497复制/下载到手机临时文件，调用expo-sharing系统分享单 |
| M/app/files/preview/[sessionId].tsx:432–449 | 同样先显示exporting，436行调用exportToUrl(..., **false**)，随后同一个临时文件+shareAsync；finally清除busyLabel |
| 同文件:371–383、506、544 | 默认预览stream=true；显式下载/分享传false。“下载原文件”最终也是downloadAndShare，不是独立持久下载任务 |

当前这两个handler没有“peer已连接”状态输入；进度不区分连接、收包、云上传、云下载、系统分享。当前files.json和这两个成功分支也没有自行弹“导出完成”的对应完成文案（浏览页清notice，预览页清busy）。用户看到的完成提示是实际观察，但不能仅凭当前源码认定它来自哪个安装版本或系统分享组件，更不能认作peer EOF。

## 2. 调用合同与请求方向

非图片APK、未命中缓存、整文件路径：

```text
手机shareItem / downloadAndShare
 → exportRemoteFileToUrl（名字含export，但本身不等于PC Export任务）
 → maker.fileBrowser.readBytes(..., stream=false)
 → 手机向所选PC发送 file-browser:remote-op {op:caps}
 → 支持fileRead时请求 {op:fileUrl, workdir, relPath}
 → 手机请求PC device-link:media:fetch {url, prepareOnly:true}
 → >64KiB返回transferRequired元数据，并未上传OSS或传输APK
 → 统一读取策略选择peer；成功返回手机本地文件；不适用/失败可能走兼容fallback
 → 手机临时副本 → 系统分享单
```

锚点：M/src/session/fileBrowserExport.ts:25–77；M/src/device-link/mobileMakerTransport.ts:862–870、874–910、1198–1225；H/host-media-fetch.js:438–455。

- 调用目标是`invoke(deviceId, channel,args)`的所选**电脑**；Android是请求方/文件接收方，PC是供数方。
- helper先按账号/设备/路径/mtime及stream模式查URL缓存（fileBrowserExport:31–34）；命中可不再发peer调用。
- peer成功由`peerMediaUri(result)`得到手机file://；小文件也可能inline；OSS结果才调用presignGet（同文件:52–76）。不能仅从helper函数名判断传输。
- ≤64KiB可直接inline；旧Host可能忽略prepareOnly并返回普通OSS/inline。`S/fileAccess.ts:45–49`对transferRequired不为true直接返回，并非每次都建peer。

## 3. peer供数路径：PC读原文件，不经过旧Export上传任务

1. 手机WebView创建ordered `files-v1` DataChannel及SDP offer（S/filePeerRuntime.ts:73–82）。
2. 手机经现有DeviceLink控制链路向PC发 `device-link:file-peer {action:offer,sdp}`（M/src/device-link/peerFileTransport.tsx:172–213）。
3. H/host-file-peer.js:179–212在PC创建werift连接，接收offer、创建answer、返回`{connection,sdp}`；25秒只管此offer处理预算。**返回answer/内部ready=true不是DataChannel连接成功。**
4. 手机应用answer并等待DataChannel open，当前共享运行时截止8000ms（S/filePeerRuntime.ts:134–160）；成功后才向PC发`{action:open,connection,url}`（peerFileTransport:213–218）。
5. PC解析文件引用、校验root/realpath/常规文件/上限；只读打开**电脑原始文件**并返回`{ticket,size,mimeType}`。H/host.js:223–224、411–416；H/host-media-fetch.js:296–346；H/host-file-peer.js:214–234。上限2GiB，不是旧Export的512MiB。
6. 手机在DataChannel发`{ticket,offset,credit:16}`；PC每块最多16KiB从FileHandle.read读取并发binary，检查size/mtime等一致性，末尾必须空二进制EOF（H/host-file-peer.js:104–146；H/file-peer-protocol.js:2–7）。
7. 手机WebView收块，经本机bridge写原生FileHandle；接收完成还检查offset=size后注册本地URI（S/filePeerRuntime.ts:163–229；peerFileTransport:221–258、350–370）。网络字节方向是**PC→手机**；WebView→原生的base64是手机内部桥接，不是把整APK塞进DeviceLink RPC。

### offer / accept / connected不要混名

- Host文件协议仅caps/offer/open/close（H/host-file-peer.js:10–17、243–252），**没有独立accept RPC**。PC的应答动作实现在offer处理器内。
- 共享S/filePeerRuntime.ts:84–133另有`accept()`，是通用RTC应答方/供数模式；此次手机取PC文件调用的是offer→answer→receive，不调用它。DSH Host用werift做对应应答。
- DeviceLink openLink、控制端授权接受、Host.status.connected都属于控制链路；不能当成文件DataChannel.connected。
- WebRTC可经ICE/TURN中继；“使用peer通道”也不能在没有selected candidate证据时宣称物理网络一定无中继。它与把文件上传OSS是不同机制。

## 4. 只有fallback才进入真正的旧电脑Export任务

**确定的旧路径**：`S/fileAccess.ts:85–121 exportDeviceFile`发exportFileStart并轮询exportFileStatus（最多30分钟，700ms轮询）。H/host.js:296–330创建job，**305行将完整文件readFile进内存、306行uploadMediaForExport上传OSS**，返回key；手机再presignGet→HTTP下载。不是打包/重建APK。512MiB guard在H/host.js:208、255–286，1,315,101,941字节不能走此旧路径。

当前选择条件：
- PC `caps.fileRead`缺失：mobileMakerTransport:1209–1216直接走旧exportDeviceFile，根本不试peer。
- 已支持fileRead：prepare未要求传输则直接返回inline/OSS；否则按`S/fileAccess.ts`策略。
- stream=true且peer结果短时或音视频：为保留预览URL走fallback（48–49）；**显式非图片整文件下载传false，所以不是APK必须走stream预览的理由**。
- peer provider未注册/不可用、caps.version不是1、超过2GiB等可能返回null（peerFileRegistry:87–93；peerFileTransport:179–184；mobileMakerTransport:905–909）。
- **HEAD基线**：手机peerFileTransport catch取消以外的异常后`return null`；共享fileAccess遇null直接fallback。ICE失败、空间不足等因此可被旧导出OVERSIZE掩盖（本次git diff精确显示这些被修改的旧行）。
- **尚在dirty工作树的修正**：peerFileTransport改为抛安全stage错误；fileAccess:54–67对>512MiB的peer失败/不可用保留错误，不再退到肯定超限的旧Export；≤512MiB仍可fallback。不能把该未核实手机部署的修正描述成已运行事实。

因此“小文件导出完成”完全可能是兼容取件成功，也可能peer或缓存成功；**本轮不判定实际用了哪种，更不把它归为peer验收**。

## 5. 历史改造建议与owner（已撤回，不得作为修复合同）

| 已确认缺口 | 最小修正方向（建议，未实施） | owner |
|---|---|---|
| 高：传输尚未选择就显示电脑导出；下载/分享/云回退共用文案，无法表达用户要的手机P2P下载 | 用明确“下载到手机”的产品动作及真实阶段；分享应是文件就绪后的后续动作，不用系统分享单完成代表下载传输完成 | **Cindy移动文件UI/下载功能owner**；M/app/files两入口及files.json |
| 高：旧策略把peer失败吞成null后进入必定拒绝1.3GB的PC Export，掩盖原始错误 | 在共享读取层收口完整文件与fallback合同；该APK不得隐式调exportFileStart。已有>512MiB错误保留修正可复用，但还须核部署，不盲补第二套传输 | **Cindy共享读取/移动peer owner**；S/fileAccess、mobileMakerTransport、peerFileTransport/Registry |
| 高：没有向业务/观测明确交付本次实际transport、连接/收包/EOF/落盘结果；拿通道RPC成功作验收会误判 | 从现有peer状态机和原生接收完成派生安全的阶段、已接收字节、结果来源；peer成功只在DC open且完整EOF/字节数/本地交付后成立，不由UI文案推断 | **Cindy peer接收及统一结果合同owner**，与Host原实现者对齐协议 |
| 中：当前终点是cache/remote-media-share临时副本+shareAsync，不是明确的下载保存终点 | 复用现有接收管线，明确手机保存/后续打开的产品终点；不要用“分享单关闭”代表大APK下载。具体保存位置/安装动作不是本轮擅定事项 | **Cindy移动下载/文件生命周期owner**；remoteMediaDiskCacheExpo及UI |

正确归属首先是**Cindy移动下载＋共享读取合同的现有负责人**（协调记录中的session-22890ccd-f7f0-4aaa-ae5e-7ef318be5e42正在改相关三文件；主助手统一协调），不是继续让用户点Export，也不是再单独重启/改Host25秒。DSH Host原实现者仍负责PC只读供数、offer答复和真实ICE/DTLS/块协议缺陷的定向配合，不能因数据流方向正确就宣称Host网络兼容性无缺陷。

**复用而非重造**：已有readBytes(stream=false)、peer源/接收器和OSS兼容分支应保留为单一读取实现；在共同合同中表达实际传输/回退政策，在UI中表达下载与分享的区别。不要为纠正文案再复制一套Host Export API或第二套RTC管线。对仍允许的小文件云兼容回退，要诚实区分，不能冒称P2P；是否自动/明确选择属产品决策，未实施。

## 风险与未知 / 建议下一步

- 手机安装版本和新SDK修正是否部署未知；当前工作树不是用户手机的运行证明。
- 已保存的8.473秒时序只支持answer/DC-open失败候选，不证明具体ICE根因；本轮未做网络、APK或手机实验。
- 当前两入口没有下载阶段合同、旧日志无action/文件身份，因此无法从266KB完成或旧OVERSIZE逆推该次APK完整路线。
- **建议主助手交现有Cindy owner先形成上述最小合同修订和部署边界说明，Host原实现者只对齐供数/信令接口。停止手机测试和Export式peer验收。本轮结论是已完成只读追踪，不是已修复或已验收P2P下载大APK。**
