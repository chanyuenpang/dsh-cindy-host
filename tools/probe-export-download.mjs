/**
 * Prove the **controller's download half** of a file export, without a phone.
 *
 * The export channel itself is already covered (`file-browser:remote-op` start/status,
 * and `npm test`), and this Host can prove the *upload* half too. What a phone does
 * after `exportFileStatus` answers `done` is the part that has no host-side coverage:
 *
 *   1. presign-get the staged `key` from the account's media API, with the account session
 *   2. GET the bytes from the returned url
 *
 * That is exactly what `createMediaRefResolver` does for an inbound attachment, so this
 * probe reuses it with the same session the running Host owns. If this succeeds and the
 * phone still reports 下载失败, the failure is on the phone's side (its network, its
 * downloader, or the presigned url expiring under a 77 MB body) — and if it fails here,
 * the staged object or the presign API is the problem.
 *
 * Usage:
 *   node tools/probe-export-download.mjs --key <ossKey> [--max-mb 200]
 *   node tools/probe-export-download.mjs --latest      # 导出一个文件并立刻下载回来
 */
import { createHash } from 'node:crypto';
import { createMediaRefResolver, mediaApiBaseUrl } from '../src/host-media.js';
import { loadSession } from '../src/credential-store.js';

const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const keyArg = argValue('--key');
const maxMb = Number(argValue('--max-mb') ?? '200');
const hostUrl = argValue('--host') ?? 'http://127.0.0.1:3080';

const session = await loadSession();
if (session === null || typeof session.accessToken !== 'string' || session.accessToken === '') {
  console.error('没有可用的账号会话:先在设置页登录');
  process.exit(2);
}
console.log(`account session: deviceId=${session.deviceId} kind=${session.kind}`);

let key = keyArg;
if (key === undefined) {
  // `--latest`:导出项目里的测试包,拿到 key 后立刻按手机的方式下载回来。
  const workdir = process.cwd();
  const relPath = 'artifacts/CindyVerify-94f083331.apk';
  const start = await fetch(`${hostUrl}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStart', workdir, relPath }] }),
  }).then((response) => response.json());
  const transferId = start?.reply?.payload?.result?.transferId;
  if (typeof transferId !== 'string') {
    console.error(`导出没能开始: ${JSON.stringify(start).slice(0, 300)}`);
    process.exit(1);
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await fetch(`${hostUrl}/api/dsh-cindy-host/selftest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStatus', workdir, transferId }] }),
    }).then((response) => response.json());
    const result = status?.reply?.payload?.result;
    if (result?.state === 'done') { key = result.key; break; }
    if (result?.state === 'error') {
      console.error(`导出失败: ${String(result.message)}`);
      process.exit(1);
    }
  }
  if (key === undefined) {
    console.error('导出超时');
    process.exit(1);
  }
  console.log(`staged key: ${key}`);
}

const resolveRef = createMediaRefResolver({
  apiBaseUrl: mediaApiBaseUrl(RELAY_WS_URL),
  getSession: () => session,
  maxBytes: Math.max(1, maxMb) * 1024 * 1024,
  // 默认 30 秒是给「取一张图」的预算;这里要的是 77MB 的安装包,给足时间,
  // 否则测出来的是探针自己的超时,而不是对象/接口的问题。
  timeoutMs: 300_000,
});
const startedAt = Date.now();
const resolved = await resolveRef({ ossKey: key });
const elapsedMs = Date.now() - startedAt;
if (resolved.ok !== true) {
  console.error(`下载失败(${elapsedMs}ms): reason=${resolved.reason}`);
  process.exit(1);
}
const bytes = resolved.buffer;
console.log(
  `下载成功: ${bytes.length} 字节, ${elapsedMs}ms, mime=${String(resolved.mimeType)}, `
  + `sha256=${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…`,
);
if (key.includes('94f083331') || key.endsWith('.apk')) {
  const onDisk = await import('node:fs/promises')
    .then((fs) => fs.stat('artifacts/CindyVerify-94f083331.apk'))
    .catch(() => null);
  if (onDisk !== null && onDisk.size !== bytes.length) {
    console.error(`!! 字节数与本地文件不一致: local=${onDisk.size} downloaded=${bytes.length}`);
    process.exit(1);
  }
  console.log('本地文件字节数与下载一致 ✓');
}
