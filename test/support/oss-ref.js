/**
 * Build an attachment transit reference the way a Cindy sender does.
 *
 * Test-only, and written from the contract rather than copied from a client, so a
 * reference this helper produces is a fair stand-in for one a phone sends
 * (`packages/device-link/src/attachmentOssRef.ts`):
 *
 * ```
 * <scheme>://m/<base64url(JSON { ossKey, mimeType?, originalName?, size?, sha256? })>
 * ```
 *
 * The **legacy** scheme is the default because that is what the phones actually
 * send today — a test that only ever used the current scheme is exactly how a Host
 * classifier came to mislabel live photo uploads.
 *
 * @param ref - `{ ossKey, mimeType?, originalName?, size?, sha256? }`.
 * @param options - `scheme`, for the current-scheme and unknown-scheme cases.
 * @returns the reference string.
 */
export function buildOssRef(ref, { scheme = 'xdt-oss-attach' } = {}) {
  const payload = JSON.stringify(ref);
  const segment = Buffer.from(payload, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${scheme}://m/${segment}`;
}
