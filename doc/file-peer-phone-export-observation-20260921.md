# 手机Export：用户确认266KB导出UI完成，peer传输仍未归因

> 以原功能合同为准：Export/share本来就是Cindy统一文件读取（含peer）的合法入口，不应据名称判其错误。本文仅保留UI/通道观察，UI完成不能单独判传输方式；当前不再要求用户测试。此前产品改造推断已撤回，最新对照见 `file-peer-original-contract-alignment-20260921.md`。

## 采样范围与来源

仅三次 `GET http://127.0.0.1:3080/api/dsh-cindy-host/status`：**17:32:52.818、17:35:14.278、17:36:15.392（2026-09-21，+08）**，之后停止采样。初采3080为PID48208，Host connected。未触发任何手机操作、selftest、重启或APK传输，未写生产。

窗口中全部保留的文件/peer事件来自同一 **Android-A**：原始src直接相等，SHA256(src)前12位=`4A2EA4FF62A9`。它与status.devices中**唯一在线Android controller**的deviceId精确匹配，匹配行数1；不输出原始设备ID/名称。第二次临时时间戳筛选未命中导致的sameSource=false不采用；已改用首快照原始src直接关联，第三次逐条均匹配。

## 实际事件（完成时间换算+08；同一Android-A）

| 时间 | 通道 | Host结果 | 回复字节数 |
|---|---|---|---:|
| 17:32:39.166 | file-browser:remote-op | ok=true | 258 |
| 17:32:40.454 | file-browser:remote-op | ok=true | 178 |
| 17:32:40.517 | file-browser:remote-op | ok=true | 301 |
| 17:32:40.577 | device-link:media:fetch | ok=true | 244 |
| 17:32:40.636 | device-link:file-peer | ok=true | 186 |
| 17:32:41.195 | device-link:file-peer | ok=true | 1315 |
| 17:32:49.668 | device-link:file-peer | ok=true | 162 |
| **17:32:49.725** | **file-browser:remote-op** | **ok=false, code=OVERSIZE** | 249 |

OVERSIZE同时出现在成功/失败混合调用环和拒绝环，已去重为**一条拒绝**，不是两次。全部ask=null，detail为空；没有action、文件名/大小、请求起始时刻或手机原始异常。上述bytes是JSON回复大小，不是下载文件大小。

三次快照的累计数完全不变：file-peer调用**6**、拒绝条目缺省（无已记录peer拒绝）；media:fetch调用**2**；file-browser调用**20**、拒绝**1**。handlerErrors=0、phoneDiagnostics=0。没有记录到Host file-peer的FILE_PEER_TIMEOUT。初采调用尾环仅20条，只保留其中3条peer成功记录，另外3次的完整时序/来源不能从尾环恢复；6次通道调用不等于6次导出。

**不存在独立offer/accept/open/close/timeout计数接口**；不能将通道计数改名成这些动作计数。17:24前次基线无peer条目；本次有真实Android peer请求，不再是“手机完全没走到Host”的证据空白。

## 事实与最小候选分开

**确定事实**：同一Android控制端收到多条成功peer RPC回复，之后文件浏览器被Host以OVERSIZE拒绝。UI“正在导出”消失不能据此判成功，更不能宣称DataChannel建立或收到文件。日志没有文件身份，无法把这条OVERSIZE直接绑定到用户口述的小文件，也不能擅自说用户操作的是1.315GB APK。

**有代码锚点的候选**：1315字节成功回复 → **8.473秒**后162字节成功回复 → **57毫秒**后OVERSIZE。大小/顺序与caps→offer答复→失败清理close→旧导出fallback吻合，但action未记录，因此仍是推断：
- 当前Cindy源码 `packages/device-link/src/filePeerRuntime.ts:134–160`：应用answer后等DataChannel open，**8000ms**截止。
- `apps/mobile/src/device-link/peerFileTransport.tsx:198–218`：Host offer返回后才执行本地command(answer)，完成后才Host open；273–279失败清理会发Host close。
- 安装Host `host-file-peer.js:246–252`：caps返回version/maxBytes、offer返回answer、close返回ok:true，三种回复形状与本窗口大小相容，但不能替代动作日志。
- 安装Host `host.js:285–286`：旧文件导出路径存在512MiB OVERSIZE guard。若本条确为该fallback拒绝，则需核所选文件身份/大小；本采样没读取文件内容或路径。

这将下一定位点收窄为**手机answer/ICE/DataChannel-open阶段或其失败清理**，而非直接判定Host25秒offer截止又失败。未获得手机实际版本/原始异常，不能将8.473秒的回复间隔等同于已证实的手机8000ms超时，也不能盲加超时。

## 下一步（不要求重新点击）

1. 主助手将本时序与用户已发生操作的时间、已有文件名/显示大小对齐；如需核对，只收已有描述/截图，不重试、不重传。明确保留“小文件”与OVERSIZE尚未关联的矛盾。
2. 将8秒answer/open候选交Cindy现有改动所有者核对；优先查手机**现有安装/已有**安全错误或WebView/ICE状态记录是否能还原该窗口，不把新Android包设成前置。本Host现有API不能补出action/ICE状态/手机异常；不可伪造。
3. Host25秒修复的静态装载结论保持；当时尚不能通过peer专项验收。这不否定用户随后补充的UI完成结果，最终分项判定见下。未改生产、未触发手机、未要求用户重复点击。

## 用户确认266KB完成后的最终只读归因（17:41–17:42）

用户补充：原Export的**266KB小文件已显示“导出完成”**。记录为用户确认的UI结果；手机确切显示时刻未提供，下面时间是Host采样时刻，不能混同。

本轮仅两次既有GET，均为2026-09-21 +08：

| 采样时间 | peer calls/refusals | media calls | browser calls/refusals |
|---|---|---|---|
| 17:41:18.118 | 6 / 无拒绝条目 | 2 | 20 / 1 |
| 17:42:39.572 | 6 / 无拒绝条目 | 2 | 20 / 1 |

- 与17:36最后基线相比，以上计数**全部增量0**。PID仍48208，Host状态connected；这只是DeviceLink Host在线，不是peer.connected。
- 当前文件相关保留事件仅剩**17:32:49.725**的file-browser:remote-op、ok=false、code=OVERSIZE、ask=null、bytes=249，来源指纹仍 **4A2EA4FF62A9 / Android-A**，状态目录仍匹配android。此前peer成功事件已离开20条调用尾环，但已保存在本文前表；不能因现在看不到它们就否定曾有调用。
- handlerErrors从0变1，安全字段为**17:38:25.517，where=invoke:maker:list-active，timeout类别**；不属于peer/file-browser/media通道，不将其归因为本次文件失败。未输出原始message/stack。phoneDiagnostics仍0。
- 完成窗口没有新增同手机peer调用或已记录peer拒绝/FILE_PEER_TIMEOUT；接口本就没有独立offer/accept/connected/open/close/transfer-complete计数。
- **没有明确fallback字段或OSS标记**；不能从media调用2、旧OVERSIZE、UI完成或计数不变断言266KB走了OSS，也不能据此断言走了peer。现记录不含文件名/大小/动作，旧OVERSIZE仍不能强行绑定266KB文件。

### 可决定任务状态的结论

| 子项 | 判定 | 证据层级 |
|---|---|---|
| Host25秒补丁落盘及重启后静态装载 | 已完成 | 前次PID48208、after hash及静态链核验 |
| 用户执行原Export，266KB显示导出完成 | **可完成此UI/用户动作子项** | 用户明确报告；不等同字节完整性校验 |
| 同一266KB文件经peer建立并完整接收 | **未证实，不能完成peer专项验收** | 有历史Android peer RPC，但无可归因connected/transfer-complete证据 |
| 266KB明确OSS fallback | **未证实** | 无直接fallback/ossKey标记，不靠时序猜测 |
| 原1.315GB APK传输成功 | **未验收** | 本轮未触发或传输 |

下一步：主助手可勾掉“用户尚未进行手机操作/尚未见UI完成”，不要再让用户重复点击；保留**技术侧peer归因**为待办，由Cindy现有所有者检查同一操作已存在的安全阶段/完成记录，尤其此前8秒answer/DC-open候选。没有可关联记录就保持“未证实”，不要改称“peer成功”或“确定fallback”，也不以新Android包/重传APK为前提。本轮仅GET和已有快照分类，未写生产、未重启、未触发任何手机动作。
