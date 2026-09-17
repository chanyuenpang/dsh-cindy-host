import test from 'node:test'; import assert from 'node:assert/strict';
import { createSessionFlags } from '../src/session-flags.js';
import { validateHostSettings } from '../src/host-settings.js';

// The three actions DSH has no concept of (删除 / 归档 / 置顶) are this Host's own
// bookkeeping. The controller reads the **returned row** as the truth and applies
// only the fields it wrote, so every test here asks the same question: what does the
// controller get back, and does it say what the user did?

test('archive, delete and pin are remembered and projected onto the row', async () => {
  const saved = [];
  const flags = createSessionFlags({ persist: async (snapshot) => saved.push(snapshot) });

  const archived = await flags.apply('s1', { status: 'archived' });
  assert.deepEqual(archived, { status: 'archived', pinnedAt: null });
  assert.deepEqual(flags.project({ id: 's1', title: 'x' }), { id: 's1', title: 'x', status: 'archived' });
  assert.equal(flags.isHidden('s1'), true, 'an archived row must not light the running badge');

  // One unpinned row is the shape the phone's own `swipeActionPatch('archive')` sends.
  await flags.apply('s2', { status: 'archived', pinnedAt: null });
  assert.deepEqual(flags.project({ id: 's2' }), { id: 's2', status: 'archived' }, 'an unpinned row carries no pinnedAt at all');
  const deleted = await flags.apply('s3', { status: 'deleted' });
  assert.equal(deleted.status, 'deleted');
  assert.equal(flags.isHidden('s3'), true);

  const pinned = await flags.apply('s4', { pinnedAt: '2026-09-17T00:00:00.000Z' });
  assert.deepEqual(pinned, { status: 'active', pinnedAt: '2026-09-17T00:00:00.000Z' });
  assert.deepEqual(flags.project({ id: 's4' }), { id: 's4', pinnedAt: '2026-09-17T00:00:00.000Z' });

  // Every write persisted the whole store, not a delta: the settings section is the
  // only home these flags have.
  assert.equal(saved.length, 4);
  assert.deepEqual(saved[3], {
    s1: { status: 'archived' },
    s2: { status: 'archived' },
    s3: { status: 'deleted' },
    s4: { pinnedAt: '2026-09-17T00:00:00.000Z' },
  });

  // A row with no flags is handed back untouched — no copy, no invented status.
  const plain = { id: 's9' };
  assert.equal(flags.project(plain), plain);
});

test('restoring a session leaves nothing behind, and an unpin leaves no trace', async () => {
  const flags = createSessionFlags({});
  await flags.apply('s1', { status: 'archived' });
  const restored = await flags.apply('s1', { status: 'active' });
  assert.deepEqual(restored, { status: 'active', pinnedAt: null });
  // The absence of a flag is the flag: an entry per restored row would grow the
  // settings file with every archive the user undid.
  assert.deepEqual(flags.snapshot(), {});

  await flags.apply('s2', { pinnedAt: '2026-01-01T00:00:00.000Z' });
  const unpinned = await flags.apply('s2', { pinnedAt: null });
  assert.deepEqual(unpinned, { status: 'active', pinnedAt: null });
  // Deleting the pin is the whole unpin: this store is the only source of a pin, so
  // there is no stale value for the row to pick back up — and the store does not
  // accumulate an entry for every session the user ever unpinned.
  assert.deepEqual(flags.project({ id: 's2' }), { id: 's2' });
  assert.deepEqual(flags.snapshot(), {});
});

test('the flags survive a restart through the settings section', async () => {
  const first = createSessionFlags({});
  await first.apply('s1', { status: 'archived' });
  await first.apply('s2', { pinnedAt: '2026-09-17T00:00:00.000Z' });

  // A second process reads the same settings section back. Without this the archived
  // session would silently reappear on the next start.
  const second = createSessionFlags({ initial: first.snapshot() });
  assert.equal(second.isHidden('s1'), true);
  assert.deepEqual(second.project({ id: 's2' }), { id: 's2', pinnedAt: '2026-09-17T00:00:00.000Z' });
  assert.equal(second.isHidden('nope'), false);

  // The wire shape has to agree with the schema that stores it, or the settings
  // service rejects the write and the flag is lost in silence.
  assert.doesNotThrow(() => validateHostSettings({
    transportEnabled: true, remoteControlEnabled: true, controllers: {}, sessionFlags: first.snapshot(),
  }));
});

test('a malformed stored entry costs one row, and an unsupported write is refused', async () => {
  // Settings survive upgrades and hand edits, so normalize on the way in rather than
  // trusting the file.
  const flags = createSessionFlags({ initial: {
    good: { status: 'archived' },
    junk: 'archived',
    nulled: null,
    empty: {},
    wrongStatus: { status: 'snoozed' },
    wrongPin: { pinnedAt: 7 },
    // What an older build's `pinnedAt: null` looks like after a YAML round trip.
    blankPin: { pinnedAt: '' },
  } });
  assert.deepEqual(flags.snapshot(), { good: { status: 'archived' } });
  assert.equal(flags.isHidden('junk'), false, 'an unreadable entry must not hide a session');

  // A status the controller's own filter cannot express is an error, not a silent
  // no-op: a no-op reply would revert the user's edit with no explanation.
  await assert.rejects(() => flags.apply('s1', { status: 'snoozed' }), /unsupported session status/);
  await assert.rejects(() => flags.apply('s1', { pinnedAt: 42 }), /pinnedAt must be/);
  assert.deepEqual(flags.snapshot(), { good: { status: 'archived' } }, 'a refused write changes nothing');
});
