/**
 * 在**库层面**证明「导出安装包 → 控制端下载」这条链路已经通了。
 *
 * 这一步之所以必要:`exportFileStart` 只负责把文件 PUT 进中转区,PUT 一直是成功的;
 * 失败发生在控制端 presign-get 之后的 GET 上 —— OSS 会因为 key 的后缀是 `.apk`/`.ipa`
 * 直接回 `400 ApkDownloadForbidden`(与签名、ACL 无关,实测见 `tools/probe-oss-ext.mjs`)。
 * 所以判据不能只看「导出成功」,必须把同一个 key 完整下载回来并按字节核对。
 *
 * 走的是生产同一条构造:`createMediaUploader` + `createMediaRefResolver`,ext 与
 * contentType 与 `host.js` 的导出分支完全一致(真实文件名 `*.apk`)。
 *
 * Usage: node tools/probe-apk-export-roundtrip.mjs [relPath]
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createMediaRefResolver, createMediaUploader, mediaApiBaseUrl } from '../src/host-media.js';
import { loadSession } from '../src/credential-store.js';

const RELAY_WS_URL = 'wss://device-link.cindy.com.cn/api/device-link/ws';
const relPath = process.argv[2] ?? 'artifacts/CindyVerify-94f083331.apk';
const session = await loadSession();
if (session === null || session.accessToken === '') {
  console.error('没有可用的账号会话');
  process.exit(2);
}
const apiBaseUrl = mediaApiBaseUrl(RELAY_WS_URL);
const bytes = await readFile(relPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const ext = extname(relPath).replace(/^\.+/, '');
console.log(`文件 ${relPath}`);
console.log(`  ${bytes.length} 字节, ext=${ext}, sha256=${sha256.slice(0, 16)}…`);

// ---- 上半段:导出侧的上传(与 host.js 的 startFileExport 同构)------------
const upload = createMediaUploader({ apiBaseUrl, getSession: () => session, timeoutMs: 10 * 60_000 });
const uploadStarted = Date.now();
const staged = await upload(bytes, { ext, contentType: 'application/vnd.android.package-archive' });
if (staged.ok !== true) {
  console.error(`上传失败: reason=${staged.reason}`);
  process.exit(1);
}
console.log(`上传完成 ${Date.now() - uploadStarted}ms: key=${staged.key}`);
if (staged.key.toLowerCase().endsWith('.apk')) {
  console.error('!! key 仍以 .apk 结尾:OSS 公网端点会拒绝下载它,修复没有生效');
  process.exit(1);
}

// ---- 下半段:控制端拿这个 key 完整下载回来 -------------------------------
const resolve = createMediaRefResolver({ apiBaseUrl, getSession: () => session, maxBytes: 512 * 1024 * 1024, timeoutMs: 10 * 60_000 });
const downloadStarted = Date.now();
const resolved = await resolve({ ossKey: staged.key, size: bytes.length, sha256 });
const elapsedMs = Date.now() - downloadStarted;
if (resolved.ok !== true) {
  console.error(`下载失败(${elapsedMs}ms): reason=${resolved.reason}`);
  process.exit(1);
}
const received = createHash('sha256').update(resolved.buffer).digest('hex');
const megabytes = resolved.buffer.length / (1024 * 1024);
console.log(`下载完成 ${elapsedMs}ms (${(megabytes / (elapsedMs / 1000)).toFixed(1)} MB/s): ${resolved.buffer.length} 字节`);
if (received !== sha256) {
  console.error(`!! sha256 不一致: local=${sha256.slice(0, 16)} download=${received.slice(0, 16)}`);
  process.exit(1);
}
console.log(`\n${basename(relPath)} 往返一致 ✓ —— 控制端现在能拿到这个安装包了。`);
