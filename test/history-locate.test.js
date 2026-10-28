import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelRouter } from '../src/cindy-channels.js';
const row = (id, clientId, at, rowid, extra = {}) => ({ id, clientId, sessionId: 's', role: 'user', content: 'hello world', createdAt: new Date(at).toISOString(), rowid, ...extra });
function harness(readAllMessages, extra = {}) {
  const router = createChannelRouter({ listSessions: async () => [], subscribers: new Set(), resolveCapabilities: () => ({ readAllMessages, ...extra }) });
  return async (channel, id, opts) => (await router({v:1,kind:'invoke',id:'request',src:'phone',payload:{channel,args:['s',id,opts]}})).payload;
}
const channel='local-db:messages:around-client-id';
test('latest client confirmation reads real user history by exact clientId in chronological order', async () => {
  const rows = [row('z','new',3000,3),row('a','wanted',2000,2),row('q','old',1000,1)];
  const reply=await harness(async () => rows)(channel,'wanted',{radius:1});
  assert.equal(reply.ok,true); assert.deepEqual(reply.result.map(r=>r.id),['q','a','z']);
});
test('radius zero returns only the committed anchor, including stable same-ms ordering',async()=>{
  const reply=await harness(async()=>[row('a','b',1000,2),row('z','wanted',1000,1),row('b','c',1000,3)])(channel,'wanted',{radius:0});
  assert.equal(reply.ok,true);assert.deepEqual(reply.result.map(r=>r.id),['z']);
});
test('uncommitted clientId is NOT_FOUND then becomes confirmable without resending',async()=>{
  let rows=[];const call=harness(async()=>rows);const absent=await call(channel,'wanted',{radius:1});
  assert.equal(absent.ok,false);assert.equal(absent.error.code,'NOT_FOUND');
  rows=[row('durable','wanted',1000,1)];const found=await call(channel,'wanted',{radius:1});
  assert.equal(found.ok,true);assert.equal(found.result[0].clientId,'wanted');
});
test('query cannot acknowledge another session or a rewound row',async()=>{
  const call=harness(async()=>[row('foreign','wanted',1000,1,{sessionId:'other'}),row('rewound','wanted',2000,2,{rewindAt:123})]);
  const reply=await call(channel,'wanted',{radius:1});assert.equal(reply.ok,false);assert.equal(reply.error.code,'NOT_FOUND');
});
test('row-id locator uses the same committed source',async()=>{
  const reply=await harness(async()=>[row('anchor','client',1000,1)])('local-db:messages:around','anchor',{radius:0});
  assert.equal(reply.ok,true);assert.equal(reply.result[0].id,'anchor');
});
test('unavailable durable reader is NOT_AVAILABLE, not a fabricated empty success',async()=>{
  const reply=await harness(undefined)(channel,'wanted');assert.equal(reply.ok,false);assert.equal(reply.error.code,'NOT_AVAILABLE');
});
test('hidden session cannot be addressed by known message identity',async()=>{
  const reply=await harness(async()=>[row('a','wanted',1000,1)],{sessionHidden:()=>true})(channel,'wanted');
  assert.equal(reply.ok,false);assert.equal(reply.error.code,'NOT_FOUND');
});
test('radius defaults and maximum match latest native query rather than an old page limit',async()=>{
  const rows=Array.from({length:501},(_,i)=>row('row-'+i,'client-'+i,i+1,i+1)).reverse();
  const call=harness(async()=>rows);
  const defaulted=await call(channel,'client-250');assert.equal(defaulted.result.length,121);
  const clamped=await call(channel,'client-250',{radius:999});assert.equal(clamped.result.length,401);
});
test('reference text clipping keeps the tail and marks lossy metadata without mutating source',async()=>{
  const original=row('a','wanted',1000,1,{agentMeta:{keep:true}});
  const reply=await harness(async()=>[original])(channel,'wanted',{radius:0,contentCharLimit:5});
  assert.equal(reply.ok,true);assert.equal(reply.result[0].content,'…orld');assert.deepEqual(reply.result[0].agentMeta,{keep:true,remoteContentTruncated:true});
  assert.equal(original.content,'hello world');
});
test('around-client-id hydrates only its located window before optional reference clipping',async()=>{
  let seen=[];const call=harness(async()=>[row('b','other',2000,2),row('a','wanted',1000,1)],{hydrateImages:async rows=>{seen=rows;return rows.map(r=>({...r,hydrated:true}));}});
  const reply=await call(channel,'wanted',{radius:0});assert.equal(seen.length,1);assert.equal(reply.result[0].hydrated,true);
});
test('malformed identities fail before any committed log is read',async()=>{
  let reads=0;const call=harness(async()=>{reads++;return [];});const r=await call(channel,'');
  assert.equal(r.ok,false);assert.equal(r.error.code,'INVALID_PARAMS');assert.equal(reads,0);
});
test('latest reference content limit validation rejects invalid values',async()=>{
  const call=harness(async()=>[row('a','wanted',1000,1)]);
  for(const limit of [0,8001,1.5,'4']) {const r=await call(channel,'wanted',{contentCharLimit:limit});assert.equal(r.ok,false);assert.equal(r.error.code,'INVALID_PARAMS');}
});
