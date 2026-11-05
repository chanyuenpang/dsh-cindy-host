import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
import { createMessageReader, foldSessionEvent } from '../src/dsh-message-fold.js';
import { turnStateFromEvents } from '../src/turn-error.js';
import { diagnosticSettings } from './support/diagnostic-settings.js';

const ON = { transportEnabled: true, remoteControlEnabled: true, controllers: {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise=new Promise(r=>{resolve=r;}); return {promise,resolve}; }
const start = seq => ({ type: 'turn/start', seq, time: 1000 + seq * 1000, data: { turn: 1 } });
const fail = seq => ({ type: 'turn/end', seq, time: 1000 + seq * 1000, data: { turn: 1, reason: { kind: 'error',
  error: { message: 'SECRET credential and provider prose', code: 'RATE_LIMIT', status: 429, requestId: 'SECRET' } } } });
class Socket {
  sent = []; handlers = new Map(); readyState = 1;
  on(type, fn) { const list = this.handlers.get(type) ?? []; list.push(fn); this.handlers.set(type, list); return this; }
  emit(type, data) { for (const fn of this.handlers.get(type) ?? []) fn(data); }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
}
async function setup(events = [], customize = () => {}, ports = {}) {
  const socket = new Socket(); const source = new FixtureDshSource();
  const state = { running: false };
  source.listSessionStates = async id => [{ id: id ?? 's1', running: state.running }];
  source.getSession = async id => ({ id, title: 'Task', running: state.running, cwd: 'G:/Projects', updatedAt: 1000 });
  const reader = createMessageReader({ readSessionLog: async () => ({ events }) });
  customize(reader, source);
  const runtime = await startHost(source, ON, {
    resolveSession: async () => ({ ok: true, session: { deviceId: 'host' } }),
    openSocket: () => socket, heartbeatMs: 0, listDevices: async () => ({ devices: [] }),
    resolveCapabilities: () => ({ readMessages: reader, readAllMessages: sid => reader.all(sid) }),
    ...ports,
  });
  socket.emit('open');
  socket.frame({ v: 1, kind: 'hello-ack', payload: { serverProtocolVersion: 1, deviceId: 'host', userId: 'account' } });
  let id = 0;
  const invoke = async (channel, args, src = 'phone') => {
    const requestId = `req-${++id}`;
    socket.frame({ v: 1, kind: 'invoke', id: requestId, src, payload: { channel, args } });
    await tick();
    return socket.sent.find(frame => frame.kind === 'invoke-result' && frame.id === requestId)?.payload;
  };
  const subscribe = (topics = ['session:s1'], src = 'phone') => invoke('device-link:subscribe', [{ topics }], src);
  return { runtime, socket, source, reader, state, invoke, subscribe };
}
const pushes = (socket, channel) => socket.sent.filter(frame => frame.kind === 'push' && frame.payload.channel === channel);
const terminals = socket => socket.sent.filter(frame => frame.kind === 'push' && frame.payload.channel === 'maker:event'
  && ['done', 'error'].includes(frame.payload.payload.event.type));

test('listing reads diagnostic settings once per page, not once per session',async()=>{
 let reads=0;const x=await setup([], (reader,source)=>{source.listSessions=async()=>Array.from({length:100},(_,n)=>({id:`s${n}`,cwd:'/repo',running:false,interruption:null}));},
 {diagnosticPreferences:{snapshot:()=>{reads++;return{};}}});
 try{reads=0;const reply=await x.invoke('local-db:sessions:list',[]);assert.equal(reply.ok,true);assert.ok(reads<=3,`unexpected per-row settings traversal: ${reads}`);}finally{await x.runtime.stop();}
});

test('a cold first listing carries native interruption evidence without a detail subscription', async()=>{
 const events=[start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}];
 const x=await setup(events,(reader,source)=>{source.listSessions=async()=>[{id:'s1',cwd:'/work',running:false,...await reader.activity('s1')}];});
 try{const reply=await x.invoke('local-db:sessions:list',[]);assert.equal(reply.ok,true);assert.equal(reply.result.find(row=>row.id==='s1').interruptedTurnStartedAt,1000);}finally{await x.runtime.stop();}
});

test('a persisted interruption observed without its old start refreshes metadata for list-only watchers',async()=>{
 const events=[start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}];const x=await setup(events);
 try{await x.invoke('device-link:subscribe',[{topics:['sessions']}]);x.runtime.pushTurnIdle('s1',events[1]);await tick();await tick();
  const last=pushes(x.socket,'local-db:sessions:patched').at(-1);assert.equal(last.payload.payload.patch.interruptedTurnStartedAt,1000);
 }finally{await x.runtime.stop();}
});

test('native interruption get/list metadata and durable ignore RPC share one pending identity', async () => {
 const pref=diagnosticSettings();const events=[start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}];
 const x=await setup(events,()=>{}, {diagnosticPreferences:pref.preferences});
 try{
  await x.subscribe();let reply=await x.invoke('local-db:sessions:get',['s1']);
  assert.equal(reply.ok,true);assert.equal(reply.result.activeTurnStartedAt,1000);assert.equal(reply.result.interruptedTurnStartedAt,1000);
  const ack=await x.invoke('local-db:sessions:ack-interrupted',['s1']);assert.equal(ack.ok,true);
  reply=await x.invoke('local-db:sessions:get',['s1']);assert.equal(reply.result.activeTurnStartedAt,null);
  assert.equal(pref.state.writes,1);
  assert.equal((await x.reader.all('s1')).filter(row=>row.role==='system').length,1,'ignore does not rewrite diagnostic history');
  events.push({...start(2),data:{turn:2}},{...fail(3),data:{turn:2,reason:{kind:'interrupted'}}});
  x.reader.invalidate('s1');reply=await x.invoke('local-db:sessions:get',['s1']);assert.equal(reply.result.activeTurnStartedAt,3000);
 }finally{await x.runtime.stop();}
});

test('error dismissal is durable and projects message flags; unavailable storage is not acknowledged', async()=>{
 const pref=diagnosticSettings();const x=await setup([start(0),fail(1)],()=>{}, {diagnosticPreferences:pref.preferences});
 try{
  await x.subscribe();let reply=await x.invoke('local-db:messages:dismiss-error',['s1','s1:turn-error:1']);assert.equal(reply.ok,true);
  reply=await x.invoke('local-db:messages:list',['s1']);assert.equal(reply.result[0].content.dismissed,true);
  assert.equal((await x.reader.all('s1'))[0].content.dismissed,undefined);
  x.socket.sent.length=0;await x.invoke('device-link:unsubscribe',[{topics:['session:s1']}]);await x.subscribe();
  assert.equal(terminals(x.socket).filter(frame=>frame.payload.payload.event.type==='error').length,0,'ignored errors do not re-open a live error banner on reconnect');
  reply=await x.invoke('local-db:messages:dismiss-error',['s1','missing']);assert.equal(reply.ok,false);
 }finally{await x.runtime.stop();}
 const unavailable=await setup([start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}]);
 try{await unavailable.subscribe();assert.equal((await unavailable.invoke('local-db:sessions:ack-interrupted',['s1'])).ok,false);}finally{await unavailable.runtime.stop();}
});


test('an old interruption confirmation settling after a new interrupted turn cannot dismiss the new identity', async()=>{
 const pref=diagnosticSettings();const gate=deferred();pref.state.beforeWrite=()=>gate.promise;
 const events=[start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}];
 const x=await setup(events,()=>{}, {diagnosticPreferences:pref.preferences});
 try{
  await x.subscribe();await x.invoke('local-db:sessions:ack-interrupted',['s1']);
  const nextStart={...start(2),data:{turn:2}},nextEnd={...fail(3),data:{turn:2,reason:{kind:'interrupted'}}};
  events.push(nextStart,nextEnd);x.reader.invalidate('s1');x.runtime.pushTurnRunning('s1',nextStart);x.runtime.pushTurnIdle('s1',nextEnd);
  gate.resolve();await tick();await tick();
  const reply=await x.invoke('local-db:sessions:get',['s1']);assert.equal(reply.ok,true);assert.equal(reply.result.activeTurnStartedAt,3000);
  const last=pushes(x.socket,'local-db:sessions:patched').at(-1)?.payload.payload.patch;assert.equal(last.activeTurnStartedAt,3000);
 }finally{gate.resolve();await x.runtime.stop();}
});

for (const transition of ['revoke','replace-source','stop']) test(`diagnostic confirmation does not publish into an expired ${transition} scope`, async()=>{
 const pref=diagnosticSettings();const gate=deferred();pref.state.beforeWrite=()=>gate.promise;
 const x=await setup([start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}],()=>{}, {diagnosticPreferences:pref.preferences});
 try{
  await x.subscribe();await x.invoke('local-db:sessions:ack-interrupted',['s1']);
  if(transition==='revoke')await x.runtime.updateSettings({...ON,controllers:{phone:{state:'revoked'}}});
  else if(transition==='replace-source')await x.runtime.setSource(new FixtureDshSource());
  else await x.runtime.stop();
  const before=pushes(x.socket,'local-db:sessions:patched').length;gate.resolve();await tick();await tick();
  assert.equal(pushes(x.socket,'local-db:sessions:patched').length,before);
 }finally{gate.resolve();await x.runtime.stop();}
});

test('failed diagnostic settings write leaves the original interruption pending after fresh synchronization',async()=>{
 const pref=diagnosticSettings();pref.state.fail=true;const x=await setup([start(0),{...fail(1),data:{turn:1,reason:{kind:'interrupted'}}}],()=>{}, {diagnosticPreferences:pref.preferences});
 try{await x.subscribe();assert.equal((await x.invoke('local-db:sessions:ack-interrupted',['s1'])).ok,false);const row=(await x.invoke('local-db:sessions:get',['s1'])).result;assert.equal(row.activeTurnStartedAt,1000);assert.deepEqual(pref.state.value,{});}finally{await x.runtime.stop();}
});

test('live failure emits the stable terminal error once, never done or unwatched detail', async () => {
  const x = await setup();
  try {
    await x.subscribe(); await x.subscribe(['sessions'], 'list-phone'); await x.subscribe(['session:s2'], 'other-phone');
    x.socket.sent.length = 0;
    x.runtime.pushTurnRunning('s1', start(0));
    const event = fail(1); const row = foldSessionEvent(event, { sessionId: 's1' })[0];
    await x.runtime.pushSessionMessage('s1', row);
    x.runtime.pushTurnIdle('s1', event);
    x.runtime.pushTurnIdle('s1', event);
    assert.equal(terminals(x.socket).length, 1);
    const frame = terminals(x.socket)[0];
    assert.equal(frame.dst, 'phone');
    assert.equal(frame.payload.payload.persistId, row.clientId);
    assert.equal(frame.payload.payload.event.type, 'error');
    assert.equal(frame.payload.payload.event.data.isTerminal, true);
    assert.equal(x.runtime.isSessionRunning('s1'), false);
    assert.equal(JSON.stringify(x.socket.sent).includes('SECRET'), false);
    x.runtime.pushTurnIdle('unwatched', fail(1));
    assert.equal(terminals(x.socket).length, 1);
  } finally { await x.runtime.stop(); }
});

test('cold subscribe and resubscribe recover the native failure with matching historical identity', async () => {
  const events = [start(0), fail(1)]; const x = await setup(events);
  try {
    await x.subscribe();
    const [row] = await x.reader('s1');
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.persistId, row.clientId);
    assert.equal(terminals(x.socket)[0].payload.payload.event.data.message, row.content.message);
    x.socket.sent.length = 0;
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 1, 'fresh subscription repairs a potentially missed frame');
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
    events.push(start(2)); x.state.running = true; x.socket.sent.length = 0;
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 0, 'historical failure does not terminate the new turn');
  } finally { await x.runtime.stop(); }
});

test('offline delivery is repaired by link-open without resubscribing or time-window assumptions', async () => {
  const events = []; const x = await setup(events);
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    x.socket.frame({ v: 1, kind: 'presence-changed', payload: { deviceId: 'phone', online: false } });
    events.push(start(0), fail(1));
    x.runtime.pushTurnRunning('s1', events[0]); x.runtime.pushTurnIdle('s1', events[1]);
    assert.equal(terminals(x.socket).length, 1);
    x.socket.sent.length = 0;
    x.socket.frame({ v: 1, kind: 'link-open', id: 'relink', src: 'phone' }); await tick();
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
  } finally { await x.runtime.stop(); }
});

test('legacy sources without native boundary reads retain their status-only failure ending', async () => {
  const x = await setup([], reader => { delete reader.turnState; });
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    await x.source.emit({ kind: 'session-status', sessionId: 's1', phase: 'error', sequence: 1 });
    assert.equal(terminals(x.socket).length, 1);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'done');
  } finally { await x.runtime.stop(); }
});

test('non-error native endings remain done, not failed model messages', async () => {
  const x = await setup();
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    let seq = 0;
    for (const kind of ['completed', 'aborted', 'blocked', 'max-tokens']) {
      x.runtime.pushTurnRunning('s1', start(seq++));
      const event = { ...fail(seq++), data: { turn: 1, reason: { kind } } };
      x.runtime.pushTurnIdle('s1', event);
      assert.ok(foldSessionEvent(event, { sessionId: 's1' }).every(row => row.role !== 'error'));
    }
    assert.deepEqual(terminals(x.socket).map(frame => frame.payload.payload.event.type), ['done', 'done', 'done', 'done']);
  } finally { await x.runtime.stop(); }
});

test('reconnect delivers interruption text itself before the terminal, scoped to the session phone', async () => {
  const interrupted = { ...fail(1), data: { turn: 1, reason: { kind: 'interrupted' } } };
  const x = await setup([start(0), interrupted]);
  try {
    await x.subscribe(['sessions'], 'list-phone'); x.socket.sent.length = 0; await x.subscribe();
    const created = x.socket.sent.filter(f => f.payload?.channel === 'local-db:messages:created');
    assert.equal(created.length, 1); assert.equal(created[0].dst, 'phone');
    assert.match(created[0].payload.payload.message.content, /工具调用结果未知/);
    const [terminal] = terminals(x.socket); assert.equal(terminal.payload.payload.event.type, 'done');
    assert.equal(terminal.payload.payload.persistId, created[0].payload.payload.message.clientId);
    assert.equal(x.socket.sent.indexOf(created[0]) < x.socket.sent.indexOf(terminal), true);
    x.socket.sent.length = 0; x.state.running = true; x.runtime.pushTurnRunning('s1', { ...start(2), data: { turn: 2 } });
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 0, 'an old interruption cannot close a new live turn');
  } finally { await x.runtime.stop(); }
});

test('scheduled retry reports safe ongoing status without a terminal or stale-turn cancellation', async () => {
  const x = await setup();
  const retry = { type: 'llm/retry', seq: 1, time: 2000, data: { turn: 1, mode: 'normal', retry: 1, maxRetries: 3, delayMs: 2000, failure: { code: 'RATE_LIMIT', message: 'SECRET' } } };
  try {
    await x.subscribe(); x.runtime.pushTurnRunning('s1', start(0)); x.socket.sent.length = 0;
    x.runtime.pushSessionDiagnostic('s1', retry);
    assert.equal(terminals(x.socket).length, 0); assert.equal(x.runtime.isSessionRunning('s1'), true);
    assert.ok(x.socket.sent.some(f => f.payload?.payload?.event?.data?.status?.includes('已安排重试')));
    assert.equal(JSON.stringify(x.socket.sent).includes('SECRET'), false);
    x.runtime.pushTurnIdle('s1', fail(2)); x.socket.sent.length = 0; x.runtime.pushSessionDiagnostic('s1', retry);
    assert.equal(x.socket.sent.length, 0);
    x.runtime.pushTurnRunning('s1', { ...start(3), data: { turn: 2 } }); x.socket.sent.length = 0;
    x.runtime.pushSessionDiagnostic('s1', { ...retry, seq: 4 });
    assert.equal(x.socket.sent.length, 0, 'late retry from a different turn cannot overwrite the current status');
  } finally { await x.runtime.stop(); }
});

test('late summary error is an invalidation, not a terminal signal to a list phone', async () => {
  const x = await setup([start(0), fail(1)]);
  try {
    await x.subscribe(['sessions']); x.state.running = true; x.socket.sent.length = 0;
    await x.source.emit({ kind: 'session-status', sessionId: 's1', phase: 'error', sequence: 1 }); await tick();
    assert.equal(terminals(x.socket).length, 0);
    assert.equal(x.socket.sent.some(frame => frame.payload?.channel === 'local-db:sessions:activity' && frame.payload.payload.phase === 'error'), false);
  } finally { await x.runtime.stop(); }
});

test('admitted running turn with no start in the snapshot is not falsely ended', async () => {
  const x = await setup([start(0), fail(1)]);
  try {
    x.state.running = true; await x.subscribe();
    assert.equal(terminals(x.socket).length, 0);
    assert.ok(x.socket.sent.some(frame => frame.payload?.payload?.event?.data?.isRunning === true));
  } finally { await x.runtime.stop(); }
});

for (const race of ['new-turn', 'unsubscribe', 'link-close', 'revoke', 'replace-source', 'stop']) {
  test(`recovery discards an old failed-turn read after ${race}`, async () => {
    let release;
    const x = await setup([], reader => { reader.turnState = () => new Promise(resolve => { release = resolve; }); });
    try {
      await x.subscribe(); assert.equal(typeof release, 'function');
      if (race === 'new-turn') x.runtime.pushTurnRunning('s1', start(2));
      if (race === 'unsubscribe') await x.invoke('device-link:unsubscribe', [{ topics: ['session:s1'] }]);
      if (race === 'link-close') x.socket.frame({ v: 1, kind: 'link-close', src: 'phone' });
      if (race === 'revoke') await x.runtime.updateSettings({ ...ON, controllers: { phone: { state: 'revoked' } } });
      if (race === 'replace-source') await x.runtime.setSource(new FixtureDshSource());
      if (race === 'stop') await x.runtime.stop();
      x.socket.sent.length = 0;
      release(turnStateFromEvents([start(0), fail(1)], 's1')); await tick();
      assert.equal(terminals(x.socket).length, 0);
      if (race === 'new-turn') assert.equal(x.runtime.isSessionRunning('s1'), true);
    } finally { await x.runtime.stop(); }
  });
}

test('read failure never manufactures done or reflects exception details', async () => {
  const x = await setup([], reader => { reader.turnState = async () => { throw new Error('SECRET'); }; });
  try {
    await x.subscribe();
    assert.equal(terminals(x.socket).length, 0);
    assert.equal(JSON.stringify(x.socket.sent).includes('SECRET'), false);
    assert.equal(JSON.stringify(x.runtime.getHandlerErrors()).includes('SECRET'), false);
    assert.ok(x.runtime.getHandlerErrors().some(row => row.where === 'turn-recovery'));
  } finally { await x.runtime.stop(); }
});

test('recovery corrects runtime running state when a native end notification was missed', async () => {
  const events = [start(0)]; const x = await setup(events);
  try {
    x.state.running = true; await x.subscribe(); x.runtime.pushTurnRunning('s1', start(0));
    events.push(fail(1)); x.state.running = false;
    x.socket.sent.length = 0; await x.subscribe();
    assert.equal(x.runtime.isSessionRunning('s1'), false);
    assert.equal(terminals(x.socket)[0].payload.payload.event.type, 'error');
  } finally { await x.runtime.stop(); }
});

test('late native ending cannot stop a newer turn; distinct failures retain distinct identity', async () => {
  const x = await setup();
  try {
    await x.subscribe(); x.socket.sent.length = 0;
    x.runtime.pushTurnRunning('s1', start(0)); x.runtime.pushTurnIdle('s1', fail(1));
    x.runtime.pushTurnRunning('s1', start(2)); x.runtime.pushTurnIdle('s1', fail(1));
    assert.equal(x.runtime.isSessionRunning('s1'), true);
    x.runtime.pushTurnIdle('s1', fail(3));
    assert.deepEqual(terminals(x.socket).map(frame => frame.payload.payload.persistId), ['s1:turn-error:1', 's1:turn-error:3']);
  } finally { await x.runtime.stop(); }
});
