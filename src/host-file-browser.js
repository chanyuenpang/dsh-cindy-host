/**
 * The aggregated remote file browser (`file-browser:remote-op`).
 *
 * The controller's file screen does not use the `fs:*` / `text-file:*` reads this
 * Host already serves; it calls **one** channel and dispatches on `op`
 * (`apps/desktop/src/main/file-browser/device-op.ts` on the reference host, whose
 * shapes the controller documents as field-for-field). Two consequences shape
 * this module:
 *
 *  - every op addresses a path as `workdir` + `relPath`, not an absolute path, so
 *    the work directory is the security boundary and **every** join must be
 *    proved to stay inside it;
 *  - several ops answer with their own `ok` discriminant rather than as invoke
 *    failures, because the controller renders those reasons (`OVERSIZE`,
 *    `BINARY_FILE`, `READ_FAILED`, `THUMB_UNSUPPORTED`). An op this Host cannot
 *    serve at all answers `{ ok: false, message }`, which is exactly what the
 *    reference host returns for an op it does not know.
 */

/** Longest file this Host will inline for `readFile`. */
export const READ_LIMIT_BYTES = 1024 * 1024;

/** Longest `listAllFiles` walk, in entries. */
export const LIST_ALL_LIMIT = 5000;

/**
 * Search caps, matching the reference host's own collection bound
 * (`SEARCH_COLLECT_MAX_MATCHES` in device-op.ts) so a controller sees the same
 * ceiling from either host.
 */
export const SEARCH_MATCH_LIMIT = 500;

/** Files one search will open before it stops, and the largest file it will read. */
export const SEARCH_FILE_LIMIT = 2000;
export const SEARCH_FILE_BYTES = 512 * 1024;

/**
 * How far past the collection cap a search keeps counting.
 *
 * The controller renders `totalMatches`, so the count has to be the real one, not
 * "how many I kept" — but a pathological file cannot be allowed to stall the
 * relay, so counting stops at this multiple of the cap.
 */
export const SEARCH_MATCH_SCAN_FACTOR = 10;

/**
 * How many files a search reads at once, and how long it may take in total.
 *
 * Every read is a round trip through the filesystem service (resolve, stat, read),
 * so a serial walk of a real repository measured **6.4 s** for 117 files — long
 * enough that a phone gives up on the spinner. Reading a few at a time keeps the
 * result order while cutting the wall clock, and the time budget is the honest
 * bound the reference host also has (`SEARCH_COLLECT_TIMEOUT_MS`, 20 s there).
 */
export const SEARCH_CONCURRENCY = 8;
export const SEARCH_TIME_BUDGET_MS = 8000;

/** Longest line kept for one match; the controller renders a single row per hit. */
export const SEARCH_LINE_CHARS = 400;

/**
 * Directory names a search walks past.
 *
 * The reference host searches through ripgrep, which honours `.gitignore` — so it
 * skips a project's `node_modules` and build output without being told. This Host
 * has no gitignore engine, and walking those trees would turn a search of a large
 * repository into a multi-second scan whose results the reference host would not
 * have returned either. The skip is therefore an explicit, documented difference
 * rather than a silent one.
 */
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.sandbox', 'dist', 'build', '.next', 'target']);

/** Whether a workdir-relative path lies under a skipped directory. */
function isSkippedPath(relPath) {
  return String(relPath).split(/[\\/]+/).some((segment) => SEARCH_SKIP_DIRS.has(segment));
}

/**
 * Compile the controller's query.
 *
 * The reference host searches with ripgrep, so the query is a **regular
 * expression**; a query that cannot compile is treated as a literal instead of
 * failing the search, because a user searching for `foo(` means that text.
 * @param query - the controller's query.
 * @param caseSensitive - whether case matters.
 * @returns a pattern with `test`.
 */
export function compileSearchQuery(query, caseSensitive) {
  try {
    return new RegExp(query, caseSensitive === true ? '' : 'i');
  } catch {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, caseSensitive === true ? '' : 'i');
  }
}

/**
 * Join a work directory and a controller-supplied relative path, refusing to
 * leave the work directory.
 *
 * `relPath` is attacker-adjacent input: it arrives over the relay and the whole
 * point of the workdir guard is that a controller cannot read outside the
 * session's directory. Traversal is therefore resolved **segment by segment** and
 * a `..` that would climb above the root is refused outright rather than
 * normalised away, so a caller cannot reach a path the guard never saw.
 *
 * @param workdir - the session's work directory.
 * @param relPath - the controller's path, relative to it (`''` is the root).
 * @returns the absolute path, or null when the path would escape.
 */
export function resolveInside(workdir, relPath) {
  if (typeof workdir !== 'string' || workdir.trim() === '') return null;
  const base = workdir.replace(/[\\/]+$/, '');
  const segments = [];
  for (const part of String(relPath ?? '').split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Above the root is outside the work directory, whatever the filesystem
      // would have resolved it to.
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const separator = base.includes('\\') ? '\\' : '/';
  return segments.length === 0 ? base : `${base}${separator}${segments.join(separator)}`;
}

/** The workdir-relative form of one entry, in the controller's separator. */
function relOf(baseRel, name) {
  return baseRel === '' ? name : `${baseRel}/${name}`;
}

/**
 * A byte buffer looks binary when it carries a NUL in its first block.
 *
 * The reference host answers `BINARY_FILE` rather than sending bytes the
 * controller would render as mojibake, and this is the same cheap test.
 */
function looksBinary(text) {
  return text.includes('\u0000');
}

/**
 * Build the remote-op handler over one filesystem service.
 * @param options - the filesystem service, plus injectable limits.
 * @returns `(args) => Promise<unknown>`, one result per op.
 */
export function createFileBrowser({ fileSystem, readLimitBytes = READ_LIMIT_BYTES, listAllLimit = LIST_ALL_LIMIT }) {
  if (fileSystem === undefined || fileSystem === null) throw new Error('createFileBrowser requires a filesystem service');

  /** Resolve a workdir-relative path, or null when it escapes or cannot resolve. */
  async function open(workdir, relPath) {
    const absolute = resolveInside(workdir, relPath);
    if (absolute === null) return null;
    try {
      const target = await fileSystem.resolve(absolute);
      return { absolute, target };
    } catch {
      return null;
    }
  }

  /**
   * `listDir`, with the resolved handle kept.
   *
   * The handle is what saves a round trip: a file read needs `stat` + `read`, and
   * re-resolving every path by hand adds a third filesystem call per file. The
   * handle never leaves this module — `listDir` strips it, because it is a
   * `FsTarget` and the controller is not owed a filesystem identity.
   */
  async function listDirRaw(workdir, relPath) {
    const dirRel = String(relPath ?? '').replace(/^[\\/]+/, '');
    const opened = await open(workdir, dirRel);
    if (opened === null) return null;
    let raw;
    try {
      raw = await fileSystem.listDir(opened.target);
    } catch {
      return null;
    }
    const entries = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (entry === null || typeof entry !== 'object') continue;
      const name = String(entry.name ?? '');
      if (name === '') continue;
      const type = entry.type === 'directory' ? 'directory' : 'file';
      // `FsDirEntry` carries the size itself, so no per-entry stat is needed.
      let size = Number.isFinite(entry.size) ? entry.size : 0;
      if (type === 'file' && !Number.isFinite(entry.size)) {
        try {
          const info = await fileSystem.stat(entry.target);
          if (Number.isFinite(info?.size)) size = info.size;
        } catch {
          // An entry that cannot be sized is still an entry the user can open.
        }
      }
      entries.push({
        relPath: relOf(dirRel.replace(/^\/+/, ''), name),
        type,
        name,
        size,
        // See below: DSH's filesystem reports no modification time, so this is 0 —
        // "unknown", which is also what the controller's normaliser defaults to.
        mtimeMs: 0,
        target: entry.target,
      });
    }
    return entries;
  }

  /** `listDir` — a bare entries array, which is what the controller normalises. */
  async function listDir(workdir, relPath) {
    const entries = await listDirRaw(workdir, relPath);
    if (entries === null) return null;
    return entries.map(({ target, ...entry }) => entry);
  }

  /** `readFile` — text only, with the reference host's own refusal codes. */
  async function readFile(workdir, relPath) {
    const opened = await open(workdir, relPath);
    if (opened === null) return { ok: false, code: 'READ_FAILED', message: 'path does not resolve inside the work directory' };
    let info;
    try {
      info = await fileSystem.stat(opened.target);
    } catch {
      info = undefined;
    }
    const size = Number.isFinite(info?.size) ? info.size : 0;
    // See `listDir`: the filesystem reports no modification time.
    const mtimeMs = 0;
    if (info?.type === 'directory') return { ok: false, code: 'READ_FAILED', message: 'path is a directory' };
    if (size > readLimitBytes) {
      return { ok: false, code: 'OVERSIZE', message: 'file is larger than this Host will inline', stat: { relPath, type: 'file', size, mtimeMs } };
    }
    let bytes;
    try {
      bytes = await fileSystem.readByteRange(opened.target, { offset: 0, length: readLimitBytes });
    } catch (error) {
      return { ok: false, code: 'READ_FAILED', message: String(error?.message ?? error) };
    }
    const text = Buffer.from(bytes).toString('utf8');
    if (looksBinary(text)) return { ok: false, code: 'BINARY_FILE', message: 'file is not text' };
    return {
      ok: true,
      data: { relPath, content: text, size, mtimeMs, ...(size > bytes.length ? { truncated: true } : {}) },
    };
  }

  /** `listAllFiles` — a bounded walk, so a huge tree cannot stall the relay. */
  async function listAllFiles(workdir, relPath) {
    const startedAt = Date.now();
    const files = [];
    let truncated = false;
    const rootRel = String(relPath ?? '').replace(/^[\\/]+/, '');
    const queue = [rootRel];
    while (queue.length > 0 && !truncated) {
      const current = queue.shift();
      const entries = await listDir(workdir, current);
      if (entries === null) continue;
      for (const entry of entries) {
        if (files.length >= listAllLimit) {
          truncated = true;
          break;
        }
        if (entry.type === 'directory') queue.push(entry.relPath);
        else files.push(entry.relPath);
      }
    }
    return { files, truncated, elapsedMs: Date.now() - startedAt };
  }

  /**
   * `searchCollect` — a content search over the work directory.
   *
   * The controller renders matches, a truncation flag, and the counts, and asks
   * with `{ query, caseSensitive?, maxMatches? }`. This Host has no ripgrep, so it
   * walks the tree itself with a bounded budget (matches, files opened, bytes per
   * file) instead of pretending to mimic one exactly; what it cannot honour — a
   * huge tree, a file it cannot read — is reported through `truncated` rather than
   * silently narrowing the answer.
   * @param workdir - the session's work directory.
   * @param options - the query and the controller's optional bounds.
   * @returns the collected matches and counts, in the controller's shape.
   */
  async function searchCollect(workdir, options = {}) {
    const query = typeof options.query === 'string' ? options.query : '';
    if (query === '') return { matches: [], truncated: false, totalMatches: 0, totalFiles: 0 };
    const asked = Number.isFinite(options.maxMatches) && options.maxMatches > 0 ? Math.floor(options.maxMatches) : SEARCH_MATCH_LIMIT;
    const limit = Math.min(asked, SEARCH_MATCH_LIMIT);
    const pattern = compileSearchQuery(query, options.caseSensitive === true);

    const matches = [];
    let totalMatches = 0;
    let totalFiles = 0;
    let truncated = false;
    const startedAt = Date.now();

    /** Read and scan one already-listed file. */
    async function scanEntry(entry) {
      if (entry.type === 'directory') return;
      if (Number.isFinite(entry.size) && entry.size > SEARCH_FILE_BYTES) {
        truncated = true;
        return;
      }
      let bytes;
      try {
        bytes = await fileSystem.readByteRange(entry.target, { offset: 0, length: SEARCH_FILE_BYTES });
      } catch {
        return;
      }
      const text = Buffer.from(bytes).toString('utf8');
      if (looksBinary(text)) return;
      totalFiles += 1;
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!pattern.test(lines[index])) continue;
        totalMatches += 1;
        if (matches.length < limit) {
          matches.push({ relPath: entry.relPath, lineNumber: index + 1, lineText: lines[index].slice(0, SEARCH_LINE_CHARS) });
        } else {
          truncated = true;
        }
      }
    }

    // The search walks the tree itself instead of listing every file first and then
    // re-resolving each path: the full listing alone measured **6.1 s** on a real
    // repository (it walks up to `LIST_ALL_LIMIT` entries, `node_modules` included),
    // while a directory listing costs ~10 ms. Walking here means the skipped
    // directories are never entered and each file costs one read instead of a
    // resolve plus a read.
    const queue = [''];
    while (queue.length > 0) {
      if (Date.now() - startedAt >= SEARCH_TIME_BUDGET_MS
        || totalFiles >= SEARCH_FILE_LIMIT
        || totalMatches >= limit * SEARCH_MATCH_SCAN_FACTOR) {
        truncated = true;
        break;
      }
      const current = queue.shift();
      const entries = await listDirRaw(workdir, current);
      if (entries === null) continue;
      const wanted = [];
      for (const entry of entries) {
        if (isSkippedPath(entry.relPath)) continue;
        if (entry.type === 'directory') queue.push(entry.relPath);
        else wanted.push(entry);
      }
      for (let index = 0; index < wanted.length; index += SEARCH_CONCURRENCY) {
        await Promise.all(wanted.slice(index, index + SEARCH_CONCURRENCY).map((entry) => scanEntry(entry)));
      }
    }

    return { matches, truncated, totalMatches, totalFiles };
  }

  /**
   * Serve one `file-browser:remote-op` call.
   * @param args - `{ op, workdir, relPath? }`.
   * @returns the op's result, never throwing for a path the user cannot reach.
   */
  return async function remoteOp(args) {
    if (args === null || typeof args !== 'object' || typeof args.op !== 'string' || typeof args.workdir !== 'string' || args.workdir === '') {
      return { ok: false, message: 'invalid remote-op args' };
    }
    const { op, workdir } = args;
    const relPath = typeof args.relPath === 'string' ? args.relPath : '';
    // Advertised first because it is the capability probe: no workdir, no fs
    // access — an old host answers `unknown op: caps` and the controller reads
    // that as a definite "no gzip".
    if (op === 'caps') return { ok: true };
    if (op === 'listDir') return listDir(workdir, relPath);
    if (op === 'readFile') return readFile(workdir, relPath);
    if (op === 'listAllFiles') return listAllFiles(workdir, relPath);
    if (op === 'searchCollect') return searchCollect(workdir, args);
    // Ops the controller asks for that this Host cannot serve *for a stated
    // reason* answer in their own documented shape, so the controller degrades
    // deliberately instead of showing a transport-looking failure.
    //
    //  - `thumbnail` needs an image pipeline that produces the `image/webp` data
    //    URL the controller expects; `THUMB_UNSUPPORTED` is the reference host's
    //    own code for "this host cannot make one".
    //  - `exportFileStart` hands a file on this machine to the account's staging area
    //    so the *controller* can download it — the reverse of the attachment flow this
    //    Host does serve (there it fetches what the phone uploaded). Uploading on
    //    demand, with the progress polling `exportFileStatus` implies, is a transfer
    //    manager rather than a read, and is not served.
    if (op === 'thumbnail') {
      return { ok: false, code: 'THUMB_UNSUPPORTED', message: 'this Host generates no thumbnails' };
    }
    if (op === 'exportFileStart' || op === 'exportFileStatus') {
      return { ok: false, message: 'file export needs the Cindy media pipeline, which this Host does not serve' };
    }
    // The reference host answers an unknown op this way, and so does this one:
    // an op that is not served must not look like an empty result.
    return { ok: false, message: `unknown op: ${op}` };
  };
}
