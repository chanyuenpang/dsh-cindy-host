/**
 * 给一个工作目录内的文件,打印一条**可直接点开的下载链接**。
 *
 * 走的是这条链路里唯一正确的做法:让**正在运行的 Host** 自己去导出(`file-browser:remote-op`
 * 的 `exportFileStart`/`exportFileStatus`,与手机点「导出/分享」完全同一条路),拿到暂存 key
 * 后本机用账号会话 presign-get,把签名地址打出来 —— 手机/浏览器直接 GET 就能落盘,不必再在
 * App 的文件浏览器里翻目录。
 *
 * 注意:key 由 server 生成,安装包类文件的后缀会被中性化成 `.bin`(阿里云 OSS 拒发
 * `.apk`/`.ipa`,见 `stageableStaging`),所以下载下来的文件名是 `<uuid>.bin`,
 * **装之前需要在文件管理器里改名回 `.apk`**。App 内的「导出/分享」不受影响:它按浏览到的
 * 文件名 (`.apk`) 命名自己那一份。
 *
 * Usage:
 *   node tools/export-download-link.mjs <relPath> [--workdir <dir>] [--host http://127.0.0.1:3080]
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createMediaUploader, mediaApiBaseUrl } from '../src/host-media.js';
import { loadSession } from '../src/credential-store.js';

const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const relPath = args.find((value, index) => !value.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--')));
if (relPath === undefined) {
  console.error('用法: node tools/export-download-link.mjs <relPath> [--workdir <dir>]');
  process.exit(2);
}
const workdir = argValue('--workdir', process.cwd());
const hostUrl = argValue('--host', 'http://127.0.0.1:3080');

const session = await loadSession();
if (session === null || session.accessToken === '') {
  console.error('没有可用的账号会话');
  process.exit(2);
}

const call = (payload) => fetch(`${hostUrl}/api/dsh-cindy-host/selftest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then((response) => response.json());

let key;
let size;
if (args.includes('--direct')) {
  // 不经过运行中的 Host:它内存里可能还攥着一个已过期的会话(实测:存储里刷新过之后,
  // Host 仍然 401 —— 它只在启动时读一次存储)。这条路直接用存储里的会话上传并签名。
  const bytes = await readFile(relPath);
  const upload = createMediaUploader({
    apiBaseUrl: mediaApiBaseUrl(RELAY_WS_URL),
    getSession: () => session,
    timeoutMs: 10 * 60_000,
  });
  const staged = await upload(bytes, {
    ext: extname(relPath).replace(/^\.+/, ''),
    contentType: 'application/octet-stream',
  });
  if (staged.ok !== true) {
    console.error(`直接上传失败: ${staged.reason}`);
    process.exit(1);
  }
  key = staged.key;
  size = bytes.length;
  console.log(`已直接上传(${basename(relPath)}, ${bytes.length} 字节): ${key}`);
} else {
  const start = await call({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStart', workdir, relPath }] });
  const startResult = start?.reply?.payload?.result;
  if (startResult?.ok !== true) {
    console.error(`导出没能开始: ${JSON.stringify(startResult ?? start).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`导出已开始: transferId=${startResult.transferId} size=${startResult.size}`);
  size = startResult.size;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    const status = await call({ channel: 'file-browser:remote-op', args: [{ op: 'exportFileStatus', workdir, transferId: startResult.transferId }] });
    const result = status?.reply?.payload?.result;
    if (result?.state === 'done' && typeof result.key === 'string') { key = result.key; size = result.size ?? size; break; }
    if (result?.state === 'error') { console.error(`导出失败: ${String(result.message)}`); process.exit(1); }
  }
  if (key === undefined) { console.error('导出超时'); process.exit(1); }
  console.log(`已暂存: ${key}`);
}

const presign = await fetch(`${mediaApiBaseUrl(RELAY_WS_URL)}/media/presign-get`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
  body: JSON.stringify({ key }),
});
if (presign.ok !== true) {
  console.error(`presign-get 拒绝: ${presign.status} ${(await presign.text()).slice(0, 200)}`);
  process.exit(1);
}
const { getUrl, expiresAt } = await presign.json();

// 先自证这条链接真的能取到字节,再把链接交出去 —— 免得用户点开才发现是 400。
const probe = await fetch(getUrl, { method: 'GET', headers: { Range: 'bytes=0-15' } });
console.log(`自检: GET ${probe.status} ${probe.statusText}, content-range=${probe.headers.get('content-range') ?? '<none>'}`);
if (probe.ok !== true) {
  console.error(`链接不可用: ${(await probe.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log('');
console.log(`文件: ${relPath}(${size} 字节)`);
console.log(`过期: ${String(expiresAt ?? 'server 未给出')}`);
console.log(`下载链接(下载后文件名是 <uuid>${key.slice(key.lastIndexOf('.'))},装之前改回 .apk):`);
console.log(getUrl);
