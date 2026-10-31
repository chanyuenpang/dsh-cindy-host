# file-peer：重启后静态装载已核验，手机peer待验

**2026-09-21 16:41:05 +08 已实际完成安装副本单字节修复；本轮没有提交任何重启。此前报告的未应用状态已被本次事实更新。**

## 16:41落盘证据（历史）

- 当前3080：**PID25112**，启动16:21:19.852，实际cwd **G:/Projects/claw-kit/**（只读current-directory字段核实）。已不同于上一轮41128；本次按最新“目标profile/链正确则落盘、不单独重启”授权推进。
- 当前进程参数含web，无--profile覆盖，工具继承DSH_HOME为空；web profile清单为dsh-profile-web，包含dsh-cindy-host-demo@**0.1.10**；该profile解析入口仍是安装根下src/dsh-plugin.js。cwd变化不改变该绝对profile安装目标。
- 唯一修改artifact：`C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src/host-file-peer.js:185`，`15_000 → 25_000`；mtime **16:41:05.0839112**。版本号不变。
- 独立原字节备份：`G:/Projects/DSH-cindy-host/.sandbox/offer-hotfix-2026-09-21T08-41-05.056Z/host-file-peer.js.before`。旧15:29备份也完好，本次未覆盖它。
- 两文件均12465字节；逐字节比较只有偏移**8952**变化：ASCII **49→50（1→2）**。
- 修改前后对同一安装包52个运行文件重新计算SHA256：只有host-file-peer.js变化，其余**51文件完全不变**，包含host-approvals.js、host.js、包manifest及bundle patch。未改question、bridge、索引、profile配置或其他生产文件。

```text
before / backup SHA256
bad5bf48fbe711e7248a71d9902d1fb688dd6d2a2df89232a532deba7525df6e
after / current installed SHA256
c9d44db98c630a6c0d863aef40721e7f4606b7fd9e803b5db4cc0c7ebc5484fa
```

## 合并重启前交接（历史，结果见下）

1. 当前PID25112未变且启动早于文件替换，**落盘不等于运行中已加载25秒**。不为本补丁单独重启，等待你与claw-kit下一次必要重启合并。
2. claw-kit安装/更新若涉及profile依赖重装，可能覆盖此本地hotfix。**所有其他准备完成之后、合并重启之前，最后复核上述绝对目标的after hash及web profile解析入口**。若hash变回before或出现其他值，先报告/核原因，不再空重启，也不全目录复制dirty树。
3. 当前实际cwd是G:/Projects/claw-kit，不要机械复用旧C:/Users/chany或旧PID。由主助手在合并时按实时端口所有者/启动参数/cwd保留正确宿主、web profile与3080；本会话没有发起任何restart命令。
4. 合并后最小装载核验：新PID启动晚于16:41:05（并晚于最后文件校验）、after hash仍正确、同一profile解析及静态导入链dsh-plugin.js→host.js→host-file-peer.js；安全status只看installed/state。API没有offer预算字段，不将caps/connected冒充独立25秒计时验证。

## 未完成边界/恢复

- 重启后25秒代码静态装载核验已通过（见下）；**手机peer建立或1.315GB APK成功仍无证据**。未重跑53测试/黑洞，未增加Android包前置，未传APK。
- 装载确认后再等用户从原Export入口试一次允许分享的、非敏感、未缓存>64KiB小文件；现有GET /api/dsh-cindy-host/status只观察同手机peer调用/安全拒绝与时间。现环没有action/起始耗时；小文件可能OSS回退，分享成功或计数增长不独立证明peer成功。
- 回滚仅在当前hash仍为after时恢复本次独立备份原字节，核before，再交主助手统一重载；若目标已被第三方改变则先核差异，不盲覆盖。
- 落盘与重启后静态核验均无阻碍；唯一需要用户手机操作的验收由主助手保留为真实待办，本轮不触发。

## 17:24重启后只读核验（当前结论）

- 3080监听新PID **48208**，启动 **2026-09-21 17:09:37.1594804 +08**，晚于目标文件写入 **16:41:05.0839112**。
- 安装目标仍12465字节、mtime未变；SHA256仍为上述after **c9d44db9…c5484fa**（完整值见上），第185行明确为 **25_000**。
- 当前进程参数web，无--profile覆盖；工具继承DSH_HOME为空。`C:/Users/chany/.dsh/profiles/web/package.json`仍为dsh-profile-web，声明并装有dsh-cindy-host-demo@0.1.10。
- 该profile解析入口：`C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src/dsh-plugin.js`。已读安装副本确认静态链：dsh-plugin.js:12导入host.js；host.js:41导入host-file-peer.js、411–416构造manager；host-file-peer.js:185设置25秒offer截止。
- **新进程 + 补丁写入早于启动 + after哈希未变 + 正确profile静态导入链，构成这次约定的装载核验证据。** 没有读取内存timer，也没有现场制造25秒超时；API不存在offerTimeoutMs字段，不能拿caps当计时读数。
- 17:24:06.862的既有GET状态：installed=true、status.state=connected；file-peer invokeTotals/refusalTotals条目缺省，recentInvokes/recentRefusals中peer记录均为空。计数确为channel→count对象（host.js:2267–2268）。只记“尚无本机环中手机peer观测”，不是验收成功。
- 本轮只读生产、只更新此报告及工作流；未改生产文件、未重启、未发任何selftest/offer/open、未触发手机或传APK。

## 交主助手保留的唯一用户待办（未执行）

**在现有手机的原项目文件浏览器，选一个允许分享的、非敏感且未缓存的>64KiB小文件（例如约128KiB），点一次原“导出/分享”，保持前台等结果，回报点按时刻和原始提示/是否出现分享结果。不要选1.315GB APK，也不要连续重试。** 无需Android新包或诊断包。

主助手配合，不额外要求用户做诊断：
1. 操作前后及操作窗口内短时有限采样现有 `GET http://127.0.0.1:3080/api/dsh-cindy-host/status`，只保留同手机src关联后的peer at/channel/ok/code、调用/拒绝计数差值；报告对src用别名。若来源不能对应该手机，明确无法归因。不要输出preview、SDP、凭据。
2. 记录用户操作窗口及原提示。若有FILE_PEER_TIMEOUT或其他安全拒绝码，保留原码和完成时间；现环无peer action/请求起始/耗时，不能将点按至提示的总时间伪装成精确offer耗时。
3. 无peer记录就保持“无peer证据”；小文件分享成功或peer计数增长仍可能含OSS回退，**不能独立宣布DataChannel建立或peer完成**。记录实际成功/失败/无法确定阶段即可；主助手在没有可归因peer证据时不得勾掉该真实待办。
4. 本轮没有启动这次采样或手机动作；静态装载通过与手机验收是两项结论，完整APK传输更是后续独立选择。
