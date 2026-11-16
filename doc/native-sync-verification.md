# 原生实时同步：实现与验证

## 范围与部署边界

本轮修改 Host 工作区，不修改官方 Cindy/DSH 安装源码、配置或用户会话，不安装、发布或重启。运行中的已安装包仍是旧的 0.1.43；本工作区的未发布修改不会自动出现在手机上。参考合同为安装版 DSH 0.2.2-rc.3 与本地 Cindy 官方源码。实际手机构建、网络 RTT 和绘制延迟尚未验证。

## 实现合同

- [原生展示源](<../src/native-assistant-source.js>) 对每个被订阅 session 共享一个 `sessionController.follow({address, activate:false, assistantStream:true, maxMessages:1})`。先消费官方 opening baseline/已覆盖记录，再接 dense revision/index 帧；中途订阅恢复完整前缀，不唤醒 Agent。
- DSH durable log 仍是已提交事实唯一 owner。瞬态 revision 不进入 durable seq。按 attemptId 和精确 `end.outcome.eventType + seq` 结算；处理 end/commit 两种先后、terminal 先于 opening、terminal 插在 commit/end 之间、Agent 替换和重试。gap 清空旧投影，最多三次 source opening（重试退避 250/500ms）；缺少 assistant baseline 明确记为 unsupported，不伪造成功。
- [Host 投递](<../src/host.js>) 首片立即，持续更新 50ms 微批；正文走官方 `maker:event` delta/full-prefix，安全单 running work leaf 走 `maker:history-work-patch`，不额外伴随整页 notice。新组、结构变化、版本不匹配、终态走普通历史刷新。展开详情单独以 500ms 窗口刷新。
- [投递基线](<../src/history-delivery-state.js>) 只接纳真正拟合并发送成功的 latest page；expanded intent 和 base/version 属于 controller/session/accepted lease。异步读取前后检查 source/socket generation、授权、topic、hidden 与版本，失败不推进 base。
- 官方手机把 text delta 暂存 32ms，但删除消息不 flush 该队列。因此删除临时正文前，先发送同 id 已发送完整前缀的 nonfinal snapshot 作为消费屏障，再发 deletion；失败不推进。断线/退订的退休 receipts 按账号、realm、Host 绑定，最多32条、单条1MiB、合计4MiB；不得跨账号复用。
- raw thinking 保留 32KiB/s、64KiB burst、单次64KiB UTF-8预算；预算不足保持 latest 完整快照并 trailing 重试。正文全前缀修复上限256KiB；超出明确记录 `waiting-durable`，不截断冒充全文。原生展示源的公开字符串最多1MiB/512个非空公开块，opening compact replay最多65536 chunks；这些是局部预算，不是整个 WebSocket、堆或端到端内存上界。
- [历史投影](<../src/host-history-view.js>) 使用 source-owned `projection:{identity,version,sealedPrefixLength}` 与 `historyContentStamp` 缓存封口前缀，只重算可变尾部；无版本合同的 legacy rows 保守重算。前缀映射与 grouping 各自最多保留三个 session，与原 transcript LRU 对齐。重复 stored id、source gap、展示偏好变更会解除旧前缀承诺。
- [只读后缀 Array 视图](<../src/readonly-row-suffix.js>) 避免每个 token 复制整个 durable prefix；显式全枚举仍是线性，尾部 slice 不读取前缀。它是内部可丢弃展示数据结构，不是新持久化格式。
- [工作行](<../src/history-work-lines.js>) 最多5行、160字符、6KiB；只对直接可证明的工具事实生成 descriptor，复杂/拆分命令诚实保留 generic。不声称完整复制 Cindy 的所有工具描述器。

## 验证与测量边界

修改前默认 `node --test`：1243 tests，1235 pass，8 skipped，0 fail。

最终回归（清空通用 `CINDY_SOURCE_ROOT`，仅设置 `CINDY_HISTORY_SOURCE_ROOT=G:\Projects\Cindy`）：1288 tests，1280 pass，8 skipped，0 fail；官方历史控制器验证实际执行且通过。通道审计覆盖259个可命名invoke、38个客户端push channel，均为0 unclassified；`git diff --check` 通过。8个条件跳过测试不作为已验证能力。

新增测试覆盖 native baseline/增量/精确结算、重试与 terminal 竞态、private字段、预算、controller隔离、patch CAS、断线与账号 fence、文本删除屏障、LRU/source快照、偏好失效，以及真正的 Host seam 不重复 flush/读日志。`test/native-history-client-contract.test.js` 可读取官方 `historyViewController.ts` 和 `historyView.ts`（去类型后执行），证明安全 patch 即刻应用，丢 base 的 patch 不被错误应用。手机真机和完整 mobile store 没有据此被认定验收通过。

```powershell
# 默认回归（现有需要运行安装/Gateway等条件的测试仍可能跳过）
node --test
# 只启用本次官方历史控制器的源码验证，不触发无关的模型界面加载器
$env:CINDY_HISTORY_SOURCE_ROOT='G:\Projects\Cindy'
node --test test/native-history-client-contract.test.js
npm run audit:channels
git diff --check
# 离线真实 source -> plugin seam -> history 热路径探针，无模型/账号/网络 IO
node tools/native-sync-probe.mjs
```

一次隔离运行的预热探针：10行历史/1000增量约38.04ms，100000行历史/1000增量约37.25ms；两者 warm log reads=0、grouped rows=1000、全文 hash rows=0、stamped hash rows=1000。该数字不含首次 seed、relay、手机渲染，也不是 p95 或稳定倍数承诺。更早一次集成探针还暴露100000行时1790.7ms的线性复制成本，随后增加只读 suffix 与前缀偏好缓存；前后样本负载不同，不据此声称普适加速倍数。

第一次使用通用 `CINDY_SOURCE_ROOT` 启用全量外部源码测试时，共3项失败：一项是已过期的“history-work-patch 未实现”兼容清单（现已更新清单，保留其余拒绝断言）；另外两项是已有模型界面外部加载器无法处理当前官方 JSON import attribute / `@/lib` alias。后两项不是本次历史协议验证，未修改其期望或冒称通过。本次改用独立 `CINDY_HISTORY_SOURCE_ROOT` 隔离验证；默认的条件跳过边界保持不变。

## 待部署与真机验收

安装前按项目发布流程处理候选版本/打包；仅在用户允许的维护窗口安装和加载 Host，不能因源码测试通过就擅自中断正在运行的会话。加载后核对诊断 `nativeAssistant` / `historyProjection`、Host push totals 与 `liveAssistant.waitingDurable`，再用同一手机和网络对照官方。

测量应分开记录 Host frame receive/queue/send 与手机 receive/apply/首个可见 render；跨设备时钟未校准不能直接相减。比较中文思考首片、正文首片、持续更新 p50/p95、每秒字节、page/details次数，并覆盖中途进入、掉线重连、请求重试、停止、双手机和撤权。本文没有宣称真机分钟级延迟已被实测消除。
