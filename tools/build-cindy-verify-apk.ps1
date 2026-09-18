#!/usr/bin/env pwsh
<#
.SYNOPSIS
  一条命令打出「带 peer 级静默修复的 Cindy 安卓验证包」。

.DESCRIPTION
  本机(G:\Projects\Cindy)的 Android 工具链与绕过手段都已固定下来,但有几处补丁落在
  `expo prebuild` 的生成物里 —— prebuild 一跑就被冲掉,构建会重新撞上 Windows 260 字符
  对象路径上限。本脚本把这些都收敛成一条命令:

    依赖检查 → (可选)prebuild → 重新打补丁 → gradlew assembleRelease → 校验 → 拷到下载文件夹

  背景与逐条原因见 doc/cindy-android-verify.md(含 10 个坑的索引)。

.PARAMETER Region
  cn(默认,与 G:\Projects\DSH-cindy-host 的 host 同一套 relay)| global

.PARAMETER Abi
  默认 arm64-v8a(只编一个 ABI,首次全量约省 3/4 时间)。

.PARAMETER SkipPrebuild
  跳过 prebuild(原生配置没变时用它,增量构建实测 28–51 秒)。
  依赖有任何变化时不要用:必须先删 android/build/generated/autolinking 再构建。

.PARAMETER RepoPath
  Cindy 仓库路径,默认 G:\Projects\Cindy

.PARAMETER OutDir
  产物拷贝目录,默认当前用户的下载文件夹。

.EXAMPLE
  pwsh tools/build-cindy-verify-apk.ps1
  pwsh tools/build-cindy-verify-apk.ps1 -SkipPrebuild
#>
[CmdletBinding()]
param(
  [ValidateSet('cn', 'global')][string]$Region = 'cn',
  [string]$Abi = 'arm64-v8a',
  [switch]$SkipPrebuild,
  [string]$RepoPath = 'G:\Projects\Cindy',
  [string]$OutDir = (Join-Path $env:USERPROFILE 'Downloads'),
  [string]$JdkHome = 'G:\dev\jdk',
  [string]$AndroidSdk = 'G:\dev\android-sdk',
  [string]$StagingDir = 'C:/cbx'
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host "==> $m" }

if (-not (Test-Path $RepoPath)) { throw "找不到仓库: $RepoPath" }
if (-not (Test-Path (Join-Path $JdkHome 'bin\java.exe'))) { throw "找不到 JDK: $JdkHome" }
if (-not (Test-Path (Join-Path $AndroidSdk 'platform-tools\adb.exe'))) { throw "找不到 Android SDK: $AndroidSdk" }

$mobileDir = Join-Path $RepoPath 'apps\mobile'
$androidDir = Join-Path $mobileDir 'android'
$gradleUserHome = Join-Path $env:USERPROFILE '.gradle'

# ── 0. 环境变量(本机刻意不改系统级 JAVA_HOME / ANDROID_HOME) ────────────────
$env:JAVA_HOME = $JdkHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:PATH = "$JdkHome\bin;$AndroidSdk\platform-tools;$env:PATH"
$env:EXPO_PUBLIC_CINDY_AUTH_REGION = $Region
$env:CINDY_USE_LOCAL_REGION_CONFIG = '1'
$env:NODE_ENV = 'production'

# 端点自举基址:从仓内正本 config/endpoint*.json 取(不要硬编码)
function Get-CdnBase([string]$region) {
  $file = switch ($region) { 'cn' { 'endpoint.json' } default { 'endpoint.global.json' } }
  $json = Get-Content (Join-Path $RepoPath "config\$file") -Raw | ConvertFrom-Json
  if (-not $json.cdnBaseUrl) { throw "config\$file 缺 cdnBaseUrl" }
  return $json.cdnBaseUrl.TrimEnd('/')
}
$env:EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL = Get-CdnBase $Region
$env:EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL = Get-CdnBase $(if ($Region -eq 'cn') { 'global' } else { 'cn' })
Remove-Item Env:\EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL -ErrorAction SilentlyContinue

Say "region=$Region  abi=$Abi  manifest=$($env:EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL)"

# ── 1. 依赖与本地配置自检(本次踩过的坑,提前拦) ────────────────────────────
$lock = Join-Path $RepoPath 'pnpm-lock.yaml'
$rngPkg = Join-Path $RepoPath 'node_modules\react-native-gesture-handler\package.json'
if (Test-Path $rngPkg) {
  $installed = (Get-Content $rngPkg -Raw | ConvertFrom-Json).version
  $locked = (Select-String -Path $lock -Pattern 'react-native-gesture-handler@([\d.]+)' |
             Select-Object -First 1).Matches.Groups[1].Value
  if ($locked -and $installed -ne $locked) {
    throw ("node_modules 与锁文件不一致:react-native-gesture-handler 装着 $installed,锁文件要 $locked。" +
           "先跑:pnpm install --frozen-lockfile --ignore-scripts(否则会以「模块解析不了」的形式连炸)")
  }
  Say "依赖版本一致:react-native-gesture-handler $installed"
} else {
  throw "缺少 node_modules/react-native-gesture-handler,先跑 pnpm install --frozen-lockfile --ignore-scripts"
}

# config/endpoint.dev.json:src/config/env.ts 里是静态 require,即使构建 cn 也必须存在
$devEndpoint = Join-Path $RepoPath 'config\endpoint.dev.json'
if (-not (Test-Path $devEndpoint)) {
  Copy-Item (Join-Path $RepoPath 'config\endpoint.dev.json.example') $devEndpoint
  Say "已从 .example 补出 config\endpoint.dev.json(Metro 静态解析需要它)"
}

# 本地区域配置:cn 用可并存的包名,避免与商店版同 id 冲突
$regionFile = Join-Path $mobileDir 'scripts\self-host-regions.json'
if (-not (Test-Path $regionFile)) {
  $example = Get-Content (Join-Path $mobileDir 'scripts\self-host-regions.json.example') -Raw | ConvertFrom-Json
  $example.cn.androidPackage = 'com.xd.cindycn.verify'
  ($example | ConvertTo-Json -Depth 8) | Set-Content $regionFile -Encoding utf8
  Say "已生成 self-host-regions.json(cn.androidPackage=com.xd.cindycn.verify)"
}

# 用户级 Gradle 配置(镜像 + 超时 + 禁止 AGP 自动补装)缺失就补,存在则不动
$initGradle = Join-Path $gradleUserHome 'init.gradle'
if (-not (Test-Path $initGradle)) {
  Write-Warning "缺少 $initGradle:本机 dl.google.com 的 maven 路径不可达,必须靠它重定向到国内镜像。见 doc/cindy-android-verify.md 坑 3"
}

# ── 2. prebuild(可选)+ 重新打补丁 ──────────────────────────────────────────
if (-not $SkipPrebuild) {
  Say "expo prebuild --platform android"
  Push-Location $mobileDir
  try { pnpm exec expo prebuild --platform android --no-install 2>&1 | Select-Object -Last 3 } finally { Pop-Location }
} else {
  if (-not (Test-Path $androidDir)) { throw "android/ 不存在,不能 -SkipPrebuild(先跑一次不带该开关的构建)" }
  Say "跳过 prebuild(-SkipPrebuild)"
}

# 2a. Gradle wrapper 指向本地分发包(Java 拉不到 services.gradle.org 的重定向 CDN)
$wrapperProps = Join-Path $androidDir 'gradle\wrapper\gradle-wrapper.properties'
$gradlePkg = Get-ChildItem 'G:\dev\android-tools\gradle-*-bin.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gradlePkg) {
  $url = 'file\:///' + ($gradlePkg.FullName -replace '\\', '/')
  @(
    'distributionBase=GRADLE_USER_HOME'
    'distributionPath=wrapper/dists'
    "distributionUrl=$url"
    'networkTimeout=10000'
    'validateDistributionUrl=false'
    'zipStoreBase=GRADLE_USER_HOME'
    'zipStorePath=wrapper/dists'
  ) | Set-Content $wrapperProps -Encoding ascii
  Say "wrapper 指向本地 Gradle: $($gradlePkg.Name)"
}

# 2b. 内存:默认 2048m/512m 会在 release 的 lintVital / dex 阶段抛 `> Metaspace`
$gradleProps = Join-Path $androidDir 'gradle.properties'
$gp = Get-Content $gradleProps -Raw
$gp = $gp -replace '(?m)^org\.gradle\.jvmargs=.*$', 'org.gradle.jvmargs=-Xmx8192m -XX:MaxMetaspaceSize=4096m'
Set-Content $gradleProps $gp -Encoding ascii
Say "gradle.properties: jvmargs 提到 8192m/4096m"

# 2c. 260 字符上限:短 staging 目录 + unity build(batch 必须为 1,rnsvg 合并会重定义)
$appGradle = Join-Path $androidDir 'app\build.gradle'
$ag = Get-Content $appGradle -Raw
if ($ag -notmatch 'CMAKE_UNITY_BUILD') {
  $anchor = "(?m)^(\s*namespace\s+'[^']+'\s*)$"
  if ($ag -notmatch $anchor) { throw "app/build.gradle 里找不到 namespace 锚点,补丁模板需要更新" }
  $inject = @"
`$1
    // 本机非管理员(LongPathsEnabled=0),ninja 会因对象路径 >260 失败:
    // 短 staging + unity build(batch=1)把对象名从「编码后的绝对源码路径」变成 Unity/unity_N_cxx.cxx.o
    externalNativeBuild {
        cmake {
            buildStagingDirectory = file("$StagingDir")
        }
    }
"@
  $ag = $ag -replace $anchor, $inject

  $dcAnchor = '(?m)^(\s*versionName\s+"[^"]*"\s*)$'
  if ($ag -notmatch $dcAnchor) { throw "app/build.gradle 里找不到 versionName 锚点,补丁模板需要更新" }
  $dcInject = @"
`$1

        externalNativeBuild {
            cmake {
                arguments "-DCMAKE_UNITY_BUILD=ON", "-DCMAKE_UNITY_BUILD_BATCH_SIZE=1"
            }
        }
"@
  $ag = $ag -replace $dcAnchor, $dcInject
  Set-Content $appGradle $ag -Encoding ascii
  Say "app/build.gradle: 已注入 staging=$StagingDir + unity build(batch=1)"
} else {
  Say "app/build.gradle: unity/staging 补丁已存在"
}

# 2d. 桌面名改成 Cindy Verify,避免与商店版同名分不清
$stringsXml = Join-Path $androidDir 'app\src\main\res\values\strings.xml'
if (Test-Path $stringsXml) {
  $sx = Get-Content $stringsXml -Raw
  if ($sx -notmatch 'Cindy Verify') {
    $sx = $sx -replace '(<string name="app_name">)[^<]*(</string>)', '${1}Cindy Verify${2}'
    Set-Content $stringsXml $sx -Encoding ascii
    Say "strings.xml: app_name -> Cindy Verify"
  }
}

# ── 3. 构建 ────────────────────────────────────────────────────────────────
# 依赖变过就必须丢掉旧的 autolinking 配置,否则会把模块指到旧版本的布局上
$staleAutolinking = Join-Path $androidDir 'build\generated\autolinking'
if (-not $SkipPrebuild -and (Test-Path $staleAutolinking)) {
  Remove-Item $staleAutolinking -Recurse -Force
  Say "已清掉旧的 autolinking 配置(坑 8)"
}

# 改了 packages/* 的源码后必须清 Metro 缓存,否则可能把旧 bundle 打进包里
# (仓库自己的 build-android.mjs 也会在打包前 clearBundlerCache)。
$metroCaches = @(
  (Join-Path $RepoPath 'node_modules\.cache\metro'),
  (Join-Path $env:TEMP 'metro-cache'),
  (Join-Path $env:LOCALAPPDATA 'Temp\metro-cache')
)
foreach ($mc in $metroCaches) {
  if (Test-Path $mc) { Remove-Item $mc -Recurse -Force -ErrorAction SilentlyContinue; Say "已清 Metro 缓存: $mc" }
}

# 光清 Metro 缓存不够:`createBundleReleaseJsAndAssets` 不把 `packages/*` 当输入,
# 改了 packages 里的源码它会判 UP-TO-DATE,把**旧 bundle** 打进新包(实测:新旧 APK
# sha256 完全相同)。所以每次构建都删掉上一次的 JS bundle 产物,强制重打。
$bundleOutputs = @(
  (Join-Path $androidDir 'app\build\generated\assets\react'),
  (Join-Path $androidDir 'app\build\generated\sourcemaps\react'),
  (Join-Path $androidDir 'app\build\intermediates\assets\release')
)
foreach ($bo in $bundleOutputs) {
  if (Test-Path $bo) { Remove-Item $bo -Recurse -Force -ErrorAction SilentlyContinue; Say "已删旧的 JS bundle 产物: $($bo.Replace($androidDir, 'android'))" }
}

# 上一次构建留下的 Gradle / Kotlin 守护进程会攥着 `node_modules` 里各库的 build 产物不放,
# 下一次构建在 `bundleLibCompileToJarRelease` 上以
#   Unable to delete file '...bundleLibCompileToJarRelease\classes.jar'
# 失败(实测遇到两次,每次都要手工救火)。守护进程是 **必须** 先停的:文件句柄在它们手里,
# 光删目录不行。这里做成前置步骤,失败也让 Gradle 自己给出原因而不是先删出错。
Push-Location $androidDir
try {
  $daemons = Get-Process java -ErrorAction SilentlyContinue
  if ($daemons) {
    Say ("停止 Gradle 守护进程({0} 个 java 进程)后清理库构建产物" -f @($daemons).Count)
    & .\gradlew.bat --stop 2>&1 | ForEach-Object { "    " + $_.ToString().Trim() }
    # 句柄释放是异步的:等它们真的退出,再删目录。
    for ($wait = 0; $wait -lt 20; $wait++) {
      if (-not (Get-Process java -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
  }
  $libraryBuilds = @(
    (Join-Path $RepoPath 'node_modules\expo-modules-core\android\build'),
    (Join-Path $RepoPath 'node_modules\expo-updates\android\build')
  )
  foreach ($lb in $libraryBuilds) {
    if (-not (Test-Path $lb)) { continue }
    for ($try = 0; $try -lt 3; $try++) {
      Remove-Item $lb -Recurse -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path $lb)) { break }
      Start-Sleep -Milliseconds 800
    }
    if (Test-Path $lb) { Say ("警告: 清不掉 $lb(仍有进程占用),构建可能会失败") }
    else { Say ("已清库构建产物: " + $lb.Replace($RepoPath, '<repo>')) }
  }
} finally { Pop-Location }

Push-Location $androidDir
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# 完整 Gradle 输出落在这里(不在仓库目录里:`$RepoPath` 是 **Cindy 仓**,它没有 `.sandbox`,
# 上一版补丁就因为这个写日志失败、把一次成功的构建误判成失败)。
$gradleLog = Join-Path $env:TEMP 'cindy-verify-gradle.log'
try {
  Say "gradlew assembleRelease -PreactNativeArchitectures=$Abi"
  & .\gradlew.bat assembleRelease "-PreactNativeArchitectures=$Abi" --max-workers=2 2>&1 |
    Tee-Object -FilePath $gradleLog |
    Select-String -Pattern 'BUILD SUCCESSFUL|BUILD FAILED|FAILURE|actionable tasks|What went wrong' |
    ForEach-Object { "    " + $_.Line.Trim() }
  if ($LASTEXITCODE -ne 0) {
    # 上一次失败时**看不到原因**(脚本只留 5 个关键词,原因行被丢掉),所以失败时把上下文打出来。
    Say "Gradle 失败,原因行(完整输出见 $gradleLog):"
    if (Test-Path $gradleLog) {
      $lines = Get-Content $gradleLog
      $at = ($lines | Select-String -Pattern 'What went wrong' | Select-Object -First 1).LineNumber
      if ($at) { $lines[($at-1)..([Math]::Min($at + 12, $lines.Count - 1))] | ForEach-Object { "    " + $_ } }
    }
    throw "构建失败;逐条原因见 doc/cindy-android-verify.md 第六节的坑清单"
  }
} finally { Pop-Location }
Say ("构建耗时 {0:N0} 秒" -f $sw.Elapsed.TotalSeconds)

$apk = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "没找到产物: $apk" }

# ── 4. 校验 + 拷贝 ─────────────────────────────────────────────────────────
$bt = Get-ChildItem (Join-Path $AndroidSdk 'build-tools') -Directory |
      Sort-Object { [version]($_.Name -replace '[^\d.].*$', '') } -Descending | Select-Object -First 1
$aapt2 = Join-Path $bt.FullName 'aapt2.exe'
$apksigner = Join-Path $bt.FullName 'apksigner.bat'
$badging = & $aapt2 dump badging $apk
$pkgLine = $badging | Select-String -Pattern "^package:" | Select-Object -First 1
$labelLine = $badging | Select-String -Pattern "^application-label:" | Select-Object -First 1
Say $pkgLine.Line.Trim()
Say $labelLine.Line.Trim()
if (Test-Path $apksigner) {
  $verify = & $apksigner verify $apk 2>&1
  if ($LASTEXITCODE -ne 0) { throw "签名校验失败: $verify" }
  Say "签名校验通过(apksigner verify)"
}

$commit = (& git -C $RepoPath rev-parse --short HEAD).Trim()
$version = ([regex]::Match($pkgLine.Line, "versionName='([^']+)'")).Groups[1].Value
$dest = Join-Path $OutDir "Cindy-Verify-$version-$Abi-$commit.apk"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item $apk $dest -Force

Write-Host ""
Write-Host "==================== 完成 ===================="
Write-Host "  APK    : $dest"
Write-Host "  大小   : $([math]::Round((Get-Item $dest).Length/1MB,1)) MB"
Write-Host "  sha256 : $((Get-FileHash $dest -Algorithm SHA256).Hash)"
Write-Host "  安装   : adb install -r `"$dest`""
Write-Host "  验证   : 挑照片 → 回前台,logcat 里应出现 peer silence detected, forcing reconnect"
Write-Host "============================================="
