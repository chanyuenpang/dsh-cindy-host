import { isAbsolute, resolve } from 'node:path';

/** Local workdir references only. The same resolver re-authorizes prepare/open/legacy reads. */
export function createLocalFileUrl({ resolveFile }) {
  return async function fileUrl({ workdir, relPath } = {}) {
    if (typeof workdir !== 'string' || !isAbsolute(workdir) || workdir.includes('\0'))
      return { ok: false, code: 'BAD_REQUEST', message: 'fileUrl requires a local absolute workdir; SSH export is not supported' };
    if (typeof relPath !== 'string' || !relPath.trim() || relPath.includes('\0') || isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || /^[\\/]/.test(relPath))
      return { ok: false, code: 'BAD_REQUEST', message: 'relPath must be relative to the workdir' };
    const url = new URL('xdt-file://open');
    url.searchParams.set('path', resolve(workdir, relPath));
    url.searchParams.set('workdir', workdir);
    const authorized = await resolveFile(url.toString());
    return authorized.ok === true ? { ok: true, url: url.toString() } : authorized;
  };
}
