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
function loadClientBundle() {
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
  new Function('window', source)(fakeWindow);
  assert.ok(registration, 'the bundle must self-register through window.__ModuleLoader__.load');

  const moduleExports = registration.factory((specifier) => {
    if (specifier === 'react') return React;
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

/** Mount `apply` against a fake plugin context, without declaring any slot yet. */
function mount(scope, slots = makeSlots()) {
  const captured = { bound: null, slots };
  const ctx = {
    settingsScope: {
      bind(spec) {
        captured.bound = spec;
        return scope;
      },
    },
    slots,
    effect(run) {
      return run();
    },
  };
  const { moduleExports } = loadClientBundle();
  moduleExports.apply(ctx);
  return { captured, moduleExports };
}

/** Mount and let the Plugins tab publish the slot, as it does in the real app. */
function mountDeclared(scope) {
  const slots = makeSlots();
  const mounted = mount(scope, slots);
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
  const { captured, moduleExports, slots } = mountDeclared(scope);
  assert.equal(moduleExports.inject.includes('slots'), true);
  assert.equal(moduleExports.inject.includes('settingsScope'), true);
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

test('the switch writes both settings spellings through the bound scope', async () => {
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
