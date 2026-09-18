# Cindy 安卓包验证交接:device-link「对端方向静默」修复

> 状态(2026-09-18 16:12):**APK 已构建完成并校验,放在下载文件夹**;剩下的只有真机验证。
> 背景结论见 [`.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`](../.claw/truth/dsh-cindy-host-mobile-resume-limitation.md);
> 上游 issue:[makecindy/cindy#4634](https://github.com/makecindy/cindy/issues/4634)(含本次补充的证据评论)。

## 一、要验证什么

**现象**(2026-09-17 实测):安卓版 Cindy 在「挑照片 / 短后台 → 回前台」后,device-link 的**对端→手机方向**整条哑掉,
手机每秒重试同一个读、**2.5 分钟不恢复**,只有**重启 App**才恢复。

**根因**(已定位):手机端所有活性判据量的都是「手机↔relay」——`pong` 由 **relay 自己应答**
(`scripts/device-link/relayFixture.ts:85-86`,全仓没有任何一端发 `pong`),所以 relay 每 10s 的 pong 让手机那条
「20s 内任意入站帧就清零」的半开检测(`packages/device-link/src/client.ts:1913-1945`,关键在 `:1918-1919`)
**永久失明**;唯一会主动探测并重建的 `notifyNetworkChanged` 又被 `:860` 的「任意入站帧即证明可达」早退挡住。

**修复**(分支 `fix/mobile-peer-silence-probe`,commit `eadedb8d5`,3 个文件,+292/−2):新增 opt-in
`peerSilenceProbeMs`——只有带 `src` 的 routed 帧算「对端还在说话」;同一 peer **连续两次**请求超时且对端持续静默
→ `restartConnection`;relay 已判 `DEVICE_OFFLINE` 时不介入;同窗口限速一次;回前台探针改以对端活性为可达
证据,并要求已存在超时证据(避免把长执行通道打成失败)。手机端开启 `20_000ms`。

**判定标准**

| | 修复前 | 修复后(期望) |
|---|---|---|
| 日志 | 反复 `device-link request timeout`,**没有** `peer silence detected` | 两次 `device-link request timeout` 后出现 **`peer silence detected, forcing reconnect (peer=…, silentForMs=…, pending=…, timeouts=2)`** |
| 行为 | 界面一直转圈,杀 App 才恢复 | 新 socket + `link-open`/`link-accept`,**~30 秒内自愈**,不需要杀 App |

## 二、现在的状态:APK 已打好

| 项 | 值 |
|---|---|
| 文件 | `C:\Users\chany\Downloads\Cindy-Verify-0.1.0-arm64-v8a-308b4badc.apk`(77.2 MB) |
| 包名 | `com.xd.cindycn.verify`(与商店版 `com.xd.cindycn` **可同机并存**,不必卸载重登) |
| 桌面名 | **Cindy Verify**(刻意改的:`android/app/src/main/res/values/strings.xml` 的 `app_name`;避免与商店版同名分不清) |
| 版本 | versionName 0.1.0 / versionCode 1;compileSdk 36 / targetSdk 36 |
| ABI | 仅 `arm64-v8a` |
| 签名 | Android Debug keystore,APK Signature Scheme v2(自签测试包;同签名同包名可直接覆盖安装) |
| SHA256 | `8F1B73D9E8C1E4F541D5ED9F127F561CCA59CA26F185D26FF9B201E09103CA5A` |
| JS | 已内联 `assets/index.android.bundle`(17.3 MB)→ **真机不需要 Metro、不需要 adb reverse** |

> **版本要点(2026-09-18 16:32,commit `308b4badc`)**:第一版(commit `eadedb8d5`)的触发条件
> 要求「同一 peer 连续两次请求超时」,而回前台后 App 往往**只发一轮请求**,连续计数永远到不了 2;
> 回前台探针那条路又额外要求「已存在超时证据」——两条路都不会重建,所以装了第一版也**不会恢复**。
> 本版改为:**探针超时本身即证据**(提示之后一个对端帧都没来)+「有**短超时**业务请求在等回包」
> 就重建;长执行通道靠"它的超时是分钟级"排除。已从包内回读确认新逻辑在场。


**已核对包内容**(从 APK 里回读,不是推测):
- 修复代码在包里:`peerSilenceProbeMs` / `peerSilenceProbeEnabled` / `shouldRebuildForPeerSilence` /
  `peer silence detected` / `without peer silence evidence` 各命中 1 次;
- 区域正确(**cn**):bundle 内含 `https://hotfix.cindy.com.cn/cindy`(`cindy.com.cn` 共 14 处、
  `cindy.app` 17 处),所以它能连到与本机 Host 同一套 relay(`wss://device-link.cindy.com.cn`);
- `aapt2 dump badging` 与 `apksigner verify` 均通过。

**安装**:手机开 USB 调试后

```powershell
adb devices
adb install -r C:\Users\chany\Downloads\Cindy-Verify-0.1.0-arm64-peer-silence-fix-eadedb8d5.apk
```

或直接把 apk 传到手机点安装。装好后桌面上会出现 **Cindy Verify**(与原来的 Cindy 并存)。

## 三、真机验证步骤

1. 打开 **Cindy Verify** → 用同一账号登录(微信/Google 登录可能因包名+签名校验失败,改用手机号/邮箱);
2. 设备列表里应出现本机 Host(DSH 那台),进会话;
3. **复现**:挑一张照片发出去(系统选择器必然把 App 切到后台)→ 回前台,看界面是否卡住;
4. 同时抓日志:

```powershell
adb logcat -s ReactNativeJS:V | Select-String -Pattern 'device-link|peer silence|request timeout'
```

**判定**:
- 出现 `peer silence detected, forcing reconnect (peer=…, silentForMs=…, pending=…, timeouts=2)`
  且随后 ~30 秒内界面恢复 ⇒ **修复生效**;
- 只有 `device-link request timeout` 反复出现、没有 `peer silence detected` ⇒ 判据没被满足,带回
  `silentForMs` / `pending` / `timeouts` 的实际值;
- 仍 2.5 分钟不恢复且必须杀 App ⇒ 与修复前一致;若同时看到 `heartbeat lost, forcing reconnect`
  (socket 真被判死重建过),说明缺口在重建后的 link/订阅恢复路径,方向要换。

**复现不出来时**:把这段时间的 `device-link` 日志整段带回,再区分「没触发」与「触发了但没自愈」。

## 四、环境:本机已装好

| 组件 | 位置 | 版本 / 说明 |
|---|---|---|
| JDK | `G:\dev\jdk` | Temurin 17.0.20.1 |
| Android SDK | `G:\dev\android-sdk` | platform-tools(adb 37.0.1)、platforms/android-36、build-tools **35.0.0 与 36.0.0**(Expo 实际用 36)、cmake/3.22.1、ndk/**27.1.12297006 与 27.0.12077973**(RN core 用前者、`expo-updates` 要后者) |
| Gradle 分发包 | `G:\dev\android-tools\gradle-9.3.1-bin.zip` | wrapper 指向本地文件(见坑 2) |
| 用户级 Gradle 配置 | `C:\Users\chany\.gradle\init.gradle` + `gradle.properties` | 镜像重定向 + 超时/重试 + `android.builder.sdkDownload=false`(见坑 1、3) |
| 下载缓存 | `G:\dev\android-tools\*.zip` | 上面所有包的原始 zip |
| 区域配置 | `G:\Projects\Cindy\apps\mobile\scripts\self-host-regions.json`(gitignored) | cn 的 `androidPackage = com.xd.cindycn.verify` |
| dev 端点占位 | `G:\Projects\Cindy\config\endpoint.dev.json`(gitignored) | 从 `.example` 复制;见坑 7 |
| 构建产物 | `G:\Projects\Cindy\apps\mobile\android\app\build\outputs\apk\release\app-release.apk` | 与 Downloads 里那份同源 |

**每次构建前设置**(本机刻意不改系统级 JAVA_HOME / ANDROID_HOME):

```powershell
$env:JAVA_HOME='G:\dev\jdk'
$env:ANDROID_HOME='G:\dev\android-sdk'
$env:ANDROID_SDK_ROOT='G:\dev\android-sdk'
$env:PATH="G:\dev\jdk\bin;G:\dev\android-sdk\platform-tools;$env:PATH"
$env:EXPO_PUBLIC_CINDY_AUTH_REGION='cn'
$env:EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL='https://hotfix.cindy.com.cn/cindy'
$env:EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL='https://hotfix.cindy.app/cindy'
$env:CINDY_USE_LOCAL_REGION_CONFIG='1'
$env:NODE_ENV='production'
```

## 五、重新出包:实测跑通的完整配方

> **一条命令(推荐)**
>
> ```powershell
> pwsh G:\Projects\DSH-cindy-host\tools\build-cindy-verify-apk.ps1               # 含 prebuild(改了原生配置/依赖时用)
> pwsh G:\Projects\DSH-cindy-host\tools\build-cindy-verify-apk.ps1 -SkipPrebuild # 只改 JS/资源,实测 28 秒
> ```
>
> 脚本做的事:环境变量 → **依赖与锁文件一致性检查**(不一致直接报错并给出修复命令)→ 补齐
> `config/endpoint.dev.json` 与 `self-host-regions.json` → prebuild(可选)→ **重新打 4 处补丁**
> (wrapper 指本地 Gradle、内存 8192m/4096m、短 staging + unity build、桌面名 Cindy Verify)→
> 清掉旧的 autolinking → `gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2` →
> `aapt2` / `apksigner` 校验 → 拷成 `Cindy-Verify-<version>-<abi>-<commit>.apk` 到下载文件夹并打印 sha256。
> 已实测:28 秒,产物 sha256 与已验证那份逐字节一致(`9CA3E555…`)。

> **要快,先做这三步(本次的教训:不做这些就要用 2–17 分钟一轮的构建去撞)**
> 1. `pnpm install --frozen-lockfile --ignore-scripts` —— 这台 checkout 曾经装着 RNGH 3.0.2 而锁文件是
>    2.32.0,后续所有失败(缺 `Swipeable` → 缺 `endpoint.dev.json` → 旧 autolinking)都是它的连带后果;
> 2. 先只跑一次 `expo prebuild`,然后**从生成工程里读出全部要求**:`buildToolsVersion`、两个 `ndkVersion`
>    (`node_modules/react-native/gradle/libs.versions.toml` 与 `expo-updates` 的报错)、gradle wrapper 版本 ——
>    一次性把 SDK 包装齐,再开始构建;
> 3. 依赖有任何变化,构建前先删 `apps\mobile\android\build\generated\autolinking`(坑 8)。
>
> 增量重打(只改 JS / 资源)实测 **28–51 秒**;全量首次约 30–40 分钟。
>
> 下面是脚本等价的手工步骤(要看清每一步在干什么时用):

```powershell
# 0) 依赖必须与锁文件一致(这台 checkout 曾经装着 RNGH 3.0.2 而锁文件是 2.32.0,
#    会一路以「模块解析不了」的形式炸;见坑 6)
cd G:\Projects\Cindy
pnpm install --frozen-lockfile --ignore-scripts

# 1) 生成原生工程(每次改了 app.json / 原生配置 / 依赖后都要)
cd apps\mobile
pnpm exec expo prebuild --platform android --no-install

# 2) prebuild 会重置 wrapper 指向,重新指到本地 Gradle(坑 2)
#    apps\mobile\android\gradle\wrapper\gradle-wrapper.properties:
#      distributionUrl=file\:///G:/dev/android-tools/gradle-9.3.1-bin.zip
#      validateDistributionUrl=false

# 3) 给 prebuild 产物打三处补丁(本机无管理员权限、开不了长路径,坑 4/5)
#    app/build.gradle:
#      android { externalNativeBuild { cmake { buildStagingDirectory = file("C:/cbx") } } }
#      android { defaultConfig { externalNativeBuild { cmake {
#          arguments "-DCMAKE_UNITY_BUILD=ON", "-DCMAKE_UNITY_BUILD_BATCH_SIZE=1" } } } }
#    app/gradle.properties:
#      org.gradle.jvmargs=-Xmx8192m -XX:MaxMetaspaceSize=4096m
#    app/src/main/res/values/strings.xml:
#      <string name="app_name">Cindy Verify</string>   # 仅为与商店版区分

# 4) 打包
cd android
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2
#    产物:android\app\build\outputs\apk\release\app-release.apk
```

- **`-PreactNativeArchitectures=arm64-v8a` 很关键**:默认编 4 个 ABI,只编 arm64 大约省 3/4 时间;
- 首次全量约 30–40 分钟,之后增量(改 JS / 改资源)1–4 分钟;
- **改了依赖(装/升包)必须先删 `apps\mobile\android\build\generated\autolinking` 再构建**(坑 8)。

## 六、踩过的坑(按症状索引,都已绕过)

| # | 症状 | 原因 | 处理 |
|---|---|---|---|
| 1 | `sdkmanager` 永远卡在 `Fetch remote repository...` | 本机 Java 拉不到 Google 的 `repository2-3.xml` | 全部改为 `curl` 直下 zip 手工铺 SDK 布局;license 文件手写(`G:\dev\android-sdk\licenses\`) |
| 2 | `SSLHandshakeException: PKIX path building failed`(下 Gradle) | Java 对 `services.gradle.org` 的重定向 CDN 建不出证书链 | curl 预下 `gradle-9.3.1-bin.zip`,`distributionUrl` 指 `file:///…` |
| 3 | `Could not GET https://dl.google.com/dl/android/maven2/...` 超时 | **dl.google.com 的 maven 路径在本机完全不可达**(curl 25s/Java 31s 超时) | `C:\Users\chany\.gradle\init.gradle` 把 repositories 重定向到阿里云(google/public/gradle-plugin)+ 腾讯/华为兜底;并发拉取偶发被重置,故加 `--max-workers=2` 与重试 |
| 4 | `ninja: error: Stat(...): Filename longer than 260 characters` | 本机非管理员,`LongPathsEnabled=0`;该对象路径实测 **347 字符**,任何路径压缩都到不了 259 | `buildStagingDirectory=C:/cbx`(省 ~40)+ `CMAKE_UNITY_BUILD=ON`(对象名从「编码后的绝对源码路径」变成 `Unity/unity_N_cxx.cxx.o`,省 ~150);批量大小必须 =1,否则 rnsvg 的多个 TU 合并会重定义报错。RN 0.86 把新架构写死(`ProjectUtils.kt:34 = true`)、WSL 也没装发行版,所以这两条是唯一出路 |
| 5 | `lintVitalAnalyzeRelease FAILED > Metaspace` | 生成的 `gradle.properties` 只给 `-Xmx2048m -XX:MaxMetaspaceSize=512m` | 提到 `8192m/4096m`(仓库自己的 `build-android.mjs` 也会 patch 这里,值 4096/2048) |
| 6 | `Unable to resolve module react-native-gesture-handler/Swipeable` / typecheck 报一堆缺失模块 | 这台 checkout 的 node_modules 与锁文件不一致(装着 RNGH **3.0.2**,锁文件要 **2.32.0**;3.x 删了 `Swipeable`) | `pnpm install --frozen-lockfile --ignore-scripts` |
| 7 | `Unable to resolve module ../../../../config/endpoint.dev.json` | `src/config/env.ts` 里是静态 `require`,即使构建 cn、运行时走不到该分支,Metro 也要能解析 | 从 `config/endpoint.dev.json.example` 复制出该文件(gitignored) |
| 8 | 依赖变更后 `CMake Error ... does not contain a CMakeLists.txt`(指向 RNGH 的旧布局) | `android/build/generated/autolinking/autolinking.json` 是旧的(`cmakeListsPath` 还写着 RNGH 3.x 的 `android/CMakeLists.txt`) | 删 `apps\mobile\android\build\generated\autolinking`(连带 `app\build\generated\autolinking`、`app\build\intermediates\cxx`、`C:\cbx`)后重建 |
| 9 | `Preferred NDK version is '27.0.12077973'` | `expo-updates` 与 RN core 偏好不同版本 | 两个 NDK 都装 |
| 10 | `Failed to find Build Tools revision 36.0.0` / AGP 卡住十几分钟 | Expo 实际用 build-tools 36,而 AGP 自动补装走 Google 仓库清单在本机会挂 | 手工装 `build-tools/36.0.0`;并把 `android.builder.sdkDownload=false` 写进用户级 gradle.properties 让它 fail-fast |
| 11 | 改了 `packages/device-link` 源码后重打,**新包 sha256 与旧包完全相同**(打进了旧 JS) | `createBundleReleaseJsAndAssets` 不把 `packages/*` 当任务输入 → 判 UP-TO-DATE,连 Metro 缓存都不用清就跳过了 | 构建前删掉 JS bundle 产物(`app/build/generated/assets/react`、`generated/sourcemaps/react`、`intermediates/assets/release`);`tools/build-cindy-verify-apk.ps1` 已内置这一步 |
| 12 | 装了带修复的包仍然不恢复 | **判据设计过严**:要求「同一 peer 连续两次请求超时」,而回前台后 App 往往只发一轮请求(每个只超时一次),连续计数到不了 2;探针那条路又要求「已存在超时证据」 | 改为「探针超时(= 提示后一个对端帧都没来)即证据 + 有短超时请求在等回包」;长执行通道靠请求自身的分钟级超时排除。commit `308b4badc` |
| 13 | App 里点下载/导出 **秒失败**(实测 <5 秒),Host 侧却说导出成功 | **阿里云 OSS 拒绝公网端点分发安装包**:key 后缀为 `.apk`/`.ipa`,或对象 Content-Type 恰为 `application/vnd.android.package-archive`,GET 一律 `400 ApkDownloadForbidden` —— 而上传 PUT 与 `presign-get` 都成功,所以两边看着都对 | Host 侧 staging 时把这类对象按**不透明字节**发:`ext → bin`、`Content-Type → application/octet-stream`(`stageableStaging`)。文件名不受影响(手机按浏览到的文件名自己命名)。详见第九节 |
| 14 | 出包脚本报"构建失败"但**看不到原因** | 脚本把 Gradle 输出过滤成 5 个关键词(`BUILD SUCCESSFUL|FAILED|FAILURE|actionable tasks|What went wrong`),**原因行全被丢掉**;而失败可能是 Windows 文件锁(残留 Gradle 守护进程攥着 `node_modules\expo-modules-core\android\build\...\bundleLibCompileToJarRelease\classes.jar`) | 在 `apps\mobile\android` 手工跑一次 `gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a --max-workers=2`(记得先设 `JAVA_HOME=G:\dev\jdk`、`ANDROID_HOME`/`ANDROID_SDK_ROOT=G:\dev\android-sdk`),输出落盘看原因;文件锁用 `gradlew --stop` + 删那个 build 目录解决 |
| 15 | `git commit -m "…"` 报 `pathspec … did not match any file(s)` | 提交信息里写了 **ASCII 双引号**,PowerShell 提前结束字符串,后半段被当成 git 参数 | 提交信息一律走文件:`git commit -F <临时文件>`(本机踩过两次,其中一次连带出包失败,浪费约 20 分钟) |

> `curl.exe` 在本机需要 `--ssl-no-revoke`(否则报 `CRYPT_E_NO_REVOCATION_CHECK`)。
> JDK 走清华镜像 25 MB/s,NDK 走 `https://mirrors.cloud.tencent.com/AndroidSDK/android-ndk-rXX-windows.zip` 13 MB/s,
> dl.google.com 的普通 zip 只有 1.6–2 MB/s 且时好时坏。

## 七、代码位置

- 修复分支 `fix/mobile-peer-silence-probe`(commit `eadedb8d5`,**未 push**)在 `G:\Projects\Cindy`;
  补丁见 [`doc/patches/cindy-peer-silence-probe.patch`](patches/cindy-peer-silence-probe.patch);
  换机器/换人时 `git am` 即可(要推分支也可以,需先确认);
- 本地已验证:`pnpm --filter @cindy/device-link build`(tsc 干净)、`pnpm --filter @cindy/device-link test` **414/414**
  (含本次新增 5 条单测);
- 本次为出包改的 3 处都在 **prebuild 生成物** `apps/mobile/android/` 内(该目录被 `apps/mobile/.gitignore` 忽略,
  不入仓),不会污染修复提交。

## 八、验证完要带回什么

1. `adb logcat` 原始片段(带时间戳,含 `device-link` 全量行);
2. 是否自愈、自愈耗时(从发送到界面出现回复);
3. 手机型号 / 系统版本 / 包名 / 构建 commit;
4. 结论写回 `.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`(把「归属」一节从「OS 行为、不再投入」
   改成「客户端判据缺陷、已修 / 已验证或待验证」);
5. 若验证通过且要提 PR:补丁 `git am` 到干净分支 → 出包验证记录 → 再按上游要求提(他们要求本地打包测试通过)。

## 九、导出/下载安装包:根因与修复(2026-09-18,host 0.1.6)

**症状**:手机文件浏览器里点「下载/导出」,不到 5 秒弹「下载失败」;Host 侧日志显示导出任务
`state=done` 并给出了 key —— 两边各自都"成功",失败卡在中间那一跳。

**根因(实测,不是推断)**:账号暂存区在阿里云 OSS 的**公网裸域名**
(`cindy-prod-private.oss-cn-shanghai.aliyuncs.com`),而阿里云禁止该端点分发安装包。命中**任一**
条件即被拒,且与签名/ACL 无关:

| key 后缀 | 对象 Content-Type | GET 结果 |
|---|---|---|
| `.apk`(任意大小写,server 会小写化) | `application/octet-stream` | `400 ApkDownloadForbidden` |
| `.bin` | `application/vnd.android.package-archive` | `400 ApkDownloadForbidden` |
| `.bin` | `application/octet-stream` / `zip` / `x-itunes-ipa` / 该 mime 带 `; charset=binary` | `200` ✅ |
| `.zip` `.exe` `.dmg` `.apks` `.txt` | `application/octet-stream` | `200` ✅ |

响应体给出完整原因(以前被折叠成一个 `download-failed`,白查一下午):

```xml
<Error><Code>ApkDownloadForbidden</Code>
<Message>The APK file is not allowed to be distributed in a public network using the
OSS endpoint, please use CNAME instead.</Message></Error>
```

**修复**(`src/host-media.js`):

- `stageableStaging(ext, contentType)`:命中上述任一条件时,staging 声明改为 **`ext=bin` +
  `Content-Type: application/octet-stream`**(两处都要改:PUT 的 `Content-Type` 头才是对象存下来的值);
- `download-failed` 现在带上对象存储的错误码(`download-failed: ApkDownloadForbidden`),下次一眼判因;
- 文件**字节不动**,用户看到的文件名也不变:手机按浏览到的文件名自己命名
  (`apps/mobile/app/files/[sessionId].tsx` → `downloadRemoteMediaShareTemp(url, mime, item.name)`),
  分享用的 mime 也取自文件名,所以staged 成不透明字节对安装毫无影响。

**证据链**(三个探针都在 `tools/`,都打真的线上暂存区):

```powershell
node tools/probe-oss-ext.mjs                                  # 后缀矩阵:哪些后缀被拒
node tools/probe-oss-ext.mjs --content-type application/vnd.android.package-archive bin
node tools/probe-apk-export-roundtrip.mjs                     # 真实的 77MB 包:上传 → 下载 → sha256 比对
```

修复后实测:`80977303` 字节上传 4.1s → 完整下载 1.87s(41 MB/s)→ sha256 与本地一致 ✅。
修复前同一探针:`下载失败(179ms): reason=download-failed: ApkDownloadForbidden`。

**当前 APK**:`Cindy-Verify-0.1.0-arm64-v8a-94f083331.apk`(77.2 MB,sha256
`BEC452E890F1E8BCA33597E205B5D4B5B0ADEE36ADF33FBCBB9043AA821CAD90`),含客户端 peer 静默探针。
**下载链路是 Host 侧的 bug:手机不需要换包就能拿到文件**,换包只是为了验证第三/四节的断线自愈。

**仍未覆盖(已知)**:手机→Host 方向若传 `.apk` 附件,key 由手机侧申请,同样会被 OSS 拒;
要修得在客户端上传处做同样的中性化(本仓 `uploadMedia` 管不到那条路径)。

## 十、真机复现:卡死其实有两种,机制完全不同(2026-09-18 18:37 取证)

用带对端活性看门狗的包(`94f083331`)复现后,Host 侧的逐 5 秒时间线显示的是**另一种卡死**:

```
10:37:03–06   一串调用(回前台:重新订阅 + sessions:get + messages:view + list-active)
10:37:06 → 28 22 秒里一次调用都没有          ← 不是"答复没到",是它不再问了
10:37:28/33/55 只有用户操作触发的 input:enqueue / steer
Host 同时刻:推送一直在发(watchers=1)、订阅在、reconnect=0、handlerErrors 空、帧预算 0 抑制
用户侧:「思考时间一直不动」;导航/发消息可用;退到列表再回来不行;**只有重启 App 才行**
```

| | 手机还在问吗 | 机制 | 归属 |
|---|---|---|---|
| A(第三节那类,12:18 现场) | **在问,且重复问同一个读** | 答复到不了它(读方向死) | 客户端判据缺陷 |
| B(本次) | **完全不问** | 计时器整体停摆,不再产生请求 | 客户端生命周期缺陷 |

**B 的机制**:后台驻留后 RN(Android)计时器驱动没重新装上,而 App 的实时行为全建立在
`setInterval`/防抖上 —— 轮询(`messages:view`/`view-intent`,由 push 后的防抖重载驱动)、
对端探针、以及「思考时间」(`app/sessions/[sessionId].tsx` 的 `setInterval(updateElapsed, 1000)`)
一起停;AppState 回调、socket 事件、导航、发送这些**事件驱动**的路径照常工作。计时器是 React
实例级的,所以换屏不恢复,只有整进程重开。

**B 的修复**:`apps/mobile/src/device-link/timerLiveness.ts`(commit `04d36977f`)——
入站帧与回前台这两个**不经过计时器**的事件当检查点,心跳间隙 ≥3 秒判定停摆 → 重建心跳 +
重连/rehydrate,并上报 `tdiag.stall.s<秒>.r<次数>.<来源>` / `tdiag.recover.after<秒>s.r<次数>.<来源>`。

**第二层(即使重建救不回来界面也能恢复)**:取证精确到了那一跳 ——
push → `historyView.invalidate()` → **`setTimeout(500ms)`** → 重读
(`packages/maker-shared/src/historyViewController.ts`)。计时器停摆时这一跳永不执行,
所以「推送一直在到、界面永不刷新、手机一次 `messages:view` 都不再发」。现在:
`HistoryViewController` 接受注入的 `timersHealthy` 判定,判定为停摆时改用**挂钟节流
300ms + 立即重读**(不依赖任何定时器);「思考时间」的显示值也改为渲染时按真实时间算。

**第三层(用户真机反馈后补的最后一环)**:「进会话页思考时间不动,退到列表再进来会更新一次,
但不实时更新」—— `remoteSessionStore` 的流式文本增量批量刷新(`scheduleTextDeltaFlush`)把
`flushPendingTextDeltas` 排在 `setTimeout` 上,而**该函数只在那一个回调里**被调用:
计时器停摆时增量永远停在缓冲里,退出再进走整页重读所以只更新一次(用户描述与机制一字不差)。
停摆时改为**直接刷**(正常批量间隔本来只有 32–96ms,同量级;也不会有"最后一批增量滞留"的风险)。

**第四层(用户提出的"回前台强制重刷")**:回前台的重新订阅 + 重读其实一直在做
(`rehydrateWithClient`,日志 10:37:03–06 那一串),但它是**一次性**的。用户补上关键一半:
「退到列表再进来就恢复」的本质是**数据层整体换代**,而 `connectionEpoch` 只在**客户端重连成功**
时才换代 —— 停摆时没有重连,所以屏幕各层 effect 都不重跑。现在**判定停摆时也换代一次**
(只在这个降级态做,不在每次回前台都做)。

**判据(不靠肉眼)**:

```powershell
# 手机自报的时间线(带到达时刻;不被普通轮询冲掉,只被更多自报挤掉)
(Invoke-RestMethod 'http://127.0.0.1:3080/api/dsh-cindy-host/status').diagnostics.phoneDiagnostics
```

- 出现 `tdiag.stall.*` → 证实 B;
- **紧接着出现 `tdiag.recover.after*s`** → 心跳重建生效,界面应在 10 秒内恢复实时刷新(修复成功);
- 只有 `stall`、没有 `recover` → 计时器无法从 JS 侧复活,下一步把 App 的实时循环改成
  push 事件直接驱动(不再依赖 `setInterval`)。

**当前产物(层 1 + 层 2 在同一个包里)**:

| 项 | 值 |
|---|---|
| 项目内路径 | `artifacts\Cindy-Verify-0.1.0-arm64-v8a-d4969890c.apk` |
| 大小 / sha256 | 77.2 MB / `A2147D4822A3B06813EEED6D086EC2FA896B3CB5032B0104736108ED496CFDDC` |
| 包内已核对 | 层 1:`tdiag.stall.s` `tdiag.recover.after` `timer-stall`;层 2:`lastDirectInvalidateAt` `timersHealthy` `setTimerHealthProbe` |
| 出包踩坑 | 上一次构建失败于 `Unable to delete file …bundleLibCompileToJarRelease\classes.jar`:残留 Gradle 守护进程攥着文件。`gradlew --stop` + 删 `node_modules\expo-modules-core\android\build` 后重跑即成功(脚本把 Gradle 输出过滤成 5 个关键词,**原因行会丢**,排查时要手工跑一次 gradlew 留完整日志) |

