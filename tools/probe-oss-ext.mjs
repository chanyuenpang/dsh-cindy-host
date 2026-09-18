/**
 * 摸清 OSS 公共域名(oss-cn-shanghai.aliyuncs.com)**禁止下载**的扩展名。
 *
 * 背景:导出安装包时 `presign-get` 正常返回 200 + 签名 URL,但 GET 该 URL 立刻收到
 * `400 ApkDownloadForbidden` —— OSS 按对象 key 的扩展名拦截 `.apk` 的公网端点下载,
 * 与签名/ACL 无关。本探针用几十字节的小对象逐个扩展名实测,决定 staging 时要避开
 * 哪些后缀(真实导出改用一个中性后缀即可,文件名由控制端自己取)。
 *
 * Usage: node tools/probe-oss-ext.mjs [ext ...]
 */
import { mediaApiBaseUrl } from '../src/host-media.js';
import { loadSession } from '../src/credential-store.js';

const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const base = mediaApiBaseUrl(RELAY_WS_URL);
const session = await loadSession();
if (session === null || session.accessToken === '') {
  console.error('没有可用的账号会话');
  process.exit(2);
}
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` };
const rawArgs = process.argv.slice(2);
const ctIndex = rawArgs.indexOf('--content-type');
const CONTENT_TYPE = ctIndex >= 0 ? rawArgs[ctIndex + 1] : 'application/octet-stream';
const extArgs = rawArgs.filter((value, index) => !value.startsWith('--') && index !== ctIndex + 1);
const EXTS = extArgs.length > 0 ? extArgs : ['apk', 'ipa', 'bin', 'zip', 'txt', 'exe', 'dmg', 'apks'];

const BYTES = Buffer.from('cindy-oss-ext-probe-payload-0123456789', 'utf8');

/** 一次上传+下载,回 `{ ext, put, get, code }`;`code` 是 OSS 的 <Code> 或 HTTP 状态。 */
async function probeExt(ext) {
  const contentType = CONTENT_TYPE;
  const presign = await fetch(`${base}/media/presign-put`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ size: BYTES.length, ext, contentType }),
  });
  const presignText = await presign.text();
  if (presign.ok !== true) return { ext, put: `presign-put ${presign.status}`, get: '-', code: presignText.slice(0, 120) };
  const { putUrl, key } = JSON.parse(presignText);
  const put = await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': contentType, 'x-oss-object-acl': 'private' }, body: BYTES });
  if (put.ok !== true) return { ext, put: `PUT ${put.status}`, get: '-', code: (await put.text()).slice(0, 160).replace(/\s+/g, ' ') };
  const getPresign = await fetch(`${base}/media/presign-get`, { method: 'POST', headers, body: JSON.stringify({ key }) });
  if (getPresign.ok !== true) return { ext, put: `PUT 200 (${key.split('/').pop()})`, get: `presign-get ${getPresign.status}`, code: '' };
  const { getUrl } = await getPresign.json();
  const got = await fetch(getUrl, { method: 'GET' });
  const body = await got.text();
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? '';
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1] ?? '';
  return {
    ext,
    put: `PUT 200 → key …${key.slice(key.lastIndexOf('.'))}`,
    get: `GET ${got.status}`,
    code: code === '' ? `ok(${body.length}b)` : `${code}: ${message}`,
  };
}

console.log(`media base: ${base}`);
console.log(`对象 Content-Type: ${CONTENT_TYPE}\n`);
for (const ext of EXTS) {
  try {
    const result = await probeExt(ext);
    console.log(`[${result.get === 'GET 200' ? '可用' : '被拒'}] .${ext.padEnd(6)} ${result.put.padEnd(34)} ${result.get.padEnd(11)} ${result.code}`);
  } catch (error) {
    console.log(`[异常] .${ext.padEnd(6)} ${String(error?.message ?? error)}`);
  }
}
