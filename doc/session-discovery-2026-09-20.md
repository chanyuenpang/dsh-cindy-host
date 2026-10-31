# 助手会话在手机默认列表缺失：2026-09-20 排查

## 状态与结论

未完成真机验收；后续操作前只读检查发现目标已为 active，持久归档条目已消失（非本修复会话执行恢复）；计划继续等待真机验收。
本轮仅增加回归与本文档，没有业务源码补丁，没有改动宿主设置、安装包、Cindy 或 DSH 核心，没有重启。

直接原因证据是 **Host 按稳定 ID 将目标会话投影为 archived**，并非 Host 没发现它。尚不能归因于误操作、客户端发错 patch 或改名；没有归档写入时刻/操作者证据。也不能据此排除恢复后仍存在独立手机传输问题。

目标：session-b19a5c27-8bc6-4ba9-a2ea-4786ba88815f，工作区 G:\Projects\助手。

## 脱敏运行证据

2026-09-20 12:33 UTC 左右只读访问现行 http://127.0.0.1:3080/api/dsh-cindy-host/status：

- state=connected，dataSource=session-controller。
- recentInvokes 中 12:29:32.921Z 至 12:31:08.932Z 的成功 local-db:sessions:list 回复预览均包含目标 ID。
- 目标行 title=09-20，workingDir=G:\Projects\助手，status=archived，running=true；createdAt=2026-09-20T07:01:52.583Z。
- 12:31:08 的目标 updatedAt 已更新为 12:30:06.909Z：并非仅停留在旧标题/旧活动的列表。
- 当次 subscriptions.sessions=[]：没有目标的实时订阅。不能把 Host 回复成功当作手机收到。
- C:/Users/chany/.dsh/settings.yaml:281-282 是目标 ID 对应的 status: archived，未修改该文件。其他会话和凭据不复制到报告。
- 压缩会话文件首个解压帧的 header：同一 ID、cwd=G:\Projects\助手、createdAt=1789887712583、delegationDepth=0、isSeeded=false。仅检查首帧 header，**没有据此断言历史总量或完整性**。

实际持久 header 与回复路径一致。目前无旧名变更审计，不能确认用户所说的改名具体对象及时间；当前标题确认为 09-20。

## 代码证据与缓存边界

- src/dsh-session-source.js:43-46 仅过滤 subagent、blank、parentSessionId；:218-219 读取 controller 列表。:250-287 以 sessionId 为键关联标题与元数据，不按标题匹配。
- src/session-flags.js:63-76、133-156：flags 以 sessionId 为键；archived/deleted 被隐藏，标题无关。
- src/cindy-session-row.js:53-71：扁平 id 不变，归档状态写入手机行；既有客户端契约默认筛选 active。
- src/cindy-channels.js:959-1002：title-only patch 仅重命名；只有显式 status/pinnedAt 才写 flags。恢复用同 ID 的 status: active；写后失效行缓存。安装 profile 的同一代码段已只读核对一致。
- src/dsh-plugin.js:1388-1389：flags 通过 settings.mutate 的 set 整体替换，避免旧 merge 无法清除归档的问题。
- src/cindy-channels.js:569-604：get/history 使用 sessionId；:504-555：重订阅 session:<ID> 时推送 turn/input/history invalidation；不按标题恢复。
- 列表 stale-while-revalidate 和标题 TTL 可短暂显示旧标题；它们不改变 ID，也不制造 archived。未尝试清缓存。

## 回归

新增 test/session-identity-recovery.test.js，使用真实 source/router/flags 与注入服务，三条测试：

1. 改名后同 ID、创建时间、历史读取 ID 不变；同名不同 ID 分离；旧订阅 topic 重连仍指向原 ID，并触发 input/history 补同步。
2. 旧格式 archived + 空 pinnedAt 可读取；改名不自动取消归档；显式恢复清除缓存及持久标记，仅恢复目标而非同名另一会话。
3. 外部标题改动在现有标题与行缓存 TTL 后收敛，ID/active 状态不变。

相关四文件测试：94/94 通过。
npm test：556/556 通过，exit 0。
这验证 Host 合同，不是真机验收，也不是生产历史完整性的证明。

## 给助手的下一步（待协调，未执行）

1. 告知用户该 ID 已归档而不是消失。经确认，在现有客户端归档视图对 **该 ID** 执行恢复（既有 patch-meta status: active），不要按“09-20”标题猜选，不改其他会话。
2. 验证真实 Host 行变为 active、持久 flags 不再包含该 ID 的 archived。使用既有恢复路径通常不需部署或重启；本轮仅测试/文档无运行时代码需要发布。
3. 真机确认默认列表出现该会话、旧历史可读、桌面/手机继续同步；后台返回或断线后重订阅仍是同一 ID；同名另一会话不串线。
4. 如果归档视图无法恢复或恢复后仍丢失，收集恢复请求的脱敏 channel/ID/status、Host 回复与手机订阅证据，再决定最小业务补丁归属。不盲清数据库/配对，不先改 Cindy 或安装核心。

当前没有真实手机操作能力，未执行上述验收。不要将本报告或测试通过描述为“已修复手机”。

## 后续授权恢复：操作前状态已恢复

收到助手安排后恢复计划，按要求先只读检查 archived 前置条件，没有直接编辑 settings，也没有提取凭据或尝试绕过认证。

- 现行 3080 status 的 recentInvokes 中，2026-09-20T12:41:48.89Z 和 12:41:52.649Z 两条真实 sessions:list 成功回复均记录目标 ID 为 **active**。
- 同一行 title 仍为 09-20，workingDir 仍为 G:\Projects\助手，createdAt 仍为 2026-09-20T07:01:52.583Z。
- 再次只读精确搜索 C:/Users/chany/.dsh/settings.yaml 中的完整目标 ID，结果为 0 条；原来 :281-282 的目标 archived 条目已不存在。未输出其他会话设置。
- 因“仍 archived”前置条件不成立，本修复会话没有发出 patch-meta 或其他写操作；避免重复恢复或覆盖并发操作。恢复操作者及具体写入来源未核实，不归功于本会话。
- 上述 Host 证据来自状态接口保存的实际列表回复，不是主动调用新的列表 RPC，也不是手机接收证据。未核验完整历史内容或手机继续同步。

Host 侧期望状态已观察到，无部署、重启或新增业务补丁需求。剩余最小用户动作是：在手机现有连接刷新/重进会话列表，打开这一精确 ID 对应会话，验证旧历史与继续同步；如仍不可用，保留具体症状和订阅/请求证据再继续排查。无需再次取消归档，更不要清配对或数据库。
