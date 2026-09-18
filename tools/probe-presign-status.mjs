/**
 * 逐跳打印「预签名下载」两个请求的真实响应,用来判定 `download-failed` 到底是
 * presign-get 拒绝了这个 key,还是 OSS 拒绝了这个签名 URL 的 GET。
 *
 * `probe-export-download.mjs` 只回报 `download-failed`(resolver 把非 2xx 折叠成
 * 一个 reason),看不到状态码 —— 而状态码决定修哪一边:
 *   403 → ACL / 签名问题(上传时签进去的 `x-oss-object-acl` 与 GET 签名不匹配)
 *   404 → 对象其实没落盘
 *   400/签名过期 → 过期时间
 *
 * Usage:
 *   node tools/probe-presign-status.mjs --key <ossKey>
 *   node tools/probe-presign-status.mjs --latest        # 先导出一个文件拿到新 key
 */
import { createHash } from 'node:crypto';
import { mediaApiBaseUrl } from '../src/host-media.js';
import { loadSession } from '../src/credential-store.js';

const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const hostUrl = argValue('--host') ?? 'http://127.0.0.1:3080';
const base = mediaApiBaseUrl(RELAY_WS_URL);

const session = await loadSession();
if (session === null || typeof session.accessToken !== 'string' || session.accessToken === '') {
  console.error('没有可用的账号会话');
  process.exit(2);
}
console.log(`账号会话: deviceId=${session.deviceId} kind=${session.kind}`);
console.log(`media base: ${base}`);

/** 只保留 query 的键名与长度,签名值绝不落进日志。 */
function redact(url) {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.entries()]
      .map(([name, value]) => `${name}=<${value.length}>`)
      .join('&');
    return `${parsed.origin}${parsed.pathname}${query === '' ? '' : `?${query}`}`;
  } catch {
    return '<invalid-url>';
  }
}

/** 与 host-media.js 的 mediaHeaders 同形。 */
function mediaHeaders(current) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${current.accessToken}`,
  };
}

let key = argValue('--key');
if (key === undefined) {
  const workdir = process.cwd();
  const relPath = 'artifacts/CindyVerify-94f083331.apk';
  const call = (payload) => fetch(`${hostUrl}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((response) => response.json());
  const start = await call({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStart', workdir, relPath }] });
  const transferId = start?.reply?.payload?.result?.transferId;
  if (typeof transferId !== 'string') {
    console.error(`导出没能开始: ${JSON.stringify(start).slice(0, 300)}`);
    process.exit(1);
  }
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await call({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStatus', workdir, transferId }] });
    const result = status?.reply?.payload?.result;
    if (result?.state === 'done') { key = result.key; console.log(`新导出: ${key} (size=${result.size})`); break; }
    if (result?.state === 'error') { console.error(`导出失败: ${String(result.message)}`); process.exit(1); }
  }
  if (key === undefined) { console.error('导出超时'); process.exit(1); }
}

// ---- 第 1 跳:presign-get -------------------------------------------------
console.log('\n=== 1) POST /media/presign-get ===');
const presignStarted = Date.now();
const presignResponse = await fetch(`${base}/media/presign-get`, {
  method: 'POST',
  headers: mediaHeaders(session),
  body: JSON.stringify({ key }),
});
const presignText = await presignResponse.text();
console.log(`status=${presignResponse.status} ${presignResponse.statusText} (${Date.now() - presignStarted}ms)`);
console.log(`body=${presignText.slice(0, 600)}`);
console.log(`content-type=${presignResponse.headers.get('content-type') ?? '<none>'}, x-request-id=${presignResponse.headers.get('x-request-id') ?? '<none>'}`);
if (presignResponse.ok !== true) {
  console.error('\n=> presign-get 本身就拒绝了,问题在 server/账号侧,与 OSS 无关。');
  process.exit(1);
}
const getUrl = JSON.parse(presignText)?.getUrl;
if (typeof getUrl !== 'string' || getUrl === '') { console.error('\n=> 没有 getUrl'); process.exit(1); }
console.log(`getUrl: ${redact(getUrl)}`);

// ---- 第 2 跳:GET 签名的 url ----------------------------------------------
console.log('\n=== 2) GET 签名 url ===');
const getStarted = Date.now();
const getResponse = await fetch(getUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
const getBody = Buffer.from(await getResponse.arrayBuffer());
console.log(`status=${getResponse.status} ${getResponse.statusText} (${Date.now() - getStarted}ms)`);
console.log(`content-length=${getResponse.headers.get('content-length') ?? '<none>'}, content-range=${getResponse.headers.get('content-range') ?? '<none>'}`);
console.log(`content-type=${getResponse.headers.get('content-type') ?? '<none>'}, x-oss-request-id=${getResponse.headers.get('x-oss-request-id') ?? '<none>'}`);
console.log(`etag=${getResponse.headers.get('etag') ?? '<none>'}`);
const bodyText = getBody.toString('utf8');
console.log(`body head: ${bodyText.startsWith('PK') || bodyText.includes('\u0000') ? `<二进制 ${getBody.length} 字节, sha256=${createHash('sha256').update(getBody).digest('hex').slice(0, 16)}…>` : bodyText.slice(0, 800)}`);
if (getResponse.ok !== true) {
  console.error('\n=> 签名 URL 的 GET 被拒,问题在 OSS 侧(ACL/签名/对象)。');
  process.exit(1);
}
console.log('\n=> 两跳都通过:下载链路本身没问题。');
