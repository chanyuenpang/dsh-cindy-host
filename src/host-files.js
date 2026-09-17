/**
 * The `fs:*` and `text-file:*` reads the Cindy controller uses to browse files.
 *
 * DSH's filesystem service (`ctx.fs`) works in `FsTarget` handles — resolve a
 * path, then stat/list/read the handle — while the controller speaks plain
 * absolute paths and its own vocabulary (`'dir' | 'file' | 'missing'`). This
 * module is exactly that translation, and nothing else: no policy, no caching,
 * no path rewriting. Whatever the composed filesystem refuses (sandbox policy,
 * a missing path) is reported to the controller as its own failure value rather
 * than as an exception, because the controller renders those reasons.
 *
 * Contract shapes (`apps/mobile/src/device-link/mobileMakerTransport.ts`):
 *
 *   fs:stat-path        -> { kind: 'dir' | 'file' | 'missing', resolvedPath }
 *   fs:list-dir         -> { resolvedPath, entries: [{ name, kind, path }], parent }
 *   text-file:read-preview -> { success, data?, size, reason? }
 */

/** Longest preview this Host will inline; larger files report `oversize`. */
export const PREVIEW_LIMIT_BYTES = 1024 * 1024;

/**
 * Map a DSH file type onto the controller's path-kind vocabulary.
 *
 * `'other'` is not a directory and does exist, so it reads as a file; only an
 * absent `FsInfo` is `'missing'`.
 */
function pathKindOf(info) {
  if (info === undefined || info === null) return 'missing';
  return info.type === 'directory' ? 'dir' : 'file';
}

/** Map a DSH directory entry onto the controller's entry kind. */
function entryKindOf(type) {
  if (type === 'directory') return 'dir';
  if (type === 'file') return 'file';
  return 'symlink';
}

/**
 * The parent directory of a path, or null at a filesystem root.
 *
 * A Windows drive root keeps its separator: the parent of `G:\nope` is `G:\`,
 * not `G:` — Windows resolves the latter as the *current* directory on that
 * drive, so an "up one level" built from it lands somewhere the user never was.
 */
function parentOf(path) {
  const normalised = String(path).replace(/[\\/]+$/, '');
  const cut = Math.max(normalised.lastIndexOf('/'), normalised.lastIndexOf('\\'));
  // No separator left after stripping: a bare name, or a root itself.
  if (cut < 0) return null;
  // A separator at index 0 is the POSIX root, which is its children's parent.
  if (cut === 0) return '/';
  const head = normalised.slice(0, cut);
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head;
}

/**
 * Build the file reads over one filesystem service.
 * @param options - the filesystem service and an injectable preview limit.
 * @returns the three readers the router exposes.
 */
export function createFileReader({ fileSystem, previewLimitBytes = PREVIEW_LIMIT_BYTES }) {
  if (fileSystem === undefined || fileSystem === null) throw new Error('createFileReader requires a filesystem service');

  /** Resolve a controller-supplied path, or null when it does not resolve. */
  async function resolvePath(path) {
    if (typeof path !== 'string' || path.trim() === '') return null;
    try {
      return await fileSystem.resolve(path);
    } catch {
      // An unresolvable path is reported as `missing`/`not_found` below, not
      // thrown: the controller has a rendering for that and none for a crash.
      return null;
    }
  }

  /** `fs:stat-path` */
  async function statPath(path) {
    const target = await resolvePath(path);
    if (target === null) return { kind: 'missing', resolvedPath: String(path ?? '') };
    let info;
    try {
      info = await fileSystem.stat(target);
    } catch {
      info = undefined;
    }
    return { kind: pathKindOf(info), resolvedPath: fileSystem.processPath(target) };
  }

  /** `fs:list-dir` */
  async function listDir(path) {
    const target = await resolvePath(path);
    if (target === null) return { resolvedPath: String(path ?? ''), entries: [], parent: null };
    let raw = [];
    try {
      raw = await fileSystem.listDir(target);
    } catch {
      raw = [];
    }
    const resolvedPath = fileSystem.processPath(target);
    const entries = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
      if (entry === null || typeof entry !== 'object') continue;
      let entryPath = null;
      try {
        entryPath = fileSystem.processPath(entry.target);
      } catch {
        entryPath = null;
      }
      // The controller renders `path`, so an entry whose path cannot be named is
      // dropped rather than emitted with a hole in it.
      if (entryPath === null) continue;
      entries.push({ name: String(entry.name ?? ''), kind: entryKindOf(entry.type), path: entryPath });
    }
    return { resolvedPath, entries, parent: parentOf(resolvedPath) };
  }

  /** `text-file:read-preview` */
  async function readTextPreview(filePath) {
    const target = await resolvePath(filePath);
    if (target === null) return { success: false, reason: 'not_found', size: 0 };

    let info;
    try {
      info = await fileSystem.stat(target);
    } catch {
      info = undefined;
    }
    if (info === undefined || info === null) return { success: false, reason: 'not_found', size: 0 };
    if (info.type === 'directory') return { success: false, reason: 'not_found', size: 0 };

    const size = Number.isFinite(info.size) ? info.size : 0;
    if (size > previewLimitBytes) {
      return { success: false, reason: 'oversize', size, limitMb: Math.floor(previewLimitBytes / (1024 * 1024)) };
    }

    let bytes;
    try {
      bytes = await fileSystem.readByteRange(target, { offset: 0, length: previewLimitBytes });
    } catch {
      return { success: false, reason: 'read_failed', size };
    }
    return { success: true, data: Buffer.from(bytes).toString('utf8'), size: bytes.length };
  }

  return { statPath, listDir, readTextPreview };
}
