/** Serialize account display-name writes; no token refresh or relay reconnect. */
export function createDeviceNameSync({ url, fetchImpl = fetch }) {
  let desired = null;
  let flight = null;
  let controller = null;
  let revision = 0;
  let state = { state: 'idle', name: null };

  function update(input) {
    desired = input;
    revision++;
    state = { state: input?.name ? 'pending' : 'idle', name: input?.name ?? null };
    if (!flight) drain();
  }

  function drain() {
    if (!desired?.name || !desired.session?.accessToken || !desired.deviceId) return;
    flight = (async () => {
      while (desired?.name && desired.session?.accessToken && desired.deviceId) {
        const input = desired;
        const version = revision;
        controller = new AbortController();
        state = { state: 'syncing', name: input.name };
        let ok = false;
        try {
          const response = await fetchImpl(url + '/' + encodeURIComponent(input.deviceId), {
            method: 'PATCH',
            headers: { Authorization: 'Bearer ' + input.session.accessToken, 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ name: input.name }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          });
          const body = await response.json();
          ok = response.ok && body?.deviceId === input.deviceId && body.name === input.name;
        } catch { /* A local save is not proof of a remote rename. */ }
        if (version !== revision) continue;
        state = { state: ok ? 'synced' : 'failed', name: input.name };
        break;
      }
    })().finally(() => {
      flight = null;
      controller = null;
      // An update can arrive after the last await but before this finalizer.
      if (state.state === 'pending' && desired?.session?.accessToken) drain();
    });
  }

  function reset(name = null) {
    revision++;
    desired = name ? { name } : null;
    controller?.abort();
    state = { state: name ? 'pending' : 'idle', name };
  }

  return { update, reset, snapshot: () => ({ ...state }) };
}
