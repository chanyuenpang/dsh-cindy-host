import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileBrowser, resolveInside, READ_LIMIT_BYTES } from '../src/host-file-browser.js';

/** A filesystem double over a literal tree, with the `ctx.fs` surface. */
function fakeFs(tree) {
  const statOf = (path) => tree[path] ?? null;
  const readOf = (path) => tree[path]?.content ?? '';
  return {
    resolve: async (path) => {
      const clean = String(path).replace(/\/+$/, '');
      if (statOf(clean) === null && !Object.keys(tree).some((key) => key.startsWith(`${clean}/`))) {
        throw new Error(`no such path: ${path}`);
      }
      return { path: clean };
    },
    stat: async (target) => {
      const node = statOf(target.path);
      if (node === null) throw new Error('missing');
      return { type: node.type, size: node.size ?? (node.content ?? '').length, mtimeMs: node.mtimeMs ?? 0 };
    },
    listDir: async (target) => {
      // Separator-agnostic: the tree is written with Windows separators and the
      // double must not assume which one the module joins with.
      const prefix = target.path.endsWith('\\') || target.path.endsWith('/') ? target.path : `${target.path}\\`;
      const names = new Set();
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest === '' || rest.includes('\\') || rest.includes('/')) continue;
        names.add(rest);
      }
      return [...names].sort().map((name) => ({ name, type: tree[`${prefix}${name}`].type, target: { path: `${prefix}${name}` } }));
    },
    readByteRange: async (target, { length }) => Buffer.from(readOf(target.path).slice(0, length), 'utf8'),
  };
}

const TREE = {
  'G:\\work': { type: 'directory' },
  'G:\\work\\src': { type: 'directory' },
  'G:\\work\\src\\main.ts': { type: 'file', content: 'const a = 1;\n', mtimeMs: 42 },
  'G:\\work\\readme.md': { type: 'file', content: '# hi\n' },
};

test('a relative path can never leave the work directory', () => {
  // `relPath` arrives over the relay, and the work directory is the whole point
  // of the guard.
  assert.equal(resolveInside('G:\\work', ''), 'G:\\work');
  assert.equal(resolveInside('G:\\work', 'src'), 'G:\\work\\src');
  assert.equal(resolveInside('G:\\work', 'src/main.ts'), 'G:\\work\\src\\main.ts');
  assert.equal(resolveInside('G:\\work', './src/./main.ts'), 'G:\\work\\src\\main.ts');
  assert.equal(resolveInside('G:\\work', 'src/../readme.md'), 'G:\\work\\readme.md');
  // Above the root is outside, and is refused rather than normalised away.
  assert.equal(resolveInside('G:\\work', '..'), null);
  assert.equal(resolveInside('G:\\work', '../etc/passwd'), null);
  assert.equal(resolveInside('G:\\work', 'src/../../x'), null);
  assert.equal(resolveInside('G:\\work', 'src/..'), 'G:\\work');
  assert.equal(resolveInside('', 'x'), null);
  // An absolute-looking relPath is still treated as relative to the workdir.
  assert.equal(resolveInside('G:\\work', '/src'), 'G:\\work\\src');
});

test('caps answers without touching the filesystem', async () => {
  // The controller reads this as the capability probe, and the reference host
  // answers it before its own workdir guard for exactly that reason.
  const browser = createFileBrowser({ fileSystem: { resolve: async () => { throw new Error('must not resolve'); } } });
  assert.deepEqual(await browser({ op: 'caps', workdir: 'G:\\work' }), { ok: true });
});

test('listDir answers the bare array the controller normalises', async () => {
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });
  const entries = await browser({ op: 'listDir', workdir: 'G:\\work', relPath: '' });
  assert.deepEqual(entries.map((entry) => entry.relPath), ['readme.md', 'src']);
  assert.deepEqual(entries.map((entry) => entry.type), ['file', 'directory']);
  assert.equal(entries[0].name, 'readme.md');
  assert.equal(entries[0].size, 5);
  // A nested listing carries the relative path the controller sends back.
  const nested = await browser({ op: 'listDir', workdir: 'G:\\work', relPath: 'src' });
  assert.deepEqual(nested.map((entry) => entry.relPath), ['src/main.ts']);
  // DSH's filesystem reports no modification time (`FsInfo` is `version`, `type`,
  // `size`), so this is 0 — "unknown", which the controller's normaliser also
  // defaults to. A date here would be something nothing ever observed.
  assert.equal(nested[0].mtimeMs, 0);
});

test('readFile answers text, and refuses what the controller cannot render', async () => {
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });
  const read = await browser({ op: 'readFile', workdir: 'G:\\work', relPath: 'readme.md' });
  assert.equal(read.ok, true);
  assert.equal(read.data.content, '# hi\n');
  assert.equal(read.data.relPath, 'readme.md');

  // A directory is not a file, and a NUL byte means the bytes would be mojibake.
  const dir = await browser({ op: 'readFile', workdir: 'G:\\work', relPath: 'src' });
  assert.equal(dir.ok, false);
  assert.equal(dir.code, 'READ_FAILED');

  const binaryTree = { 'G:\\work': { type: 'directory' }, 'G:\\work\\x.bin': { type: 'file', content: 'a\u0000b' } };
  const binary = await createFileBrowser({ fileSystem: fakeFs(binaryTree) })({ op: 'readFile', workdir: 'G:\\work', relPath: 'x.bin' });
  assert.equal(binary.ok, false);
  assert.equal(binary.code, 'BINARY_FILE');
});

test('readFile refuses a file larger than the inline limit, with its stat', async () => {
  const big = { 'G:\\work': { type: 'directory' }, 'G:\\work\\big.txt': { type: 'file', content: 'x'.repeat(READ_LIMIT_BYTES + 1) } };
  const result = await createFileBrowser({ fileSystem: fakeFs(big) })({ op: 'readFile', workdir: 'G:\\work', relPath: 'big.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'OVERSIZE');
  assert.equal(result.stat.size, READ_LIMIT_BYTES + 1);
});

test('an escaping path reaches no op at all', async () => {
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });
  // `listDir` answers null — the reference host's "could not list" — and an
  // escaping path must never be listed, read, or walked.
  assert.equal(await browser({ op: 'listDir', workdir: 'G:\\work', relPath: '../secret' }), null);
  const read = await browser({ op: 'readFile', workdir: 'G:\\work', relPath: '../secret' });
  assert.equal(read.ok, false);
  assert.equal(read.code, 'READ_FAILED');
  const walk = await browser({ op: 'listAllFiles', workdir: 'G:\\work', relPath: '../secret' });
  assert.deepEqual(walk.files, []);
});

test('listAllFiles walks the tree and reports its own truncation', async () => {
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });
  const all = await browser({ op: 'listAllFiles', workdir: 'G:\\work' });
  assert.deepEqual(all.files.sort(), ['readme.md', 'src/main.ts']);
  assert.equal(all.truncated, false);
  assert.equal(typeof all.elapsedMs, 'number');

  const capped = await createFileBrowser({ fileSystem: fakeFs(TREE), listAllLimit: 1 })({ op: 'listAllFiles', workdir: 'G:\\work' });
  assert.equal(capped.files.length, 1);
  // Truncated is a claim the controller must be able to see: an incomplete list
  // shown as complete is a wrong answer, not a short one.
  assert.equal(capped.truncated, true);
});

test('an op this Host does not serve says so instead of answering emptily', async () => {
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });
  // An op the controller asks for and this Host cannot serve *for a stated
  // reason* answers in that op's own documented shape, so the controller degrades
  // deliberately: `THUMB_UNSUPPORTED` is the reference host's own code for "this
  // host cannot make a thumbnail", and the export ops say what is missing.
  assert.deepEqual(await browser({ op: 'thumbnail', workdir: 'G:\\work', relPath: 'readme.md' }), {
    ok: false,
    code: 'THUMB_UNSUPPORTED',
    message: 'this Host generates no thumbnails',
  });
  const exportStart = await browser({ op: 'exportFileStart', workdir: 'G:\\work', relPath: 'readme.md' });
  assert.equal(exportStart.ok, false);
  assert.match(exportStart.message, /media pipeline/);

  // An op neither host knows is still reported as unknown — never as an empty
  // success, which would tell the controller a real file has no content.
  assert.deepEqual(await browser({ op: 'teleport', workdir: 'G:\\work' }), { ok: false, message: 'unknown op: teleport' });
  assert.deepEqual(await browser(null), { ok: false, message: 'invalid remote-op args' });
  assert.deepEqual(await browser({ op: 'caps' }), { ok: false, message: 'invalid remote-op args' });
});

test('searchCollect answers the controller’s own shape, with a bounded budget', async () => {
  const TREE = {
    'G:\\work': { type: 'directory' },
    'G:\\work\\node_modules': { type: 'directory' },
    'G:\\work\\node_modules\\dep.ts': { type: 'file', content: 'findme in a dependency\n' },
    'G:\\work\\a.ts': { type: 'file', content: 'const x = 1;\n// findme here\nconst y = 2;\n' },
    'G:\\work\\b.md': { type: 'file', content: 'FindMe again\nsecond line\n' },
  };
  const browser = createFileBrowser({ fileSystem: fakeFs(TREE) });

  const result = await browser({ op: 'searchCollect', workdir: 'G:\\work', query: 'findme' });
  // The controller's shape has no `ok` field: matches, truncation and counts.
  assert.deepEqual(Object.keys(result).sort(), ['matches', 'totalFiles', 'totalMatches', 'truncated']);
  assert.deepEqual(result.matches, [
    { relPath: 'a.ts', lineNumber: 2, lineText: '// findme here' },
    { relPath: 'b.md', lineNumber: 1, lineText: 'FindMe again' },
  ]);
  assert.equal(result.truncated, false);
  assert.equal(result.totalMatches, 2);
  // `node_modules` is skipped on purpose (the reference host's ripgrep honours
  // `.gitignore`, this Host cannot), so it is not counted as a searched file.
  assert.equal(result.totalFiles, 2);

  // Case sensitivity and the match cap are the controller's to ask for.
  const sensitive = await browser({ op: 'searchCollect', workdir: 'G:\\work', query: 'findme', caseSensitive: true });
  assert.deepEqual(sensitive.matches.map((match) => match.relPath), ['a.ts']);
  const capped = await browser({ op: 'searchCollect', workdir: 'G:\\work', query: 'findme', maxMatches: 1 });
  assert.equal(capped.matches.length, 1);
  assert.equal(capped.truncated, true, 'a capped result must say it was capped');
  assert.equal(capped.totalMatches, 2);

  // A query that is not a valid regular expression is searched as text, because
  // that is what the user meant by typing it.
  const literal = await browser({ op: 'searchCollect', workdir: 'G:\\work', query: 'findme (' });
  assert.deepEqual(literal.matches, []);
  assert.deepEqual(await browser({ op: 'searchCollect', workdir: 'G:\\work', query: '' }), {
    matches: [],
    truncated: false,
    totalMatches: 0,
    totalFiles: 0,
  });
});
