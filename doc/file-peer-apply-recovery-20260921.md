# file-peer 中断后核验：未应用，漂移停手

核验时间：2026-09-21 16:05（+08）。**安装版仍为15秒；未完成本补丁应用。已发生宿主重启，但不能把它当作补丁生效。按授权中的PID/环境漂移停止条件，未继续edit或再次重启。**

## 当前事实

- 3080监听PID **41128**，启动 **15:53:31.409**；原授权预检目标是PID40916/原cwd C:/Users/chany。
- web profile解析入口仍为 `C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src/dsh-plugin.js`，安装包版本 **0.1.10**。
- 安装目标 `C:/Users/chany/.dsh/profiles/web/node_modules/dsh-cindy-host-demo/src/host-file-peer.js:185` 仍为 `15_000`，12465字节，最后写入仍是2026-09-20 18:54:14。
- 目标SHA256：`bad5bf48fbe711e7248a71d9902d1fb688dd6d2a2df89232a532deba7525df6e`，等于before，**不是**预期after `c9d44db98c630a6c0d863aef40721e7f4606b7fd9e803b5db4cc0c7ebc5484fa`。
- 已有原字节备份：`G:/Projects/DSH-cindy-host/.sandbox/offer-hotfix-2026-09-21T07-29-56.561Z/host-file-peer.js.before`；恢复时重新核磁盘SHA256，精确等于before。保留，不覆盖。
- 本会话中断前只完成PID/before预检、restart dry-run、原安装文件备份及52运行文件的内存hash快照；**未执行目标edit，也未提交--apply**。内存快照不视为重启后仍可用的持久基线。

## 实际重启审计

只读 `C:/Users/chany/.agents/logs/dsh-restart/host-restart.log:34–39`（未读含token的dsh-web.log）：

| 日志时间（换算+08） | 事实 |
|---|---|
| 15:29:25–15:29:27 | 记录60秒重启请求，target40916，args=[web]，cwd=C:/Users/chany |
| 15:30:28.779 | started pid41144 |
| 15:52:28–15:52:31 | 又记录60秒重启请求，target41144，args=[web]，**cwd=G:/Projects/claw-kit** |
| 15:53:31.500 | started pid41128；与当前监听进程相符 |

日志证明两次重启，**不证明本补丁被写入，也不在此猜测由哪个会话发起**。最后一次启动目录已与原应用方案不一致；不重放旧PID/旧cwd，亦不擅自把新目标纳入原授权。

## 最小只读状态与阻碍

16:05:40 `GET http://127.0.0.1:3080/api/dsh-cindy-host/status`：installed=true，status.state=connected；peer调用/拒绝计数字段未出现、peer拒绝环为空。该状态仅说明Host在线，不代表25秒代码已加载、peer已建立或手机接收成功。

**阻碍：原PID守卫已不匹配，且最新启动cwd改变。** 原任务2仍未完成，任务3尚不能验收。原claw计划转等待，保留备份/检查事实，绝不标作修复完成。未碰question/index/session-bridge，不重发APK、不加Android构建前置，不修改生产。

## 下一步

由主助手协调并确认以哪个现宿主及cwd继续；若再次授权应用，先重新核实时PID/cwd、profile、before hash和其他运行文件基线，再按原单文件/备份/after hash/60秒重启约束执行，不能沿用本报告PID作为未来盲操作目标。没有成功应用的证据前，不要求用户做手机修复后验收。应用后才按原报告验证新PID/安装hash/静态导入链，再等用户一次原Export入口非敏感、未缓存>64KiB小文件的安全观测。
