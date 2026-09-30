/** Pending input must not fabricate the delivery order of durable history. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter } from '../src/cindy-channels.js';
import { createInputQueueTracker, queueItemsFromInbox } from '../src/host-input-queue.js';

const SESSION = { id: 'session', cwd: '/work' };
const message = (id, clientId, text) => ({ id, source: { kind: 'user', rpcId: clientId }, content: [{ type: 'text', text }] });
const durableRow = (clientId) => ({ id: 'durable-' + clientId, clientId, role: 'user', content: { text: clientId } });
function request(channel, args) {
  return { v: 1, kind: 'invoke', id: 'request', src: 'phone', payload: { channel, args } };
}

for (const placement of ['next-turn', 'next-step']) {
  test(placement + ' stays pending across re-entry and settles only on real history', async () => {
    const tracker = createInputQueueTracker();
    const inbox = { 'next-turn': [], 'next-step': [] };
    inbox[placement] = [message('dsh-id', 'phone-id', 'still waiting')];
    const history = [];
    const router = createChannelRouter({
      listSessions: async () => [SESSION],
      subscribers: new Set(),
      resolveCapabilities: () => ({
        readSessionState: async () => ({ inbox }),
        projectionFromItems: (id, items) => tracker.projectionFor(id, SESSION, null, items),
        readMessages: async () => [...history],
        historyView: { page: async () => ({ ok: true, result: {
          version: 1, items: history.map((row) => ({ type: 'messages', key: row.clientId, messages: [row] })),
          nextCursor: null, hasMore: false,
        } }) },
      }),
    });
    for (let reopen = 0; reopen < 2; reopen += 1) {
      tracker.clear(); // No local bubble or tracker history is needed after reconnect.
      const projection = (await router(request('maker:input:get-projection', ['session']))).payload.result;
      assert.deepEqual(projection.pendingQueue.map((row) => [row.clientId, row.text]), [['phone-id', 'still waiting']]);
      assert.deepEqual(projection.steeringQueueClientIds, placement === 'next-step' ? ['phone-id'] : []);
      assert.deepEqual((await router(request('local-db:messages:list', ['session', {}]))).payload.result, []);
      assert.deepEqual((await router(request('local-db:messages:view', ['session', {}]))).payload.result.items, []);
    }

    // Actual consumption: the real message can arrive before a stale queue snapshot.
    // Cindy is right to settle it now, unlike the old synthetic user history row.
    history.push(durableRow('phone-id'));
    const echoed = (await router(request('local-db:messages:list', ['session', {}]))).payload.result;
    assert.deepEqual(echoed.map((row) => row.clientId), ['phone-id']);
    inbox[placement] = [];
    const settled = (await router(request('maker:input:get-projection', ['session']))).payload.result;
    assert.deepEqual(settled.pendingQueue, []);
    assert.deepEqual(settled.steeringQueueClientIds, []);
    const view = (await router(request('local-db:messages:view', ['session', {}]))).payload.result;
    assert.deepEqual(view.items.map((entry) => entry.messages[0].clientId), ['phone-id']);
  });
}

test('history retains actual consumption order when an insert overtakes queued prompts', async () => {
  const tracker = createInputQueueTracker();
  const inbox = { 'next-turn': [message('a', 'a', 'first'), message('b', 'b', 'second')], 'next-step': [] };
  tracker.adopt('session', queueItemsFromInbox(inbox));
  const history = [durableRow('insert')];
  const router = createChannelRouter({
    listSessions: async () => [SESSION], subscribers: new Set(),
    resolveCapabilities: () => ({ readMessages: async () => [...history], inputProjection: (id) => tracker.projectionFor(id, SESSION) }),
  });
  const projection = (await router(request('maker:input:get-projection', ['session']))).payload.result;
  assert.deepEqual(projection.pendingQueue.map((row) => row.clientId), ['a', 'b']);
  assert.deepEqual((await router(request('local-db:messages:list', ['session', {}]))).payload.result, history);
  tracker.mirror('session', 'a', { kind: 'remove' });
  history.unshift(durableRow('a'));
  assert.deepEqual((await router(request('local-db:messages:list', ['session', {}]))).payload.result.map((row) => row.clientId), ['a', 'insert']);
});
