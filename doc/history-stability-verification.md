# Cindy 历史投影与运行中同步稳定性验证

实现阶段只修改 Host 读投影与传输策略，当时未发布、安装、重启，未做手机白屏验收。后续发布准备和本地升级必须单独核验，不能把自动回归当作真机闭环。

## 实现合同

- 历史页与详情统一使用 source-order snapshot。持久后端仍先 flush、校验连续 prefix；备用 reader 与原始窗口共用缓存 fold/reducer，原始窗口既有消息内顺序不变。
- 临时 reasoning 的 id 为 history-live: 加逻辑 clientId；正常落盘后 durable id 不变、clientId 保持同一逻辑块身份。旧引用由事件 replay 重建，不写日志或新增数据库。只有原生 turn/step/block 证据充分时才建立对应。
- before/first/last/after 在同一 snapshot 解析。分页先截源位置前缀再分组；未知游标明确 NOT_FOUND，不返回最老页冒充连续历史。取消无 durable 替身时只保留可重建的分页 cut，不复活正文。
- thinking 的原始 created 只对成功写入当前 relay socket 历史最新页的控制端过滤，不把 socket 写入当远端应用 ACK。pending/失败端仍走 raw；状态按授权控制端、会话订阅和连接生命周期隔离。
- 1s latest-wins reasoning 快照去重，按序列化 UTF-8 payload 计 32 KiB/s、64 KiB burst、单次64 KiB。该预算在 fan-out 之前计量，不是所有控制端合计的总网络上界。超大 interim 不裁剪冒充全文；完整正文仍由 raw 读取/显式 details/最终 durable 消息提供。
- 自动 preview 至多5行且引用正文序列化总量不超过6 KiB；过大尾行省略 preview。完整 details 与既有单大项/媒体整帧处理不变。不移植原生 work patch 或完整工具分类。

## 自动回归

已执行 npm test：1209 项中 1201 通过、8 跳过、0 失败。已执行 node tools/channel-audit.mjs：249 个通道，75 served / 174 declined / 0 unclassified；git diff --check 通过。跳过项不计为已完成的原生环境或手机验收。

新增回归覆盖：冷/热两路径、相同/倒退时间戳、多块、落盘别名、取消 cut、40行分块、未知/跨会话游标、UTF-8 preview 预算、持久化失败；双控制端、pending/read/send失败、退订重订、断链/旧代完成；虚拟时钟60秒累计字节预算、未变块去重、超大多字节 interim、终态后无迟到快照。原有媒体、输入回声、错误与交互测试继续执行。

## 0.1.37 发布准备验证

发布准备时重新执行全量 Host 回归，并显式启用已编译 DSH 0.2.1-rc.5 的原生 Cordis/UserQuestions/Gateway 隔离契约测试：**1209 项中 1205 通过、4 跳过、0 失败**。四个原生交互用例均通过；其余跳过的长时上传/外部 Cindy 消费门禁不计为已验收。通道静态分类仍为 **249 项：75 served / 174 declined / 0 unclassified**。该结果与上述实现阶段默认测试记录分别保留，不代表已完成手机白屏真机闭环。

## 尚待真机的验收

在用户确认安装候选修复版本后，以同一 Android 手机和相近内容分别测试：原生任务/DSH任务、运行中/停止输出、短/长历史、工作组折叠/显式展开、快速反复上下滚动，以及后台返回和断线重连。

记录客户端版本、准确时间和白屏范围（仅列表，或连导航/输入框一起消失），保留同一故障的本地诊断与 Android JS/RN/Fabric/内存异常栈，并与 Host 分页帧/调用和推送计量对齐。修复前后对比，验证没有内容缺口、错序、重复/迟到思考卡，权限/终态/媒体不丢。

自动回归与模拟负载通过只证明 Host 合同，不证明白屏根因已闭环或所有设备已修复。
