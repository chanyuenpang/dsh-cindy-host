import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter } from '../src/cindy-channels.js';
import { createSessionControllerSource } from '../src/dsh-session-source.js';
import { createSessionFlags } from '../src/session-flags.js';

// Contract regression, not a claim of delivery to a real handset.
function fixture(initial = {}) {
  let clock = 1_000_000;
  let saved = structuredClone(initial);
  const titles = new Map([['target', 'Old name'], ['other', '09-20']]);
  const history = new Map([['target', [{ id: 'target-message', text: 'history' }]],
    ['other', [{ id: 'other-message', text: 'other history' }]]]);
  const flags = createSessionFlags({ initial, persist: async value => { saved = structuredClone(value); } });
  const source = createSessionControllerSource({
    sessionController: { list: async () => ({ items: [...titles.keys()].map(sessionId => ({
      sessionId, running: true, blank: false, updatedAt: clock, cwd: '/workspace',
    })) }) },
    readTitles: async ids => new Map(ids.map(id => [id, titles.get(id)])),
    readSessionMeta: async ids => new Map(ids.map(id => [id, { createdAt: '2026-09-20T07:00:00.000Z', cwd: '/workspace' }])),
    now: () => clock,
  });
  const pushes = [];
  const router = createChannelRouter({
    listSessions: async () => flags.projectAll(await source.listSessions()),
    subscribers: new Set(), now: () => clock,
    getDevice: () => ({ deviceId: 'host', deviceName: 'Host' }),
    resolveCapabilities: () => ({
      renameSession: async ({ sessionId, title }) => { titles.set(sessionId, title); source.invalidateTitle(sessionId); },
      applySessionFlags: (id, patch) => flags.apply(id, patch),
      sessionHidden: id => flags.isHidden(id),
      readMessages: async id => structuredClone(history.get(id)),
      isSessionRunning: () => true,
      pushTurnRunning: id => pushes.push(['running', id]),
      pushTurnIdle: id => pushes.push(['idle', id]),
      pushInputProjection: id => pushes.push(['input', id]),
      invalidateHistoryView: id => pushes.push(['history', id]),
    }),
  });
  async function invoke(channel, args = []) {
    const reply = await router({ v: 1, kind: 'invoke', id: 'request', src: 'phone', payload: { channel, args } });
    assert.equal(reply.payload.ok, true);
    return reply.payload.result;
  }
  return { invoke, flags, pushes, titles, saved: () => saved, advance: ms => { clock += ms; } };
}

test('rename keeps stable identity, history and reconnect routing with an identical display name', async () => {
  const f = fixture();
  const before = await f.invoke('local-db:sessions:list'); // warm old list + title caches
  const history = await f.invoke('local-db:messages:list', ['target']);
  const renamed = await f.invoke('local-db:sessions:patch-meta', ['target', { title: '09-20' }]);
  assert.equal(renamed.id, 'target');
  assert.equal(renamed.title, '09-20');
  assert.equal(renamed.status, 'active');
  assert.equal(renamed.createdAt, before[0].createdAt);
  assert.deepEqual(f.saved(), {}, 'title-only writes must not create archive flags');
  const rows = await f.invoke('local-db:sessions:list');
  assert.deepEqual(rows.map(row => row.id), ['target', 'other']);
  assert.equal(rows[0].title, rows[1].title);
  assert.equal((await f.invoke('local-db:sessions:get', ['other'])).id, 'other');
  assert.deepEqual(await f.invoke('local-db:messages:list', ['target']), history);
  assert.notDeepEqual(await f.invoke('local-db:messages:list', ['other']), history);
  const topics = ['session:target']; // pre-rename cached topic remains valid
  await f.invoke('device-link:subscribe', [{ topics }]);
  await f.invoke('device-link:unsubscribe', [{ topics }]);
  await f.invoke('device-link:subscribe', [{ topics }]);
  assert.deepEqual(f.pushes, [...Array(2)].flatMap(() => [
    ['running', 'target'], ['input', 'target'], ['history', 'target'],
  ]));
});

test('legacy archive flags explain hidden rows; explicit ID restore invalidates old list without restoring its namesake', async () => {
  const f = fixture({ target: { status: 'archived', pinnedAt: '' }, other: { status: 'archived' } });
  const before = await f.invoke('local-db:sessions:list');
  assert.equal(before.find(row => row.id === 'target').status, 'archived');
  assert.deepEqual(await f.invoke('maker:list-active'), []);
  const renamed = await f.invoke('local-db:sessions:patch-meta', ['target', { title: '09-20' }]);
  assert.equal(renamed.status, 'archived', 'rename is not authorization to unarchive');
  const restored = await f.invoke('local-db:sessions:patch-meta', ['target', { status: 'active' }]);
  assert.equal(restored.status, 'active');
  assert.equal(restored.id, 'target');
  assert.equal((await f.invoke('local-db:sessions:get', ['target'])).status, 'active');
  assert.equal((await f.invoke('local-db:sessions:get', ['other'])).status, 'archived');
  assert.deepEqual((await f.invoke('maker:list-active')).map(row => row.sessionId), ['target']);
  assert.deepEqual(f.saved(), { other: { status: 'archived' } });
  const restarted = createSessionFlags({ initial: f.saved() });
  assert.equal(restarted.isHidden('target'), false);
  assert.equal(restarted.isHidden('other'), true);
});

test('external display rename converges after existing title and list cache TTLs without changing ID', async () => {
  const f = fixture();
  await f.invoke('local-db:sessions:list');
  f.titles.set('target', '09-20');
  f.advance(61_000);
  await f.invoke('local-db:sessions:list'); // stale-while-revalidate serves the old page once
  await new Promise(resolve => setImmediate(resolve));
  const rows = await f.invoke('local-db:sessions:list');
  assert.deepEqual(rows.map(row => [row.id, row.title, row.status]), [
    ['target', '09-20', 'active'], ['other', '09-20', 'active'],
  ]);
});
