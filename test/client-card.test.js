import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const SLOT = 'settings.section';

/**
 * Execute the browser bundle the way the page's module loader does: define
 * `window.__ModuleLoader__.load`, run the script, then call the captured
 * factory with a `require` that answers the platform seed words.
 */
function loadClientBundle(environment = {}) {
  const source = readFileSync(BUNDLE, 'utf8');
  let registration;
  const fakeWindow = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  // eslint-disable-next-line no-new-func -- the bundle is a classic script by design
  new Function('window', 'fetch', 'setInterval', 'clearInterval', source)(
    fakeWindow,
    environment.fetch ?? globalThis.fetch,
    environment.setInterval ?? globalThis.setInterval,
    environment.clearInterval ?? globalThis.clearInterval,
  );
  assert.ok(registration, 'the bundle must self-register through window.__ModuleLoader__.load');
  assert.equal(registration.id, 'dsh-cindy-host', 'client module identity must match the npm bundle name');

  const moduleExports = registration.factory((specifier) => {
    if (specifier === 'react') return environment.react ?? React;
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime');
    throw new Error(`client bundle required an unavailable module: ${specifier}`);
  });
  return { registration, moduleExports };
}

/**
 * A slot registry that behaves like the real one in the one way that matters
 * here: `register` throws for a slot no parent has declared yet, and `inject`
 * defers until it is declared. Plugin activation order is not something a
 * plugin may assume, and getting it wrong is exactly the failure
 * `slot "settings.plugin.item" is not declared` reports.
 */
function makeSlots() {
  const declared = new Set();
  const waiting = new Map();
  return {
    registrations: [],
    register(options, component) {
      if (!declared.has(options.name)) {
        throw new Error(`slot "${options.name}" is not declared (a parent entry's children table must declare it)`);
      }
      this.registrations.push({ options, component });
      return () => {};
    },
    inject(name, run) {
      const attempt = () => {
        const produced = run();
        // A generator yields one registration per slot child; a plain function
        // returns a single one. The shipped plugins use both forms.
        if (produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
          for (const ignored of produced) void ignored;
        }
      };
      if (declared.has(name)) attempt();
      else waiting.set(name, [...(waiting.get(name) ?? []), attempt]);
      return () => {};
    },
    /** What the declaring parent does when it publishes the slot. */
    declare(name) {
      declared.add(name);
      for (const attempt of waiting.get(name) ?? []) attempt();
      waiting.delete(name);
    },
  };
}

/** A settings-scope double whose snapshots are cached, as React requires. */
function makeScope(value, overrides = {}) {
  const snapshot = { status: 'ready', value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host', ...overrides };
  return {
    written: [],
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    async set(field, next) {
      this.written.push([field, next]);
    },
  };
}

/**
 * The settings-service double for one DSH generation.
 *
 * The two names are mutually exclusive in the field: 0.1.x provides `settingsScope`
 * (whose `bind({ namespace })` returns a scope), 0.2 provides `configForms` (whose
 * `get(entryId)` returns the controller). The bundle must resolve whichever exists
 * through a **non-blocking** `ctx.inject`, so the harness models exactly that: only a
 * service this deployment provides ever runs the callback.
 * @param kind - which generation's service to provide.
 * @param scope - the controller both shapes hand back.
 * @returns the provided services and a record of what the callback captured.
 */
function provideSettings(kind, scope) {
  const captured = { bound: null };
  if (kind === 'none') return { captured, services: {} };
  if (kind === 'configForms') {
    return {
      captured,
      services: {
        configForms: {
          get(entryId) {
            captured.bound = { entryId };
            return scope;
          },
        },
      },
    };
  }
  return {
    captured,
    services: {
      settingsScope: {
        bind(spec) {
          captured.bound = spec;
          return scope;
        },
      },
    },
  };
}

/** Mount `apply` against a fake plugin context, without declaring any slot yet. */
function mount(scope, slots = makeSlots(), kind = 'settingsScope') {
  const { captured, services } = provideSettings(kind, scope);
  const injected = [];
  const ctx = {
    slots,
    effect(run) {
      return run();
    },
    /**
     * Non-blocking, like Cordis: a service this deployment does not provide simply
     * never runs its callback. A module-level `inject` is the blocking form, and the
     * harness deliberately has no way to satisfy one.
     */
    inject(names, run) {
      const [name] = names;
      if (!Object.hasOwn(services, name)) return () => {};
      injected.push(name);
      run({ ...services });
      return () => {};
    },
  };
  const { moduleExports } = loadClientBundle();
  moduleExports.apply(ctx);
  return { captured, moduleExports, injected, provided: Object.keys(services) };
}

/** Mount and let the Plugins tab publish the slot, as it does in the real app. */
function mountDeclared(scope, kind = 'settingsScope') {
  const slots = makeSlots();
  const mounted = mount(scope, slots, kind);
  slots.declare(SLOT);
  return { ...mounted, slots };
}

/** Render one element to static markup. */
function render(element) {
  return renderToStaticMarkup(element);
}

test('waits for the Plugins tab to declare the slot instead of failing to mount', () => {
  const scope = makeScope({});
  const slots = makeSlots();
  mount(scope, slots);
  // The tab has not activated yet: nothing may be registered, and nothing may throw.
  assert.equal(slots.registrations.length, 0, 'an undeclared slot must not be registered into eagerly');

  slots.declare(SLOT);
  assert.equal(slots.registrations.length, 1, 'the deferred registration must land once the slot exists');
});

test('follows the slot declaration when it arrives before the card', () => {
  const scope = makeScope({});
  const slots = makeSlots();
  slots.declare(SLOT);
  mount(scope, slots);
  assert.equal(slots.registrations.length, 1);
});

test('the bundle registers one settings page under its own namespace', () => {
  const scope = makeScope({});
  const { captured, moduleExports, slots, injected } = mountDeclared(scope);
  // The module-level list may only name services **every** supported DSH provides.
  // 0.1.x provides `settingsScope` and 0.2 provides `configForms`; a blocking entry on
  // either name is exactly what kept this half from activating on the other generation
  // (0.2 reported it as the entry that refused to come up).
  assert.deepEqual(moduleExports.inject, ['slots']);
  assert.equal(moduleExports.inject.includes('settingsScope'), false, 'a 0.2 deployment does not provide settingsScope');
  assert.equal(moduleExports.inject.includes('configForms'), false, 'a 0.1.x deployment does not provide configForms');
  // Resolved through the non-blocking form instead, which is why an absent provider is
  // survivable.
  assert.deepEqual(injected, ['settingsScope']);
  assert.deepEqual(captured.bound, { namespace: 'dsh-cindy-host' });
  assert.equal(slots.registrations.length, 1);
  const options = slots.registrations[0].options;
  assert.equal(options.name, SLOT);
  // A list slot keys its entries by `id`, not by a keyed slot's `key`.
  assert.equal(options.key, undefined);
  assert.equal(options.id, 'dsh-cindy-host');
  assert.equal(options.order, moduleExports.__internals.SECTION_ORDER);
  assert.equal(options.order > 20, true, 'sits after agent-presets (order 20)');
  assert.equal(options.label(), moduleExports.__internals.TEXT.title);
  assert.equal(typeof slots.registrations[0].component, 'function');
});

test('0.2: resolves the same page through configForms.get(entryId)', () => {
  const scope = makeScope({ transportEnabled: true });
  const { captured, moduleExports, slots, injected, provided } = mountDeclared(scope, 'configForms');
  assert.deepEqual(provided, ['configForms']);
  assert.deepEqual(injected, ['configForms']);
  assert.deepEqual(captured.bound, { entryId: 'dsh-cindy-host' });
  assert.equal(slots.registrations.length, 1);
  assert.equal(slots.registrations[0].options.id, 'dsh-cindy-host', 'same section id on both generations');
  assert.equal(slots.registrations[0].options.order, moduleExports.__internals.SECTION_ORDER);
  const html = render(React.createElement(slots.registrations[0].component, null));
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/, 'the switch mirrors the controller snapshot on 0.2 too');
});

test('a deployment with neither settings service still activates and simply shows no page', () => {
  const slots = makeSlots();
  const { moduleExports, injected, provided } = mount(makeScope({}), slots, 'none');
  slots.declare(SLOT);
  assert.deepEqual(provided, [], 'this deployment provides neither name');
  assert.deepEqual(injected, [], 'neither non-blocking inject may fire');
  assert.equal(slots.registrations.length, 0, 'without a settings controller the page must not register');
  // The point of the fix: activation needs `slots` alone, so nothing here may throw or
  // hang waiting for a service that will never arrive.
  assert.deepEqual(moduleExports.inject, ['slots']);
});

test('registers no plugin card, so the Plugins tab shows no duplicate', () => {
  const source = readFileSync(BUNDLE, 'utf8');
  assert.equal(source.includes('"settings.plugin.item"'), false);
});

test('renders the switch, the state, the device section and the host id', () => {
  const { slots } = mountDeclared(makeScope({ transportEnabled: true }));
  const html = render(React.createElement(slots.registrations[0].component, null));
  assert.match(html, /Cindy 手机连接/);
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/, 'the switch mirrors the settings value');
  assert.match(html, /未连接/, 'no status poll has answered yet');
  assert.match(html, /已连接设备/);
});

test('the switch renders off when the settings say so', () => {
  const { slots } = mountDeclared(makeScope({ transportEnabled: false, remoteControlEnabled: false }));
  const html = render(React.createElement(slots.registrations[0].component, null));
  assert.match(html, /aria-checked="false"/);
  assert.match(html, /手机连接已关闭/);
});

test('renders nothing operational when the namespace is unavailable', () => {
  const { slots } = mountDeclared(makeScope({}, { status: 'unavailable' }));
  const html = render(React.createElement(slots.registrations[0].component, null));
  assert.match(html, /命名空间不可用/);
  assert.doesNotMatch(html, /role="switch"/);
});

test('maps every connection state to its label and color', () => {
  const { moduleExports } = loadClientBundle();
  const { stateText, stateColor, resolveCardView } = moduleExports.__internals;
  assert.equal(stateText('disconnected'), '未连接');
  assert.equal(stateText('authenticating'), '登录中');
  // The state a lost connection sits in while it retries by itself: showing it as
  // `failed` is what made the owner of the phone think the Host was gone.
  assert.equal(stateText('connecting'), '正在重连');
  assert.equal(stateText('waiting'), '等待手机连接');
  assert.equal(stateText('connected'), '已连接');
  assert.equal(stateText('failed'), '连接失败');
  assert.equal(stateText('unknown-state', 'fallback'), 'fallback');
  assert.match(stateColor('connected'), /success/);
  assert.match(stateColor('failed'), /error/);
  assert.match(stateColor('connecting'), /warn/);
  assert.match(stateColor('waiting'), /warn/);
  assert.match(stateColor('disconnected'), /tertiary/);

  const view = resolveCardView(
    { state: 'failed', message: 'boom', devices: [{ deviceId: 'p1' }], login: { authenticated: true, required: false } },
    { status: 'ready', value: { transportEnabled: true }, writable: true },
  );
  assert.equal(view.stateLabel, '连接失败');
  assert.equal(view.message, 'boom');
  assert.equal(view.showReconnect, true);
  assert.equal(view.showLogin, false);
  assert.equal(view.devices.length, 1);
});

test('a Host that needs a login shows the form instead of a reconnect', () => {
  const { moduleExports } = loadClientBundle();
  const { resolveCardView } = moduleExports.__internals;
  const view = resolveCardView(
    { state: 'disconnected', devices: [], login: { authenticated: false, required: true } },
    { status: 'ready', value: { transportEnabled: true }, writable: true },
  );
  assert.equal(view.showLogin, true);
  assert.equal(view.showReconnect, false);
});

test('renders the sign-in form with both identifier kinds', () => {
  const { moduleExports } = loadClientBundle();
  const { LoginForm } = moduleExports.__internals;
  const html = render(
    React.createElement(LoginForm, { busy: false, error: '验证码错误', notice: '验证码已发送', accounts: null, onSendCode() {}, onSignIn() {}, onSelectAccount() {} }),
  );
  assert.match(html, /登录 Cindy/);
  assert.match(html, /手机号/);
  assert.match(html, /邮箱/);
  assert.match(html, /验证码/);
  assert.match(html, /获取验证码/);
  assert.match(html, /验证码错误/);
  assert.match(html, /验证码已发送/);
});

test('renders a multi-account choice when Cindy asks for one', () => {
  const { moduleExports } = loadClientBundle();
  const { LoginForm } = moduleExports.__internals;
  const html = render(
    React.createElement(LoginForm, {
      busy: false,
      error: null,
      notice: null,
      accounts: [{ id: 'a1', displayName: 'Work' }, { id: 'a2', displayName: null }],
      onSendCode() {},
      onSignIn() {},
      onSelectAccount() {},
    }),
  );
  assert.match(html, /Work/);
  assert.match(html, /a2/);
});

test('renders each device with its name, platform and id', () => {
  const { moduleExports } = loadClientBundle();
  const { DeviceRow, platformText } = moduleExports.__internals;
  const html = render(
    React.createElement(DeviceRow, { device: { deviceId: 'dev-1234567890', name: 'Pixel 8', platform: 'android', online: true } }),
  );
  assert.match(html, /Pixel 8/);
  assert.match(html, /Android/);
  assert.match(html, /dev-1234567890/);
  assert.match(html, /在线/);

  const offline = render(
    React.createElement(DeviceRow, { device: { deviceId: 'dev-2', name: '', platform: null, online: false } }),
  );
  assert.match(offline, /dev-2/);
  assert.match(offline, /离线/);
  assert.match(offline, /未知平台/);

  assert.equal(platformText('ios'), 'iOS');
  assert.equal(platformText('darwin'), 'macOS');
  assert.equal(platformText('win32'), 'Windows');
  assert.equal(platformText('linux'), 'Linux');
  assert.equal(platformText('plan9'), 'plan9');
});

test('the switch reports the flipped value, not the current one', () => {
  const toggles = [];
  const { moduleExports } = loadClientBundle();
  const Switch = moduleExports.__internals.Switch;
  const element = Switch({ checked: false, disabled: false, onChange: (next) => toggles.push(next), label: 'x' });
  element.props.onClick();
  assert.deepEqual(toggles, [true]);
});

test('the switch writes both settings spellings through the legacy bound scope', async () => {
  const scope = makeScope({ transportEnabled: false });
  const { moduleExports } = loadClientBundle();
  await moduleExports.__internals.writeSwitch(scope, true);
  assert.deepEqual(scope.written, [
    ['transportEnabled', true],
    ['remoteControlEnabled', true],
  ]);
  await moduleExports.__internals.writeSwitch(scope, false);
  assert.deepEqual(scope.written.slice(2), [
    ['transportEnabled', false],
    ['remoteControlEnabled', false],
  ]);
});

test('the switch atomically mutates both flags without calling set', async () => {
  const { writeSwitch } = loadClientBundle().moduleExports.__internals;
  const calls = [];
  const scope = {
    async mutate(ops) { assert.equal(this, scope); calls.push(ops); return true; },
    set() { assert.fail('atomic controllers must not use individual writes'); },
  };
  for (const next of [true, false]) {
    await writeSwitch(scope, next);
    assert.deepEqual(calls.at(-1), [
      { op: 'set', path: ['transportEnabled'], value: next },
      { op: 'set', path: ['remoteControlEnabled'], value: next },
    ]);
  }
  assert.equal(calls.length, 2);
});

test('atomic rejection and exceptions propagate without legacy fallback', async () => {
  const { writeSwitch } = loadClientBundle().moduleExports.__internals;
  const scope = { mutate: async () => false, set() { assert.fail('must not retry rejected atomic writes'); } };
  await assert.rejects(writeSwitch(scope, true), /Settings write rejected/);
  scope.mutate = async () => { throw new Error('offline'); };
  await assert.rejects(writeSwitch(scope, false), /offline/);
});

test('legacy writes reject false from either field and stop at rejection', async () => {
  const { writeSwitch } = loadClientBundle().moduleExports.__internals;
  for (const rejected of ['transportEnabled', 'remoteControlEnabled']) {
    const calls = [];
    const scope = { async set(field) { calls.push(field); return field !== rejected; } };
    await assert.rejects(writeSwitch(scope, false), /Settings write rejected/);
    assert.deepEqual(calls, rejected === 'transportEnabled' ? [rejected] : ['transportEnabled', rejected]);
  }
});

test('status reads reject HTTP, application, malformed and network failures', async () => {
  const valid = { state: 'waiting', login: { authenticated: true } };
  let response;
  const { readStatus } = loadClientBundle({ fetch: async (url, options) => {
    assert.equal(url, '/api/dsh-cindy-host/status');
    assert.equal(options.headers.accept, 'application/json');
    if (response instanceof Error) throw response;
    return response;
  } }).moduleExports.__internals;
  for (const [ok, body] of [
    [false, { ok: true, status: valid }],
    [true, { ok: false, status: valid }],
    [true, {}], [true, null], [true, { status: null }],
    [true, { status: {} }], [true, { status: [] }], [true, { status: 'disconnected' }],
  ]) {
    response = { ok, json: async () => body };
    await assert.rejects(readStatus());
  }
  response = { ok: true, json: async () => { throw new Error('invalid JSON'); } };
  await assert.rejects(readStatus(), /invalid JSON/);
  response = new Error('offline');
  await assert.rejects(readStatus(), /offline/);
  response = { ok: true, json: async () => ({ ok: true, status: valid }) };
  assert.equal(await readStatus(), valid);
});

/** Run page hooks without a DOM so effects, handlers and subsequent renders are exercised. */
function pageHarness(scope, fetch) {
  const states = [];
  let cursor = 0;
  let effect;
  let tick;
  const react = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useCallback: (callback) => callback,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useEffect: (callback) => { effect = callback; },
  };
  const { createCindySettingsPage } = loadClientBundle({
    react, fetch,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval() {},
  }).moduleExports.__internals;
  const Page = createCindySettingsPage(scope);
  const tree = () => { cursor = 0; return Page(); };
  tree();
  return {
    tree,
    html: () => render(tree()),
    async start() {
      const cleanup = effect();
      await new Promise((resolve) => setImmediate(resolve));
      return cleanup;
    },
    poll: () => tick(),
  };
}

function findElement(element, predicate) {
  if (!React.isValidElement(element)) return undefined;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
}

test('poll failures show an error rather than disconnected, and recover on a valid poll', async () => {
  let body = { ok: false };
  const page = pageHarness(makeScope({ transportEnabled: true }), async () => ({ ok: true, json: async () => body }));
  const cleanup = await page.start();
  try {
    assert.match(page.html(), /读取 Host 状态失败/);
    assert.doesNotMatch(page.html(), /未连接/);
    body = { ok: true, status: { state: 'connected' } };
    await page.poll();
    assert.doesNotMatch(page.html(), /读取 Host 状态失败/);
    assert.match(page.html(), />已连接</);
    body = {};
    await page.poll();
    assert.match(page.html(), /读取 Host 状态失败/);
    assert.doesNotMatch(page.html(), />已连接<|未连接/);
  } finally { cleanup(); }
});

test('the page surfaces a rejected atomic switch write', async () => {
  const scope = makeScope({ transportEnabled: false });
  scope.mutate = async () => false;
  const page = pageHarness(scope, async () => { throw new Error('unused'); });
  const toggle = findElement(page.tree(), (element) => element.type.name === 'Switch');
  toggle.props.onChange(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.html(), /写入设置失败/);
  assert.match(page.html(), /aria-checked="false"/);
  assert.deepEqual(scope.written, []);
});

test('connected and waiting accounts show only masked identifiers and a working logout', async () => {
  for (const [state, identifier, masked] of [
    ['connected', 'person@example.com', 'p***@example.com'],
    ['waiting', '+8613812345678', '***5678'],
    ['failed', null, null],
  ]) {
    const calls = [];
    const page = pageHarness(makeScope({ transportEnabled: true }), async (url, options) => {
      calls.push([url, options]);
      return { ok: true, json: async () => ({ ok: true, status: { state, login: { authenticated: true, identifier } } }) };
    });
    const cleanup = await page.start();
    try {
      const html = page.html();
      assert.match(html, /已登录 Cindy/);
      assert.equal((html.match(/退出登录/g) ?? []).length, 1);
      if (identifier) {
        assert.equal(html.includes(identifier), false);
        assert.equal(html.includes(masked), true);
      }
      const logout = findElement(page.tree(), (element) => element.type === 'button' && element.props.children === '退出登录');
      await logout.props.onClick();
      assert.equal(calls.at(-1)[0], '/api/dsh-cindy-host/logout');
      assert.equal(calls.at(-1)[1].method, 'POST');
    } finally { cleanup(); }
  }
});
