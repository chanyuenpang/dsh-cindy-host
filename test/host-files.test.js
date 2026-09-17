import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileReader, PREVIEW_LIMIT_BYTES } from '../src/host-files.js';

/**
 * A `ctx.fs` double: the DSH filesystem speaks `FsTarget` handles, so resolve
 * hands back an opaque handle the other calls take.
 */
function makeFs({ files = {}, dirs = {}, root = 'G:\\work' } = {}) {
  const handles = new Map();
  let next = 0;
  return {
    resolve(path) {
      const key = String(path);
      const handle = handles.get(key) ?? (() => {
        const created = { key, id: next++ };
        handles.set(key, created);
        return created;
      })();
      if (files[key] === undefined && dirs[key] === undefined) return Promise.resolve(handle);
      return Promise.resolve(handle);
    },
    processPath(target) {
      return target.key;
    },
    stat(target) {
      const file = files[target.key];
      if (file !== undefined) return Promise.resolve({ version: 1, type: 'file', size: file.size });
      if (dirs[target.key] !== undefined) return Promise.resolve({ version: 1, type: 'directory' });
      return Promise.resolve(undefined);
    },
    listDir(target) {
      const entries = dirs[target.key];
      if (entries === undefined) return Promise.reject(new Error('not a directory'));
      return Promise.resolve(entries.map((entry) => ({
        name: entry.name,
        type: entry.type,
        target: { key: `${target.key}\\${entry.name}` },
      })));
    },
    readByteRange(target, range) {
      const file = files[target.key];
      if (file === undefined) return Promise.reject(new Error('no such file'));
      return Promise.resolve(Buffer.from(file.text.slice(range.offset, range.offset + range.length)));
    },
    root,
  };
}

test('stats a path in the controller vocabulary', async () => {
  const reader = createFileReader({
    fileSystem: makeFs({ files: { 'G:\\work\\a.txt': { size: 12, text: 'hello world' } }, dirs: { 'G:\\work': [] } }),
  });

  assert.deepEqual(await reader.statPath('G:\\work\\a.txt'), { kind: 'file', resolvedPath: 'G:\\work\\a.txt' });
  assert.deepEqual(await reader.statPath('G:\\work'), { kind: 'dir', resolvedPath: 'G:\\work' });
  assert.deepEqual(await reader.statPath('G:\\nope'), { kind: 'missing', resolvedPath: 'G:\\nope' });
});

test('lists a directory, naming each entry path from the filesystem', async () => {
  const reader = createFileReader({
    fileSystem: makeFs({
      dirs: {
        'G:\\work': [
          { name: 'src', type: 'directory' },
          { name: 'a.txt', type: 'file' },
          { name: 'link', type: 'other' },
        ],
      },
    }),
  });

  const result = await reader.listDir('G:\\work');
  assert.equal(result.resolvedPath, 'G:\\work');
  assert.equal(result.parent, 'G:\\', 'a drive root keeps its separator; `G:` would resolve to that drive’s current directory');
  assert.deepEqual(result.entries, [
    { name: 'src', kind: 'dir', path: 'G:\\work\\src' },
    { name: 'a.txt', kind: 'file', path: 'G:\\work\\a.txt' },
    // DSH's `'other'` is how a symlink or special file arrives.
    { name: 'link', kind: 'symlink', path: 'G:\\work\\link' },
  ]);
});

test('a directory that cannot be listed answers empty rather than failing the call', async () => {
  const reader = createFileReader({ fileSystem: makeFs({ dirs: {} }) });
  assert.deepEqual(await reader.listDir('G:\\nope'), { resolvedPath: 'G:\\nope', entries: [], parent: 'G:\\' });
});

test('reports the parent as null at a drive root, and for a POSIX root', async () => {
  const reader = createFileReader({ fileSystem: makeFs({ dirs: { 'G:\\': [] } }) });
  assert.equal((await reader.listDir('G:\\')).parent, null);

  const posix = createFileReader({ fileSystem: makeFs({ dirs: { '/': [] } }) });
  assert.equal((await posix.listDir('/')).parent, null);
  assert.equal((await posix.listDir('/etc')).parent, '/');
});

test('reads a text preview with its size', async () => {
  const reader = createFileReader({ fileSystem: makeFs({ files: { 'G:\\a.txt': { size: 11, text: 'hello world' } } }) });
  const result = await reader.readTextPreview('G:\\a.txt');
  assert.equal(result.success, true);
  assert.equal(result.data, 'hello world');
  assert.equal(result.size, 11);
});

test('refuses a preview that is too large instead of silently truncating it', async () => {
  const reader = createFileReader({
    fileSystem: makeFs({ files: { 'G:\\big.txt': { size: PREVIEW_LIMIT_BYTES + 1, text: 'x' } } }),
  });
  const result = await reader.readTextPreview('G:\\big.txt');
  assert.equal(result.success, false);
  assert.equal(result.reason, 'oversize', 'a silently cut preview reads as the whole file');
  assert.equal(result.limitMb, 1);
});

test('reports the controller reasons it renders for a missing or unreadable file', async () => {
  const reader = createFileReader({ fileSystem: makeFs({ files: {}, dirs: { 'G:\\adir': [] } }) });
  assert.deepEqual(await reader.readTextPreview('G:\\nope'), { success: false, reason: 'not_found', size: 0 });
  assert.deepEqual(await reader.readTextPreview('G:\\adir'), { success: false, reason: 'not_found', size: 0 }, 'a directory is not a preview');

  const unreadable = createFileReader({
    fileSystem: { ...makeFs({ files: {} }), stat: async () => ({ type: 'file', size: 3 }), readByteRange: async () => { throw new Error('denied'); }, processPath: (t) => t.key, resolve: async () => ({ key: 'p' }) },
  });
  assert.deepEqual(await unreadable.readTextPreview('p'), { success: false, reason: 'read_failed', size: 3 });
});

test('a filesystem that refuses to resolve a path yields missing, not a throw', async () => {
  const reader = createFileReader({
    fileSystem: { resolve: async () => { throw new Error('outside the sandbox'); }, processPath: () => '', stat: async () => undefined, listDir: async () => [], readByteRange: async () => new Uint8Array() },
  });
  assert.equal((await reader.statPath('C:\\windows')).kind, 'missing');
  assert.equal((await reader.readTextPreview('C:\\windows')).reason, 'not_found');
});

test('requires a filesystem service', () => {
  assert.throws(() => createFileReader({ fileSystem: undefined }), /requires a filesystem/);
});
