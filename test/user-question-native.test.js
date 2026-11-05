import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { arbitrateInteraction } from '../src/dsh-plugin.js';
import { createApprovalRegistry } from '../src/host-approvals.js';

// Opt-in artifact-plane test: point to a DSH node_modules directory. For asar,
// run with the installed Electron executable in ELECTRON_RUN_AS_NODE mode.
const root = process.env.DSH_TEST_NATIVE_MODULES;
// Electron can otherwise exit with an unresolved test and no final TAP summary.
const keepAlive = root ? setInterval(() => {}, 1000) : undefined;
after(() => clearInterval(keepAlive));
const native = (name) => import(pathToFileURL(join(root, '@deepseek-ai', name, 'lib/index.js')).href);
const questions = [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }];
const answer = label => ({ answers: [{ id: 'q1', selected: [label] }] });

async function setup(t) {
  const [{ Context }, { default: Gateway }, remotes, { default: UserQuestions }] = await Promise.all([
    native('cordis'), native('dsh-api-gateway'), native('dsh-api-remotes'), native('dsh-user-questions'),
  ]);
  const ctx = new Context();
  // Only external reflection/access dependencies are stubs; the question service,
  // Cordis dispatch, Remote source, Gateway and event wire parser are installed code.
  ctx.reflect.provide('typert', {});
  ctx.reflect.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) });
  await ctx.plugin(Gateway, {});
  await ctx.plugin(remotes);
  const agent = { id: 'question-test-agent', ctx: ctx.extend(), session: { header: { id: 's1' } } };
  ctx.reflect.provide('agents', { get: id => id === agent.id ? agent : undefined, roots: () => [agent] });
  await ctx.plugin(UserQuestions);
  const registry = createApprovalRegistry();
  let handle;
  ctx.on('user-questions/request', (request, next) => arbitrateInteraction({ request, next,
    begin: async signal => { handle = await registry.askUser({ sessionId: 's1', questions: request.questions, signal }); return handle; },
    settleLocal: (id, value) => registry.settleOutcome(id, value),
  }), { prepend: true, global: true });
  const clients = [];
  t.after(async () => {
    registry.clear();
    for (const client of clients) { client.abort.abort(); await client.iterator.return(); }
    await ctx.fiber.dispose();
  });
  async function client() {
    const abort = new AbortController();
    const peer = { signal: abort.signal, interactions: 'answer', principal: { kind: 'owner' } };
    const stream = await ctx.typertGateway.wireStream.open('$events', { args: {} }, undefined, peer, abort.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const ready = (await iterator.next()).value;
    assert.equal(ready.type, 'ready');
    const result = { abort, peer, iterator, clientId: ready.clientId };
    clients.push(result);
    return result;
  }
  async function submit(client, frame, outcome) {
    const result = await ctx.typertGateway.dispatchRpc('$events/result', { args: {
      clientId: client.clientId, eventId: frame.eventId, outcome,
    } }, client.abort.signal, client.peer);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  return { ctx, agent, registry, client, submit, handle: () => handle };
}

for (const winner of ['phone', 'native']) {
  test('installed Cordis/Gateway: ' + winner + ' first settles once and dismisses native delivery', { skip: !root, timeout: 10000 }, async t => {
    const h = await setup(t);
    const web = await h.client();
    const otherWeb = await h.client();
    const result = h.ctx.userQuestions.ask({ agent: h.agent, questions });
    const frame = (await web.iterator.next()).value;
    assert.equal((await otherWeb.iterator.next()).value.eventId, frame.eventId);
    assert.equal(frame.type, 'waterfall');
    assert.equal(frame.event, 'user-questions/request');
    assert.deepEqual(frame.request.questions, questions);
    assert.equal(h.registry.list('s1').length, 1);
    const id = h.handle().requestId;
    if (winner === 'phone') {
      assert.deepEqual(h.registry.settle(id, { kind: 'ask_user_question', answers: { 'Continue?': 'Yes' } }), { accepted: true });
    } else {
      await h.submit(web, frame, { kind: 'result', value: answer('Yes') });
    }
    assert.deepEqual(await result, answer('Yes'));
    assert.deepEqual(h.registry.list('s1'), []);
    // Gateway dismisses other deliveries; the native winner closes its own UI.
    const cancellation = (await otherWeb.iterator.next()).value;
    assert.equal(cancellation.type, 'cancel');
    assert.equal(cancellation.eventId, frame.eventId);
    assert.deepEqual(h.registry.settle(id, { kind: 'ask_user_question', answers: { 'Continue?': 'No' } }), { accepted: false });
    await h.submit(web, frame, { kind: 'result', value: answer('No') });
  });
}

test('installed native Gateway replays an unanswered question to a late/reconnecting Web client', { skip: !root, timeout: 10000 }, async t => {
  const h = await setup(t);
  const result = h.ctx.userQuestions.ask({ agent: h.agent, questions });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.registry.list('s1').length, 1);
  const first = await h.client();
  const frame = (await first.iterator.next()).value;
  first.abort.abort(); await first.iterator.return();
  const second = await h.client();
  const replay = (await second.iterator.next()).value;
  assert.equal(replay.eventId, frame.eventId);
  await h.submit(second, replay, { kind: 'result', value: answer('No') });
  assert.deepEqual(await result, answer('No'));
});

test('installed native cancellation preserves UserQuestionError rather than empty answers', { skip: !root, timeout: 10000 }, async t => {
  const h = await setup(t);
  const web = await h.client();
  const result = h.ctx.userQuestions.ask({ agent: h.agent, questions });
  const rejected = assert.rejects(result, { name: 'UserQuestionError', code: 'ASK_CANCELLED' });
  const frame = (await web.iterator.next()).value;
  await h.submit(web, frame, { kind: 'rejected', error: { name: 'UserQuestionError', message: 'Cancelled by user', code: 'ASK_CANCELLED' } });
  await rejected;
  assert.deepEqual(h.registry.list('s1'), []);
});
