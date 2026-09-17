#!/usr/bin/env node
/**
 * The aggregated remote file browser, exercised the way the phone's file screen
 * does: one channel, dispatched by `op`, addressing paths as workdir + relPath.
 *
 * Usage: node tools/probe-file-browser.mjs [--base …] [--workdir <path>]
 */

const args = process.argv.slice(2);
const pick = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : args[at + 1];
};
const BASE = pick('--base', 'http://127.0.0.1:3081');
const WORKDIR = pick('--workdir', process.cwd());

async function op(request) {
  const response = await fetch(`${BASE}/api/dsh-cindy-host/selftest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'file-browser:remote-op', args: [{ workdir: WORKDIR, ...request }] }),
  });
  const envelope = await response.json().catch(() => null);
  if (envelope === null) return { ok: false, error: { code: 'UNPARSEABLE', message: `HTTP ${response.status}` } };
  return envelope.reply?.payload ?? { ok: false, error: { code: 'NO_REPLY' } };
}

function show(label, payload, max = 260) {
  if (payload.ok !== true) {
    console.log(`  ERR  ${label.padEnd(22)} ${payload.error?.code ?? '?'} :: ${payload.error?.message ?? ''}`);
    return payload;
  }
  let json = JSON.stringify(payload.result);
  if (json === undefined) json = 'undefined';
  if (json.length > max) json = `${json.slice(0, max)}...`;
  console.log(`  OK   ${label.padEnd(22)} ${json}`);
  return payload;
}

console.log(`workdir: ${WORKDIR}\n`);

show('caps', await op({ op: 'caps' }));
show('listDir (root)', await op({ op: 'listDir', relPath: '' }), 300);
show('listDir (src)', await op({ op: 'listDir', relPath: 'src' }), 300);
show('readFile', await op({ op: 'readFile', relPath: 'package.json' }), 200);
show('listAllFiles', await op({ op: 'listAllFiles' }), 240);
console.log('');
show('unknown op', await op({ op: 'thumbnail', relPath: 'package.json' }));
show('escape attempt', await op({ op: 'readFile', relPath: '../../../Windows/win.ini' }));
show('bad args', await op({}));
