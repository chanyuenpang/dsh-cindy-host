import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshReminders, reminderWireId } from '../src/dsh-reminders.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const due = '2026-11-04T01:00:00.000Z';
const baseRecord = (id = 'native-1', extra = {}) => ({ id, kind: 'cron', title: 'Native title', prompt: 'Native prompt', expression: '0 9 * * *', timeZone: 'Asia/Shanghai', scheduledAt: due, ...extra });
const form = extra => ({ name: 'Phone title', prompt: 'Phone prompt', kind: 'cron', cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', recurring: true, manual: false, intervalMs: null, agentKind: 'pi', workspaceKind: 'dialogue', useWorktree: false, persistentSession: false, silentWhenIdle: false, notify: { desktop: false, feishu: false, wecomGroup: false }, targetSessionId: 'root', ...extra });
function fixture(options = {}) {
  const store = new Map(); const calls = []; const listeners = new Set(); let service; let counter = 0; let catalogFailure; let beforeCreate; let beforeUpdate; let beforeDelete; let target = async id => id === 'root' ? { id, cwd: '/project' } : undefined;
  const backend = { catalog: async () => { calls.push(['catalog']); if (catalogFailure) throw catalogFailure; return [...store.values()].map(value => ({ ...value.record, sessionId: value.sessionId, status: value.status, ...(value.lastDelivery ? { lastDelivery: value.lastDelivery } : {}) })); },
    create: async (sessionId, request, signal) => { calls.push(['create', sessionId, request, signal]); if (beforeCreate) await beforeCreate(); signal.throwIfAborted();
      const id = 'made-' + ++counter; const record = request.every_seconds === undefined ? baseRecord(id, { title: request.title, prompt: request.prompt.trim(), expression: request.cron.expression, timeZone: request.cron.time_zone }) : { id, kind: 'every', title: request.title, prompt: request.prompt.trim(), everySeconds: request.every_seconds, scheduledAt: due };
      store.set(id, { sessionId, status: 'active', record }); for (const fn of listeners) fn(); return record; },
    update: async (request, signal) => { calls.push(['update', request, signal]); if (beforeUpdate) await beforeUpdate(request); signal.throwIfAborted(); const value = store.get(request.id);
      if (!value || value.sessionId !== request.sessionId) return { updated: false, code: 'schedule_not_found' };
      if (JSON.stringify(value.record) !== JSON.stringify(request.expected)) return { updated: false, code: 'schedule_conflict' };
      const record = { ...value.record, ...(request.title === undefined ? {} : { title: request.title }), ...(request.prompt === undefined ? {} : { prompt: request.prompt.trim() }) };
      if (request.change?.kind === 'cron') { delete record.everySeconds; Object.assign(record, { kind: 'cron', expression: request.change.cron.expression, timeZone: request.change.cron.time_zone }); }
      if (request.change?.kind === 'every') { delete record.expression; delete record.timeZone; Object.assign(record, { kind: 'every', everySeconds: request.change.every_seconds }); }
      value.record = record; for (const fn of listeners) fn(); return { id: request.id, updated: true, record }; },
    delete: async (request, signal) => { calls.push(['delete', request, signal]); if (beforeDelete) await beforeDelete(request); signal.throwIfAborted(); const value = store.get(request.id);
      if (!value || value.sessionId !== request.sessionId) return { id: request.id, deleted: false, code: 'schedule_not_found' }; store.delete(request.id); for (const fn of listeners) fn(); return { id: request.id, deleted: true }; },
    history: () => { throw Error('delivery history is not runs'); }, pause: () => { throw Error('must not simulate pause'); } };
  service = backend;
  const port = createDshReminders({ getService: () => service, getSession: (id, options) => target(id, options), subscribeChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); }, ...options });
  const readOptions = { getView: async id => ({ id, workingDir: '/project', agentKind: 'pi', status: 'active' }) };
  const add = (record = baseRecord(), sessionId = 'root', status = 'active', lastDelivery) => { store.set(record.id, { record, sessionId, status, lastDelivery }); return reminderWireId(record.id); };
  return { port, backend, store, calls, listeners, readOptions, add, removeService: () => { service = undefined; }, failCatalog: error => { catalogFailure = error; },
    beforeCreate: fn => { beforeCreate = fn; }, beforeUpdate: fn => { beforeUpdate = fn; }, beforeDelete: fn => { beforeDelete = fn; }, setTarget: fn => { target = fn; } };
}
test('native catalog list/get preserve visible binding, real cadence/state/delivery and unknown execution metadata', async () => {
  const f = fixture(); const id = f.add(); f.add(baseRecord('private'), 'child'); f.add({ id: 'once', kind: 'at', title: 'One time', prompt: 'once', scheduledAt: due }, 'root', 'inactive', { deliveredAt: '2026-11-01T01:00:00.000Z', scheduledAt: due, messageId: 'native-msg' });
  const rows = await f.port.list(undefined, f.readOptions); assert.equal(rows.length, 2); assert.equal(rows[0].targetSessionId, 'root'); assert.equal(rows[0].cronExpr, '0 9 * * *');
  const once = rows.find(row => row.name === 'One time'); assert.equal(once.status, 'expired'); assert.equal(once.recurring, false); assert.equal(once.nextFireAt, undefined); assert.equal(once.lastFiredAt, '2026-11-01T01:00:00.000Z');
  for (const key of ['lastFinishedAt', 'createdAt', 'updatedAt', 'costUsd', 'runId']) assert.equal(once[key], undefined);
  assert.equal((await f.port.get(id, f.readOptions)).id, id); assert.equal(await f.port.get('unknown', f.readOptions), null); assert.equal(await f.port.get(reminderWireId('private'), f.readOptions), null);
});
test('native missing service and storage failures are errors, not empty scheduler success', async () => {
  const f = fixture(); f.removeService(); await assert.rejects(f.port.list(), { refusalCode: 'NOT_AVAILABLE' }); assert.equal(f.calls.length, 0);
  const g = fixture(); g.failCatalog(Error('native storage failed')); await assert.rejects(g.port.list(), /native storage failed/);
});
test('recurring create uses native existing-session create with exactly the genuine selector and no engine/workspace override', async () => {
  const f = fixture(); const result = await f.port.create(form(), f.readOptions); const call = f.calls.find(call => call[0] === 'create');
  assert.equal(call[1], 'root'); assert.deepEqual(call[2], { title: 'Phone title', prompt: 'Phone prompt', cron: { expression: '0 9 * * *', time_zone: 'Asia/Shanghai' } });
  assert.equal(result.id, reminderWireId('made-1')); assert.equal(result.targetSessionId, 'root'); assert.equal(result.model, undefined);
});
test('active interval semantics use real whole seconds and never pretend the unused cron/timezone is stored', async () => {
  const f = fixture(); const result = await f.port.create(form({ intervalMs: 90000, cronExpr: 'unused legacy interval hint', timezone: '' }), f.readOptions);
  assert.equal(f.calls.find(call => call[0] === 'create')[2].every_seconds, 90); assert.equal(result.intervalMs, 90000); assert.equal(result.timezone, undefined);
});
test('manual, model, worktree, rebinding, notification, script and malformed variants refuse before native mutation', async () => {
  for (const patch of [{ manual: true }, { recurring: false }, { model: 'override' }, { providerId: 'provider' }, { effort: 'high' }, { modelAgentKind: 'pi' }, { fastMode: true }, { persistentSession: true }, { silentWhenIdle: true }, { useWorktree: true }, { notify: { desktop: true } }, { workspaceKind: 'project' }, { executionMode: 'script' }, { intervalMs: 60001 }, { unknown: true }]) {
    const f = fixture(); await assert.rejects(f.port.create(form(patch), f.readOptions)); assert.equal(f.calls.some(call => call[0] === 'create'), false);
  }
});
test('target authorization and alias/cwd consistency never wake or silently switch a different session', async () => {
  for (const patch of [{ targetSessionId: 'missing' }, { agentKind: 'codex' }, { workingDir: '/other' }]) {
    const f = fixture(); await assert.rejects(f.port.create(form(patch), f.readOptions)); assert.equal(f.calls.some(call => call[0] === 'create'), false);
  }
});
test('native update carries the complete observed record as expected and content outside its timing union', async () => {
  const f = fixture(); const original = baseRecord(); const id = f.add(original, 'root', 'active', { deliveredAt: due });
  const result = await f.port.update(id, { name: 'Changed', prompt: 'new prompt' }, f.readOptions); const request = f.calls.find(call => call[0] === 'update')[1];
  assert.deepEqual(request.expected, original); assert.equal(request.expected.sessionId, undefined); assert.equal(request.expected.status, undefined); assert.equal(request.title, 'Changed'); assert.equal(request.prompt, 'new prompt'); assert.equal(request.change, undefined); assert.equal(result.name, 'Changed');
});
test('native CAS conflict is surfaced without reread-and-overwrite retry', async () => {
  const f = fixture(); const id = f.add(); f.beforeUpdate(() => { f.store.get('native-1').record = baseRecord('native-1', { title: 'Desktop changed' }); });
  await assert.rejects(f.port.update(id, { name: 'Phone change' }, f.readOptions), /schedule_conflict/);
  assert.equal(f.calls.filter(call => call[0] === 'update').length, 1); assert.equal(f.store.get('native-1').record.title, 'Desktop changed');
});
test('nullable interval clearing genuinely changes to explicit cron; omitted interval preserves current cadence', async () => {
  const f = fixture(); const id = f.add({ id: 'native-1', kind: 'every', title: 'Interval', prompt: 'p', everySeconds: 90, scheduledAt: due });
  await f.port.update(id, { prompt: 'content only' }, f.readOptions); assert.equal(f.calls.find(call => call[0] === 'update')[1].change.every_seconds, 90);
  const result = await f.port.update(id, { intervalMs: null, cronExpr: '0 10 * * *', timezone: 'UTC' }, f.readOptions);
  assert.equal(result.intervalMs, undefined); assert.equal(result.cronExpr, '0 10 * * *'); assert.equal(f.calls.filter(call => call[0] === 'update').at(-1)[1].change.kind, 'cron');
});
test('existing one-time reminders remain real read/delete-only records and delete never controls an inbox or Agent', async () => {
  const f = fixture(); const id = f.add({ id: 'once', kind: 'after', title: 'Once', prompt: 'one', afterSeconds: 60, scheduledAt: due });
  assert.equal((await f.port.get(id, f.readOptions)).recurring, false); await assert.rejects(f.port.update(id, { name: 'No conversion' }, f.readOptions), /delete-only/);
  assert.equal(await f.port.delete(id, f.readOptions), undefined); assert.deepEqual(f.calls.find(call => call[0] === 'delete')[1], { id: 'once', sessionId: 'root' }); await assert.rejects(f.port.delete(id, f.readOptions), { refusalCode: 'NOT_FOUND' });
});
test('native delete false after an external removal cannot be reported as successful deletion', async () => {
  const f = fixture(); const id = f.add(); f.beforeDelete(() => f.store.delete('native-1')); await assert.rejects(f.port.delete(id, f.readOptions), { refusalCode: 'NOT_FOUND' });
});
test('duplicate creation envelopes share native admission and projection failure retains the real created identity', async () => {
  const f = fixture(); const options = { ...f.readOptions, requestKey: 'same-envelope' };
  const [a, b] = await Promise.all([f.port.create(form(), options), f.port.create(form(), options)]); assert.equal(a.id, b.id); assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  await assert.rejects(f.port.create(form({ name: 'different' }), options), /reused with different/);
  const g = fixture(); let first = true; const catalog = g.backend.catalog; g.backend.catalog = async () => { if (first) { first = false; throw Error('readback failed'); } return catalog(); };
  await assert.rejects(g.port.create(form(), options), /created id=dsh-schedule:made-1/); assert.equal((await g.port.create(form(), options)).id, reminderWireId('made-1')); assert.equal(g.calls.filter(call => call[0] === 'create').length, 1);
});
test('cancellation after native commit retains the known reminder and never pretends rollback', async () => {
  const f = fixture(); const create = f.backend.create; f.backend.create = async (...args) => { const result = await create(...args); f.port.cancelAll(); return result; };
  await assert.rejects(f.port.create(form(), f.readOptions), /do not repeat creation/); assert.equal(f.store.size, 1);
});
test('cancelled metadata reads cannot proceed to native persistence', async () => {
  const f = fixture(); f.setTarget((_id, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const pending = f.port.create(form(), f.readOptions); await tick(); f.port.cancelAll(); await assert.rejects(pending, { refusalCode: 'NOT_AVAILABLE' }); assert.equal(f.calls.some(call => call[0] === 'create'), false);
});
test('actual native change notifications only project ready and close without fabricated runs or completion', async () => {
  const f = fixture(); const events = []; const close = f.port.onChange(event => events.push(event)); assert.equal(f.listeners.size, 1);
  await f.port.create(form(), f.readOptions); assert.deepEqual(events, [{ type: 'ready' }]); close(); assert.equal(f.listeners.size, 0);
  f.port.onChange(() => {}); f.port.dispose(); assert.equal(f.listeners.size, 0);
});
test('calendar projections preserve seconds or explicitly refuse an unrepresentable fractional rule', async () => {
  const f = fixture(); const id = f.add({ id: 'daily', kind: 'daily', title: 'Calendar', prompt: 'p', time: '09:15:03.000', timeZone: 'UTC', scheduledAt: due });
  assert.equal((await f.port.get(id, f.readOptions)).cronExpr, '3 15 9 * * *');
  f.store.get('daily').record.time = '09:15:03.123'; await assert.rejects(f.port.list(undefined, f.readOptions), /no exact/);
});
test('unsupported paused filters and response budgets are explicit errors, never fabricated zero or truncated lists', async () => {
  const f = fixture({ maxBytes: 200 }); f.add(); await assert.rejects(f.port.list({ status: 'paused' }, f.readOptions), /no paused/);
  await assert.rejects(f.port.list(undefined, f.readOptions), /byte budget/); await assert.rejects(f.port.get(reminderWireId('native-1'), f.readOptions), /byte budget/);
});

test('five existing scheduler RPCs expose the native subset and leave runs/cost/pause/control unserved', async () => {
  const f = fixture(); let request = 0;
  const router = createChannelRouter({ subscribers: new Set(), listSessions: async () => [], getSession: async id => ({ id, cwd: '/project', createdAt: 1, model: 'deepseek-chat', providerId: 'deepseek' }), resolveCapabilities: () => ({ reminders: f.port }) });
  const invoke = (channel, args) => router({ v: 1, id: String(++request), src: 'phone', kind: 'invoke', payload: { channel, args } });
  const created = (await invoke('maker:schedule:create', [form()])).payload; assert.equal(created.ok, true); const id = created.result.id;
  assert.equal((await invoke('maker:schedule:list', [])).payload.result.length, 1);
  assert.equal((await invoke('maker:schedule:get', [id])).payload.result.id, id);
  assert.equal((await invoke('maker:schedule:update', [id, { name: 'Updated over RPC' }])).payload.result.name, 'Updated over RPC');
  assert.equal((await invoke('maker:schedule:delete', [id])).payload.ok, true);
  assert.equal((await invoke('maker:schedule:delete', [id, { deleteGeneratedSessions: true }])).payload.error.code, 'BAD_REQUEST');
  for (const channel of ['maker:schedule:list-runs', 'maker:schedule:pause', 'maker:schedule:run-now', 'maker:schedule:get-unread-count']) assert.equal((await invoke(channel, [id])).payload.error.code, 'CHANNEL_NOT_ALLOWED');
});
class ReminderSocket {
  handlers = new Map(); sent = []; readyState = 1;
  on(name, fn) { const items = this.handlers.get(name) ?? []; items.push(fn); this.handlers.set(name, items); return this; }
  emit(name, ...args) { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
  send(value) { this.sent.push(JSON.parse(value)); } close() {}
  frame(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
test('native ready notifications reach authorized linked peers and the shared observer closes after final unlink/off', async () => {
  const f = fixture(); const source = new FixtureDshSource(); source.reminders = f.port; const socket = new ReminderSocket();
  const host = await startHost(source, { transportEnabled: true, remoteControlEnabled: true, controllers: {} }, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host-handle', kind: 'phone', identifier: 'fixture' } }), openSocket: () => socket, heartbeatMs: 0,
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  try {
    await host.connect(); socket.emit('open'); socket.frame({ v: 1, kind: 'hello-ack', payload: { deviceId: 'host-handle', userId: 'fixture-account' } });
    assert.equal(f.listeners.size, 0);
    socket.frame({ v: 1, kind: 'link-open', id: 'link-1', src: 'phone-1' }); await tick(); assert.equal(f.listeners.size, 1);
    socket.frame({ v: 1, kind: 'link-open', id: 'link-2', src: 'phone-2' }); await tick(); assert.equal(f.listeners.size, 1);
    await f.port.create(form(), f.readOptions);
    const pushes = socket.sent.filter(frame => frame.kind === 'push' && frame.payload?.channel === 'maker:schedule:event');
    assert.deepEqual(pushes.map(frame => frame.dst).sort(), ['phone-1', 'phone-2']); assert.ok(pushes.every(frame => JSON.stringify(frame.payload.payload) === JSON.stringify({ type: 'ready' })));
    socket.frame({ v: 1, kind: 'link-close', src: 'phone-1' }); assert.equal(f.listeners.size, 1);
    socket.frame({ v: 1, kind: 'link-close', src: 'phone-2' }); assert.equal(f.listeners.size, 0); assert.equal(f.store.size, 1);
    socket.frame({ v: 1, kind: 'link-open', id: 'link-3', src: 'phone-1' }); assert.equal(f.listeners.size, 1);
    await host.disconnect(); assert.equal(f.listeners.size, 0); assert.equal(f.store.size, 1);
  } finally { await host.stop(); }
});
