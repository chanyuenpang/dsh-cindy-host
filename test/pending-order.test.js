/**
 * Where an accepted-but-not-durable prompt appears in the page.
 *
 * The reported symptom was 「插入之后顺序会变，它会插入到我前面说的两行话前面」, and it had two
 * causes. The real one is DSH's: an **insert is a steer**, which jumps the queue, so the inserted
 * message became durable (10:46:11) before two messages the user had queued earlier (10:45:11 and
 * 10:45:24, still waiting in `next-turn`). The transcript order is therefore honestly
 * insert-first. This Host's own contribution was to append the two queued rows *after* the whole
 * page, which put rows the user typed earlier visually below one they typed later.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePendingByTime, occurredAtMs } from '../src/cindy-channels.js';

const row = (id, iso) => ({ id, clientId: id, role: 'user', content: [], createdAt: iso });
const viewItem = (id, iso) => ({ type: 'messages', key: id, messages: [row(id, iso)] });

test('a pending prompt lands where the user typed it, not at the end', () => {
  // A and B were typed first and are still queued; the insert (C) overtook them and is durable.
  const durable = [viewItem('A0', '2026-01-01T00:00:00.000Z'), viewItem('C', '2026-01-01T00:02:00.000Z')];
  const pending = [row('A', '2026-01-01T00:01:00.000Z'), row('B', '2026-01-01T00:01:30.000Z')];
  const merged = mergePendingByTime(durable, pending.map((entry) => viewItem(entry.id, entry.createdAt)));
  assert.deepEqual(merged.map((item) => item.key), ['A0', 'A', 'B', 'C'], 'typing order, insert last');
});

test('the common case is unchanged: newer pending prompts stay at the end', () => {
  const durable = [viewItem('m1', '2026-01-01T00:00:00.000Z')];
  const pending = [viewItem('p1', '2026-01-01T00:05:00.000Z'), viewItem('p2', '2026-01-01T00:06:00.000Z')];
  assert.deepEqual(mergePendingByTime(durable, pending).map((item) => item.key), ['m1', 'p1', 'p2']);
});

test('a work group is placed by its end, and a raw list is ordered newest-first', () => {
  const work = { type: 'work', key: 'w', summary: { endedAtMs: Date.parse('2026-01-01T00:02:00.000Z') } };
  assert.deepEqual(
    mergePendingByTime([work], [viewItem('p', '2026-01-01T00:01:00.000Z')]).map((item) => item.key),
    ['p', 'w'],
    'a prompt accepted before the activity run ended belongs above it',
  );
  // `local-db:messages:list` is newest-first, so the same fact merges in the other direction.
  const list = [row('new', '2026-01-01T00:02:00.000Z'), row('old', '2026-01-01T00:00:00.000Z')];
  assert.deepEqual(
    mergePendingByTime(list, [row('mid', '2026-01-01T00:01:00.000Z')], { newestFirst: true }).map((entry) => entry.id),
    ['new', 'mid', 'old'],
  );
});

test('an entry with no readable time is treated as oldest, never dropped', () => {
  assert.equal(occurredAtMs({ type: 'work' }), 0);
  assert.equal(occurredAtMs({}), 0);
  const merged = mergePendingByTime([viewItem('m', '2026-01-01T00:00:00.000Z')], [viewItem('p', undefined)]);
  assert.deepEqual(merged.map((item) => item.key), ['p', 'm'], 'unknown sorts first and is still there');
});
