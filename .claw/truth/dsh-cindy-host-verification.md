# Verification and projection exclusion rules

<!-- state: current -->
## Current behavior

The whole suite runs with `node --test` (`npm test`) on Node 22 or newer, with no
test dependencies beyond the dev-only React pair. The suite is **446/446 passing**
across 41 test files (the runner also reports the `test/fixtures` pair and
`test/support/oss-ref.js` as support entries). The parent plan recorded 82/82, an
earlier pass recorded 84/84, and a later one 403/403; the tree has grown far past all
of them, so the number in this document is the one to verify against. The channel
surface is 52 served channels with 0 unclassified (`npm run audit:channels`).

What each layer must prove:

- Projection and privacy: the projection deliberately excludes message bodies, prompt
  input, tool calls and results, approval/question payloads, file paths and content,
  credentials, and command sending. Only the conversation list (opaque session ID,
  title, phase, update time) and activity summaries (added / removed / status) cross
  it, and the Cindy transport consumes only what the projection already produced.
- Stream recovery: a stream failure emits a generic stale marker (never raw error
  text) and refreshes the conversation baseline, with no duplicate rebaseline while
  one is in flight.
- Runtime: relay frames, the 20 s heartbeat, state derivation, revoke handling, and
  the switch-off teardown in `test/host.test.js`, `test/host-status.test.js`, and
  `test/authorization-policy.test.js`.
- Login: identifier validation and the `ok` / nested-token / `select_account` /
  `binding_required` / `sso_verification_required` outcome mapping in
  `test/cindy-login-flow.test.js`.
- HTTP surface: loopback-only `403`, status shapes, unknown-route `404`,
  runtime-not-ready `503`, body limits (`413`/`400`), and the handler-failure `500` in
  `test/host-routes.test.js`.
- Card: `test/client-card.test.js` renders the card with React (settings plug-in item
  key `dsh-cindy-host`, switch, the five labels, login form, device rows), so card
  markup and state rules are covered without a browser.
- Bundle and composition: `test/dsh-plugin.test.js` and `test/host-settings.test.js`
  cover mounting and settings validation; the isolated smoke test covers composition
  and lifecycle only, and is not a projection test.
- Media fetch: `test/host-media-fetch.test.js` covers downsample success, the
  input/product-over-limit fallbacks, non-downsamplable mime types, the small-original
  inline fallback, and the staging cache; `tools/acceptance.mjs` checks live that a
  `thumbnail: true` fetch answers either inline bytes or a key with a well-formed shape
  (including the base64 length and the 700 KiB ceiling).
- History view: `test/host-history-view.test.js` covers work grouping and the
  page/detail cursor semantics (`hasMore`/`nextCursor`); `test/cindy-channels.test.js`
  and `test/cindy-channels-fail-closed.test.js` cover channel-layer forwarding and
  fail-closed refusals; `tools/acceptance.mjs` checks a live view page, a
  `work-details` range, and `view-intent` accepting an expanded set. Both are only
  meaningful on a process restarted after the channels landed.

Verification rules:

- Run `npm test` before the smoke gates; a clean run is the entry gate.
- Gate 1: `dsh --profile cindy-smoke --dump-config` with a disposable `DSH_HOME`
  must compose the bundle.
- Gate 2: `dsh --profile cindy-smoke --no-open --port 3081` must show a running host
  with no Cindy authentication prompt; the card bundle is the `dsh-cindy-host-demo`
  entry of `window.__DSH_BOOT__`.
- **The clean-install gate is one gate, and it must prove loading.** It is run in a
  **brand-new `DSH_HOME`** (not the sandbox) with a profile derived from a real one
  (`--from-default-profile web`, so it has a web server to answer on):
  `dsh plugin --profile <new> add <tarball>` → exit 0; then assert **`profile-local
  @deepseek-ai == 0`** (the plugin must contribute nothing to the host's module tree);
  then `--dump-config` → exit 0 with the `dsh-cindy-host` row; then **start it and read
  `/api/dsh-cindy-host/status` → 200 `installed=true`**.
- **Composition is not loading.** This paragraph used to claim the second half of the
  pair was blocked "for DSH-side reasons only", with the evidence being a failing stack
  that named `@deepseek-ai/dsh-client-file-upload`. That conclusion was **wrong**: the
  stack named a DSH package because *we* had installed a whole other DSH generation
  (28 `@deepseek-ai/*@^0.1.1-rc.2` behind our `optionalDependencies` entry) into the
  profile, and the fresh profile then composed a mixture of two generations. `0.1.2`
  fixed it, and the same fresh-home procedure now ends in `200 installed=true`. The
  retained rule: when a stack frame names someone else's package, first ask **where that
  copy resolved from and which generation it is**, and never accept `--dump-config`
  passing as evidence that an entry can load — a missing named export composes fine and
  kills the profile at load time. See `.claw/adr/0010`.
- Release channel: **0.1.2 is on the npm registry** (`npm publish --access public`;
  `dsh plugin --profile <p> add dsh-cindy-host-demo@0.1.2`). A release is verified by
  installing **from the channel a user would use**, into a brand-new home: for the
  registry that means `add dsh-cindy-host-demo@<version>` with no local path, then
  `profile-local @deepseek-ai == 0`, then a real start and a `/status` read. Reading the
  version back with `npm view` is part of it, and a `404` in the first minute after
  publishing is replication lag, not a failed publish.
  0.1.1 was a **GitHub Release tarball** instead (`v0.1.1` + `dsh-cindy-host-demo-0.1.1.tgz`)
  and its asset is defective — kept as history, never to be installed.
- Live endpoint check on that port: `GET /api/dsh-cindy-host/status` → `200`, an
  unknown route → `404`, `POST …/login/request-code` with an empty identifier → `400`.
- Switch-off proof: after turning the switch off, status returns `disconnected`,
  device ledger and host identity are cleared, and the process holds 0 established
  sockets.
- Browser automation of the card's polling/login interaction is not available in this
  checkout; that interaction is covered by the React render tests plus the live
  `status` endpoint.
- Restart rule: a change that adds a channel or a `link-accept` capability is only
  verifiable after `dsh web` is restarted. Until then the old process answers
  `CHANNEL_NOT_ALLOWED` for the new channel and advertises no new capability, so an
  acceptance run against the old process proves nothing about the change.

Code anchors:

- `test/*.test.js` (41 files; the media-fetch and history-view suites are named above)
- `src/projection.js`, `src/contracts.js`, `src/projection-read-model-sink.js`,
  `src/session-publisher.js`, `src/session-read-model.js`
- `README.md` ("Safe isolated DSH smoke test", 「安装要求：需要编译原生模块」)
- `tools/acceptance.mjs`, `tools/channel-audit.mjs` (`npm run audit:channels`)
- `doc/publishing.md` (§5.1–§5.5: the clean-install traps, the install requirement, the
  tarball re-install trap, the DSH-side fresh-profile failure, and the 0.1.1 release
  channel)
- `doc/cindy-phone-link.md` ("Verifying by hand"; 「收尾：媒体取件补齐 + 历史视图通道」；
  「真机复测清单（累计）」)

## 文档断言的复核（2026-09-17）

一次独立复核用了比会话默认更强的模型（`deepseek-official / deepseek-v4-pro`），三个 reviewer 并行、
各自只读，分工是：新增四节 vs 源码与测试、两处「已被推翻」表述的横向一致性、发布文档 vs 可验证的
客观事实（`package.json`、`npm pack --dry-run`、`git tag`、`gh release view`、各数字断言实际跑出来）。
每个 reviewer 的立场是**怀疑**：找不到证据的算 unsupported，与代码相反的算 contradicted，两者都必须
给出 `文件:行号` 或命令输出。

结果值得记下来，因为**错误的类型比数量更有信息量**：

| 类型 | 实例 |
|---|---|
| 把只在一个方向成立的行为写成通例 | 「运行中的卡片永远是最后一行」——`mergePendingByTime` 的 `runsNow` 带 `!newestFirst` 前提，新到旧的列表不重排 |
| 把两处代码的功劳写在一起 | `pulseRepair` 补的是输入投影 + 视图失效；turn 状态是 `markDeviceReachable` 补的 |
| 计数口径写错 | 用 `recentPushes[].watchers` 判断「推送还在发」——那个数是 `recordPush` 收到的**可达数**，`offlineDevices` 会让它变 0 |
| 陈旧数字 | README「407 项」vs 实测 446；`doc/cindy-phone-link.md`「48 served / 144 declined」vs 实测 52 / 140 |
| 与实现相反的注释 | `src/host.js` 5 处仍写「订阅会因 presence 离线被删」 |
| 断链 | CHANGELOG 的 `[0.1.0]` 指向不存在的 release，`[0.1.1]` 没有链接定义 |

**留下的规则**：文档里每一句关于行为的断言都要能落到「文件:行号」或一条可跑的命令；不能这样落地的
（例如鸿蒙那条 OS 侧观测）必须**明确标注**为真机观测、并指向留存的记录，不能让读者以为它可以
从代码验出来。数字类断言一律**实际跑命令**再写，不引用文档里另一处的说法。

仍然无法在仓库内验证的：那条 OS 侧读方向失效本身（只有一次真人实测的留存记录），以及各文档中未被
本次覆盖的章节（`doc/publishing.md` §1/§2/§4/§6、README 其余数字、CHANGELOG 历史条目、
`doc/cindy-phone-link.md` 前四节）。

Code anchors:

- `.claw/truth/dsh-cindy-host-mobile-resume-limitation.md`（那条 OS 侧观测的留存记录）
