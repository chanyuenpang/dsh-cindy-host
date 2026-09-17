import test from 'node:test';
import assert from 'node:assert/strict';
import { DshHostSource } from '../src/dsh-host-source.js';

function frame(payload) { return { rpcId: 'test-rpc', payload }; }

function client({ listResult, hostFrames = [], muxFrames = [] }) {
  return {
    sessions: { list: async () => ({ rpcId: 'list-rpc', result: listResult }) },
    events: {
      host: async function* () { for (const item of hostFrames) yield frame(item); },
      mux: async function* () { for (const item of muxFrames) yield frame(item); },
    },
  };
}

test('unwraps the session.list RPC success value', async () => {
  const source = new DshHostSource(client({ listResult: { ok: true, value: { items: [{ sessionId: 'one', running: true, updatedAt: 0 }] } } }));
  assert.deepEqual(await source.listSessions(), [{ id: 'one', running: true, updatedAt: '1970-01-01T00:00:00.000Z' }]);
});

test('rejects a failed session.list RPC response', async () => {
  const source = new DshHostSource(client({ listResult: { ok: false, error: { code: 'internal' } } }));
  await assert.rejects(() => source.listSessions(), /DSH session list failed/);
});

test('unwraps host and mux server-request payloads', async () => {
  const source = new DshHostSource(client({
    listResult: { ok: true, value: { items: [] } },
    hostFrames: [{ type: 'host/session-status', sessionId: 'one', running: true }],
    muxFrames: [{ type: 'session/subscribed', sessionId: 'two', lastSeq: 4 }],
  }));
  const received = [];
  await new Promise((resolve) => {
    source.onEvent(async (event) => {
      received.push(event);
      if (received.length === 2) resolve();
    });
  });
  assert.deepEqual(received, [
    { sessionId: 'one', sequence: 0, kind: 'session-status', phase: 'running' },
    { sessionId: 'two', sequence: 4, kind: 'session-subscribed', phase: 'subscribed' },
  ]);
});

test('turns a stream error payload into a generic recovery signal', async () => {
  const source = new DshHostSource(client({
    listResult: { ok: true, value: { items: [] } },
    hostFrames: [{ type: 'stream/error', error: { message: 'secret' } }],
  }));
  const event = await new Promise((resolve) => source.onEvent(resolve));
  assert.deepEqual(event, { kind: 'stream-failed' });
});
