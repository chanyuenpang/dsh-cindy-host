# 媒体暂存(OSS)不可分发的对象

<!-- state: current -->
## 结论

Host 把本机文件/媒体放进账号的暂存区(阿里云 OSS)时,**安装包类对象必须按不透明字节暂存**:
`ext → bin`、`Content-Type → application/octet-stream`。否则对象**上传成功、`presign-get` 也成功**,
但任何控制端 GET 它都会立刻收到:

```
400 <Code>ApkDownloadForbidden</Code>
<Message>The APK file is not allowed to be distributed in a public network using the
OSS endpoint, please use CNAME instead.</Message>
```

这是阿里云对**公网裸域名**(`cindy-prod-private.oss-cn-shanghai.aliyuncs.com`)分发移动安装包的
平台策略,与签名、ACL、key 归属、过期时间都无关。

## 两个触发条件(任一命中即被拒,实测矩阵)

| key 后缀 | 对象 Content-Type | GET |
|---|---|---|
| `.apk` / `.ipa`(任意大小写;server 会小写化) | 任意 | `400 ApkDownloadForbidden` |
| 任意 | 恰为 `application/vnd.android.package-archive` | `400 ApkDownloadForbidden` |
| `.bin` `.zip` `.exe` `.dmg` `.apks` `.txt` | `application/octet-stream` | `200` |
| 任意 | `application/zip` / `x-itunes-ipa` / 同一 apk mime 带 `; charset=binary` | `200` |

**只中性化一个是不够的**(实测:后缀改成 `.bin` 但 Content-Type 仍是 apk mime → 照样 400)。
PUT 的 `Content-Type` 头才是对象最终存下来的值,所以 POST 的 `contentType` 与 PUT 头必须一起改。

## 用户可见影响为零

key 的后缀只是暂存对象的元数据:控制端按**自己浏览到的文件名**命名本地那一份
(`apps/mobile/app/files/[sessionId].tsx` → `downloadRemoteMediaShareTemp(url, mime, item.name)`),
分享用的 mime 也取自文件名。所以装包到手仍是 `…apk`,可直接安装。

## 仍在的缺口

手机 → Host 方向若传 `.apk` 附件,key 由**客户端**申请,同样会被拒;要修得在客户端上传处做同样的
中性化,本仓 `uploadMedia` 管不到那条路径。

## 代码与证据

- 实现:`src/host-media.js` 的 `stageableStaging(ext, contentType)`,由 `createMediaUploader` 的
  两条请求(POST 声明 + PUT 头)共用;
- 判因:`download-failed` 失败原因带上对象存储错误码(如 `download-failed: ApkDownloadForbidden`),
  以前它被折叠成一个无法判因的 `download-failed`;
- 探针:`tools/probe-oss-ext.mjs`(后缀/MIME 矩阵)、`tools/probe-presign-status.mjs`(逐跳状态码)、
  `tools/probe-apk-export-roundtrip.mjs`(真实 77.2MB 包往返 + sha256)、
  `tools/export-download-link.mjs`(给用户一条可直接点的签名链接);
- 完整记录:`doc/cindy-android-verify.md` 第九节;发布:`dsh-cindy-host-demo@0.1.6`。
