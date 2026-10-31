# file-peer：现宿主最小应用交接

**准备完成，未应用/重启。只改安装副本一个字面量；保持现配置不变时需经用户确认重启原DSH。未重跑53测试或黑洞复现。**

## 实际目标与排除项

- 3080当前PID **40916**，启动2026-09-21 11:10:11；Node=`D:/Program Files/nodejs/node.exe`，入口=`C:/Users/chany/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js`，参数=`web`。
- **实际进程cwd为 `C:/Users/chany/`**，只读进程current-directory字段核实，未读取环境/凭据缓冲。不要把本会话工作树当成原启动目录。
- `C:/Users/chany/.dsh/profiles/web/package.json`：依赖 **dsh-cindy-host-demo@0.1.10**，patchReload=live。该profile的模块解析指向独立安装根 `C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo`，不是工作树链接，realpath相同。
- **唯一应用目标T**：`C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src/host-file-peer.js`。原文件12465字节，写入2026-09-20 18:54:14，早于进程启动。安装静态链：`dsh-plugin.js:12 → host.js:41,411 → host-file-peer.js`。

比较安装与工作树的src/*.js、lib/*.js、package.json、cordis.patch.yml共52文件，无新增运行JS；只有3项不同：

| 文件 | 差异 | 本次 |
|---|---|---|
| src/host-file-peer.js | 15→25秒及工作树4行解释注释 | 仅替换安装版截止字面量 |
| src/host-approvals.js | questionObservers、提问/撤销通知、未决问题回放和observeUserQuestions | **排除4961…问答改动** |
| src/host.js | 暴露observeUserQuestions及注释 | **排除** |

其余49文件字节一致。dirty相对Git HEAD不等于相对安装版差异；**不复制整个树、不打包dirty树、不npm update/link，不改profile/lockfile/client/Cindy**。安装版号仍为0.1.10，此次是可回滚本地hotfix，非已发布新版本。

## 为什么不能只切开关/重新connect

实际全局DSH代码：
- `dsh-base/cordis.patch.yml:19–25` 的源码HMR行默认disabled=true；web profile的cordis.yml/cordis.patch.yml未发现hmr覆盖。
- `lib/profile-boot-Dk-7KqJc.js:321–337` 的live配置监听后备HMR使用 **root: []**，不监听插件JS。
- `cordis-plugin-loader/lib/index.js:270–279,466`：同名配置重载复用旧callback；重新import同一URL仍受ESM缓存约束。
- `cordis-plugin-hmr/lib/index.js:353–388` 才清模块图缓存；默认忽略node_modules（441–445）。已装plugin-inventory是只读投影，不是源码reload接口。

**未发现现配置下受支持的单Host源码reload入口。** 浏览器刷新、Cindy reconnect、配置toggle/重建实例不能证明静态依赖更新。临时配置源码HMR或注入内部loadCache会扩大变更边界，不纳入此方案。无需清磁盘缓存或重建Web；新进程重新加载ESM链及Host/filePeer manager。

## 执行与回滚：由主助手确认协调后执行

1. 用户确认整宿主短暂停机，现有会话/任务到安全边界；也需协调其他插件所有者，整宿主重启会加载其已落盘变更，本轮只核了Cindy安装包。应用前复核3080 PID、profile、cwd、T哈希；漂移就停止重核。
2. 将**现安装T原字节**单文件备份到一次性路径，如 `G:/Projects/DSH-cindy-host/.sandbox/offer-hotfix-20260921-<时间戳>/host-file-peer.js.before`。不得覆盖旧备份；记录路径、版本、PID、hash，验备份hash=before。不要从dirty树取备份。
3. 先read T，再edit唯一一处：
   - old：`c.offerTimer = setTimeout(() => close(c, 'FILE_PEER_TIMEOUT'), 15_000);`
   - new：`c.offerTimer = setTimeout(() => close(c, 'FILE_PEER_TIMEOUT'), 25_000);`
   仅一个ASCII字节变化，其余字节保持；比较备份并核after hash。未携带源码的4行注释，因此after hash有别于工作树整文件hash。

```text
before SHA256: bad5bf48fbe711e7248a71d9902d1fb688dd6d2a2df89232a532deba7525df6e
after  SHA256: c9d44db98c630a6c0d863aef40721e7f4606b7fd9e803b5db4cc0c7ebc5484fa
```

4. 以下dry-run已实跑：PID40916、args=[web]、cwd=C:/Users/chany、DSH_HOME继承默认、grace60。操作时再核一次：

```powershell
node 'C:/Users/chany/.agents/skills/dsh-restart/scripts/restart-dsh.mjs' --port 3080 --cwd 'C:/Users/chany'
# 仅确认、协调并预告后执行；本轮未执行：
node 'C:/Users/chany/.agents/skills/dsh-restart/scripts/restart-dsh.mjs' --port 3080 --cwd 'C:/Users/chany' --apply --grace 60
```

影响：该宿主所有活跃回合、手机链路/传输及内存实例中断；持久会话日志保留，不能承诺回合自动继续。旧Web认证链接可能失效，用户按本机启动提示重新打开，不回传token。失败可能停机，须人工恢复。**不并行另起替代server。** 仅原进程已退出且3080无人监听时，原入口人工恢复命令：

```powershell
Set-Location 'C:/Users/chany'
& 'D:/Program Files/nodejs/node.exe' 'C:/Users/chany/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js' web
```

回滚：T仍为after hash时，把同次备份原字节恢复到T，核before hash，再走相同确认/协调重启流程。若T已被别人更改，不自动覆盖。仅回滚T，不回滚整个包/profile/问答改动。后续包更新可能覆盖本地hotfix，须保留此记录。

## 最小验收与现有只读观测

**A. 装载25秒代码**：T的after hash正确；3080新PID启动晚于修补；仍用原web profile、解析同一安装根；GET状态installed=true、status.state=connected。结合固定静态导入链证明新Host装载修正版。**API没有offerTimeoutMs或源码hash字段**；不把caps/connected冒充直接计时证明，不新造诊断参数、不再跑黑洞。

**B. 手机一次原入口**：用户用现有手机，在原项目文件浏览器点原“导出/分享”；优先选择允许分享的、未缓存、非敏感且**>64KiB的小文件**，不默认重传1.315GB APK。记点按/结果时刻，操作前后立即看：

- 现成HTTP只读诊断：`GET http://127.0.0.1:3080/api/dsh-cindy-host/status`（既有loopback路由）。
- 只选installed/status.state、diagnostics中file-peer的invokeTotals/refusalTotals；recentInvokes/recentRefusals过滤同一手机来源和channel，保留at/channel/ok/code，本地对齐src、报告用别名。不取preview、SDP、凭据。FILE_PEER_TIMEOUT经cindy-channels.js:1583–1585保留。
- 只读装载检查：Get-NetTCPConnection/Get-Process、T的Get-FileHash、profile模块解析。
- `POST /api/dsh-cindy-host/selftest` **不是通用只读入口**，会执行实际channel操作；已有channel=device-link:file-peer、args=[{action:'caps'}]仅查协议上限，不能证明25秒。本验收无需主动offer/open自测。

**观测边界**：现有环不记录peer action、请求开始或耗时（host.js:1662–1701,1743起），不能伪造精确“同次offer25秒”，点按时间只辅助关联。小文件可回退OSS，**分享成功/peer计数增长/无拒绝，均不能单独证明DataChannel建立或peer传输完成**。只报告已观测阶段；没有可归因建连/完成证据就明确未证实，不拿计数猜。用户另行选择继续原APK后再验传输，建连修复与整包成功分开；新Android APK、诊断包、整包重传都不是本修复前置。

当前只读状态：installed=true、connected，peer调用/拒绝计数字段未出现，peer拒绝环为空；这不是手机验证成功，也不能恢复旧日志。本轮生产文件/配置未动，没有重启、另开server或提取凭据。

已按key `file-peer-minimal-apply-preparation-report-20260921-01` 回主助手一次：receipt=`bed255b0774dd46cc89536baa0f63302d15e2bf7874efa1b75ae9a678afc4509`，request=`assistant-1732294b-f08a-49e0-9f32-7b9f8450521c`，admission=accepted，仅表示入队，不表示已消费或应用成功。
