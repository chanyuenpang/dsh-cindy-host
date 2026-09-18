/**
 * 真机验证判据的**一次性读取器**:把「后台回前台是否自愈」这件事变成一段可判定的输出。
 *
 * 手机端没有落盘日志,所以判据全在 Host 侧:
 *   1. 手机自报的停摆/恢复(经未知通道名上报,落在 refusal 日志里)
 *      - `tdiag.stall.s<秒>.r<次数>.<来源>`    ← 发现计时器停摆(层 1 触发)
 *      - `tdiag.recover.after<秒>s.r<次数>.<来源>` ← 心跳重新走起来
 *      - `psdiag.*`                          ← device-link 侧的对端静默自报(旧判据)
 *   2. 手机自己的调用时间线:停摆期间**一次调用都没有**,恢复后应重新出现
 *      `local-db:messages:view` / `view-intent`(实时刷新)。
 *   3. 连接层:reconnect 次数、订阅是否还在、handlerErrors 是否为空。
 *
 * 判读:
 *   - 有 stall 且随后有 recover,且恢复后手机重新开始轮询 → **自愈成功**;
 *   - 有 stall 没有 recover,但恢复后手机重新开始轮询 → 计时器没救回来,但层 2 让界面活了;
 *   - 有 stall、没有 recover、且手机始终不再轮询 → 两层都没兜住,需要改成 push 直接驱动。
 *
 * Usage: node tools/verify-timer-stall.mjs [--device fd50cf89] [--host http://127.0.0.1:3080]
 */
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const hostUrl = argValue('--host', 'http://127.0.0.1:3080');
const devicePrefix = argValue('--device', 'fd50cf89');

const body = await fetch(`${hostUrl}/api/dsh-cindy-host/status`).then((response) => response.json()).catch(() => null);
if (body === null) {
  console.error(`读不到 ${hostUrl}/api/dsh-cindy-host/status`);
  process.exit(1);
}
const diagnostics = body.diagnostics ?? {};
const local = (iso) => (typeof iso === 'string' ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '<none>');

// 手机自报:优先用 0.1.7 起专门的 phoneDiagnostics(带时刻、不被普通流量冲掉),
// 否则退回 refusal 环里筛同前缀的条目(0.1.6 也够用:测试时 Host 空闲,环不会被冲)。
const fromRing = (diagnostics.recentRefusals ?? []).filter((entry) => /^(tdiag|psdiag)\./.test(String(entry.channel)));
const reports = Array.isArray(diagnostics.phoneDiagnostics) && diagnostics.phoneDiagnostics.length > 0
  ? diagnostics.phoneDiagnostics
  : fromRing;
console.log(`手机自报(${reports.length} 条,来源:${diagnostics.phoneDiagnostics === undefined ? 'recentRefusals 环' : 'phoneDiagnostics'}):`);
for (const entry of reports) {
  const tag = String(entry.channel);
  const verdict = tag.startsWith('tdiag.stall') ? '停摆'
    : tag.startsWith('tdiag.recover') ? '恢复'
      : '对端静默';
  console.log(`  ${local(entry.at)}  [${verdict}]  ${tag}${entry.src ? `  src=${String(entry.src).slice(0, 8)}` : ''}`);
}
if (reports.length === 0) console.log('  (还没有:新包未安装,或尚未触发停摆)');

const stalls = reports.filter((entry) => String(entry.channel).startsWith('tdiag.stall'));
const recovers = reports.filter((entry) => String(entry.channel).startsWith('tdiag.recover'));

// 手机自己的调用时间线:只在「停摆窗口」内看它是否完全不问;恢复后是否重新问。
const phoneCalls = (diagnostics.recentInvokes ?? []).filter((entry) => String(entry.src ?? '').startsWith(devicePrefix));
console.log(`\n手机调用(${phoneCalls.length} 条,最近 ${phoneCalls.length > 0 ? local(phoneCalls[0].at) : '-'} → ${phoneCalls.length > 0 ? local(phoneCalls[phoneCalls.length - 1].at) : '-'}):`);
let previousAt = null;
for (const entry of phoneCalls) {
  const at = Date.parse(entry.at);
  const gap = previousAt === null ? 0 : Math.round((at - previousAt) / 1000);
  previousAt = at;
  console.log(`  ${local(entry.at)}  (+${String(gap).padStart(4)}s)  ${String(entry.channel)}`);
}
const pollChannels = new Set(['local-db:messages:view', 'local-db:messages:view-intent', 'maker:list-active']);
const polls = phoneCalls.filter((entry) => pollChannels.has(String(entry.channel)));
console.log(`  其中周期性轮询 ${polls.length} 次${polls.length > 0 ? `,最后一次 ${local(polls[polls.length - 1].at)}` : ''}`);

console.log('\n连接层:');
console.log(`  reconnect: ${JSON.stringify(diagnostics.reconnect ?? null)}`);
console.log(`  subscriptions.sessions: ${JSON.stringify(diagnostics.subscriptions?.sessions ?? null)}`);
console.log(`  handlerErrors: ${JSON.stringify(diagnostics.handlerErrors ?? null)}`);
console.log(`  frameBudget: ${JSON.stringify(diagnostics.frameBudget ?? null)}`);
const device = (body.status?.devices ?? []).find((entry) => String(entry.deviceId).startsWith(devicePrefix));
console.log(`  手机: ${device === undefined ? '<未在设备表>' : `online=${device.online} lastSeen=${local(device.lastSeenAt)}`}`);

console.log('\n判读:');
if (stalls.length === 0) {
  console.log('  还没有停摆自报 —— 要么没装新包,要么这次没有进入停摆状态。');
} else if (recovers.length > 0) {
  console.log(`  有停摆自报(${stalls.length} 条)也有恢复自报(${recovers.length} 条)→ 层 1 的心跳重建生效。`);
  console.log(`  恢复延迟看最后一条:${recovers[recovers.length - 1].channel}`);
} else {
  console.log(`  有停摆自报(${stalls.length} 条)但**没有恢复自报** → 计时器没能从 JS 侧复活。`);
  console.log('  这时看上面手机调用线:若恢复后重新出现 messages:view/view-intent,说明层 2 让界面活了(不需要重启 App);');
  console.log('  若始终不再轮询,两层都没兜住,下一步把 App 的实时循环改成 push 事件直接驱动。');
}
