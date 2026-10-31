/** Cindy's authenticated, short-lived ICE configuration; no credential cache or logging. */
const FALLBACK = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const ICE_URL = /^(stun|turn|turns):(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\]):([0-9]{1,5})(\?transport=(udp|tcp))?$/;

export function parseFileIceConfig(value, now = Date.now()) {
  const fail = () => { throw new Error('INVALID_FILE_ICE_CONFIG'); };
  if (!value || typeof value !== 'object' || !Array.isArray(value.iceServers) || value.iceServers.length > 4) return fail();
  if (!value.iceServers.length && value.expiresAt === null) return [];
  const expires = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
  if (!Number.isFinite(expires) || expires <= now + 120_000 || expires > now + 86_400_000) return fail();
  return value.iceServers.map(server => {
    if (!server || typeof server !== 'object' || !Array.isArray(server.urls) || !server.urls.length || server.urls.length > 4) return fail();
    const urls = server.urls.map(url => {
      if (typeof url !== 'string' || url.length > 512) return fail();
      const match = ICE_URL.exec(url);
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || (match[1] === 'stun' && match[3]) || (match[1] === 'turns' && match[4] !== 'tcp')) return fail();
      try {
        const host = new URL('http://' + url.slice(url.indexOf(':') + 1).split('?')[0]).hostname;
        if (!host.startsWith('[') && host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return fail();
      } catch { return fail(); }
      return url;
    });
    if (!urls.some(url => /^turns?:/.test(url)) || typeof server.username !== 'string' || !server.username.length || server.username.length > 256 || typeof server.credential !== 'string' || !server.credential.length || server.credential.length > 256) return fail();
    return { urls, username: server.username, credential: server.credential };
  });
}

export function createFileIceLoader({ apiBaseUrl, getSession, fetchImpl = fetch, onUnauthorized, timeoutMs = 3000, now = Date.now }) {
  return async function loadIceServers() {
    const abort = new AbortController();
    let timer;
    const fetchConfig = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        abort.signal.throwIfAborted();
        const session = getSession();
        if (!session?.accessToken) throw new Error('NO_CREDENTIAL');
        const response = await fetchImpl(`${apiBaseUrl}/ice-servers`, {
          headers: { Authorization: `Bearer ${session.accessToken}`, accept: 'application/json' },
          cache: 'no-store', signal: abort.signal,
        });
        abort.signal.throwIfAborted();
        if (response.status === 401 && attempt === 0 && typeof onUnauthorized === 'function') {
          if (await onUnauthorized()) continue;
        }
        if (!response.ok) throw new Error('ICE_CONFIG_UNAVAILABLE');
        return parseFileIceConfig(await response.json(), now());
      }
      throw new Error('ICE_CONFIG_UNAVAILABLE');
    };
    try {
      const servers = await Promise.race([fetchConfig(), new Promise((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('ICE_CONFIG_TIMEOUT')); }, timeoutMs);
      })]);
      if (servers.length) return servers;
    } catch {
      // Match Cindy's fallback. Never retain/log the response body, credentials or SDP.
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return FALLBACK.map(url => ({ urls: [url] }));
  };
}
