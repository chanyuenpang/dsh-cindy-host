import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openInputDeliveryStore} from '../src/host-input-delivery-store.js';
import {createInputDeliveryCoordinator} from '../src/host-input-delivery.js';
const item=(clientId='c',text='hello')=>({clientId,text,persistedContent:text,files:[],chatMessage:{role:'user',clientId,content:text}});
const boundary={expectedClearBoundaryMs:null};
const cleanups=new WeakMap();
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function setup(t,{epoch='process-A',file,proof,prepare,dispatch,remove,recoverColdInbox,now}={}){
  if(!cleanups.has(t)){const cleanup={dirs:[],closers:[]};cleanups.set(t,cleanup);t.after(async()=>{for(const close of [...cleanup.closers].reverse())await close();for(const dir of cleanup.dirs)rmSync(dir,{recursive:true,force:true});});}
  if(!file){const dir=mkdtempSync(join(tmpdir(),'input-coordinator-'));cleanups.get(t).dirs.push(dir);file=join(dir,'ledger.sqlite');}
  const state=proof??{users:[],inbox:[],running:false};let calls=0,prepares=0;
  const store=openInputDeliveryStore({file,namespace:'account',epoch,isAlive:()=>false});
  const backend={evidence:async()=>structuredClone(state),prepare:async(sid,row)=>{prepares++;return prepare?prepare(sid,row):{payload:{text:row.text,assets:[]},queued:row};},dispatch:async e=>{calls++;if(dispatch)return dispatch(e,state);state.inbox.push({id:'dsh-'+e.clientId,clientId:e.clientId});},remove:async(sid,id)=>{if(remove)return remove(sid,id,state);state.inbox=state.inbox.filter(x=>x.id!==id);},recoverColdInbox};
  const errors=[];const co=createInputDeliveryCoordinator({store,backend,onError:e=>errors.push(e.code??e.message),now});let closed=false;
  async function close(){if(closed)return;closed=true;await co.close();}cleanups.get(t).closers.push(close);
  return{co,store,state,file,close,errors,get calls(){return calls;},get prepares(){return prepares;}};
}
test('v1 pending ACK follows durable complete payload and precedes DSH dispatch',async t=>{
  const h=setup(t);const ack=await h.co.accept('s',item(),boundary);assert.equal(ack.inputDeliveryVersion,1);assert.deepEqual(ack.deliveryReceipts,[{clientId:'c',state:'pending'}]);assert.equal(h.store.get('s','c').payload.text,'hello');assert.equal(h.calls,0);await h.co.drain();assert.equal(h.calls,1);
});
test('concurrent new envelopes with the same clientId share one admission',async t=>{
  const h=setup(t);await Promise.all(Array.from({length:12},()=>h.co.accept('s',item(),boundary)));await h.co.drain();assert.equal(h.calls,1);assert.equal(h.prepares,1);assert.equal(h.state.inbox.length,1);
});
test('same clientId cannot silently replace immutable input',async t=>{const h=setup(t);await h.co.accept('s',item(),boundary);await assert.rejects(h.co.accept('s',item('c','different'),boundary),e=>e.code==='INPUT_DELIVERY_CONFLICT');await h.co.drain();assert.equal(h.calls,1);});
test('claim-to-user empty window in a live process never causes a resend',async t=>{
  const h=setup(t,{dispatch:async(e,state)=>{state.running=true;}});await h.co.accept('s',item(),boundary);await h.co.drain();
  for(let i=0;i<3;i++){const p=await h.co.projection('s',{deliveryClientIds:['c']});assert.equal(p.deliveryReceipts[0].state,'pending');await h.co.drain();}
  assert.equal(h.calls,1);assert.equal(h.store.get('s','c').phase,'claimed');
  h.state.users.push({clientId:'c',seq:7});const accepted=await h.co.projection('s',{deliveryClientIds:['c']});assert.equal(accepted.deliveryReceipts[0].state,'accepted');await h.co.drain();assert.equal(h.calls,1);
});
test('ACK loss and same-process reload retain claim ownership without replay',async t=>{
  const h=setup(t,{dispatch:async()=>{}});await h.co.accept('s',item(),boundary);await h.co.drain();await h.close();
  const next=setup(t,{file:h.file,epoch:'process-A'});await next.co.accept('s',item(),boundary);next.co.recover();await next.co.drain();assert.equal(next.calls,0);assert.equal(next.store.get('s','c').phase,'claimed');
});
test('proven dead process without user or inbox rebuilds one logical attempt',async t=>{
  const h=setup(t,{dispatch:async()=>{}});await h.co.accept('s',item(),boundary);await h.co.drain();await h.close();
  const next=setup(t,{file:h.file,epoch:'process-B'});next.co.recover();await next.co.drain();assert.equal(next.calls,1);assert.equal(next.store.get('s','c').attemptNo,2);
});
test('restart with a persisted user imports accepted and does not replay',async t=>{
  const h=setup(t,{dispatch:async()=>{}});await h.co.accept('s',item(),boundary);await h.co.drain();await h.close();const next=setup(t,{file:h.file,epoch:'process-B',proof:{users:[{clientId:'c',seq:8}],inbox:[],running:false}});next.co.recover();await next.co.drain();assert.equal(next.calls,0);assert.equal((await next.co.projection('s',{deliveryClientIds:['c']})).deliveryReceipts[0].state,'accepted');
});
test('cold mixed inbox stays pending instead of silently reordering or waking with a fake message',async t=>{
  const h=setup(t);await h.co.accept('s',item(),boundary);await h.co.drain();await h.close();const next=setup(t,{file:h.file,epoch:'process-B',proof:{users:[],inbox:[{id:'dsh-c',clientId:'c'},{id:'foreign',clientId:'other'}],running:false},recoverColdInbox:async()=>false});next.co.recover();await next.co.drain();assert.equal(next.calls,0);assert.equal(next.co.diagnostics()[0].error,'DELIVERY_RECOVERY_WAITING');
});
test('cancel before enqueue seals durable tombstone and later new envelope cannot execute',async t=>{
  const h=setup(t);const cancel=await h.co.cancel('s','c');assert.equal(cancel.inputDeliveryCancelled,true);await h.co.accept('s',item(),boundary);await h.co.drain();assert.equal(h.calls,0);await h.close();const next=setup(t,{file:h.file,epoch:'process-B'});assert.equal((await next.co.accept('s',item(),boundary)).deliveryReceipts[0].state,'removed');await next.co.drain();assert.equal(next.calls,0);
});
test('cancel of a claimed input does not falsely report successful withdrawal',async t=>{
  const h=setup(t,{dispatch:async(e,state)=>{state.running=true;}});await h.co.accept('s',item(),boundary);await h.co.drain();const p=await h.co.cancel('s','c');assert.equal(p.inputDeliveryCancelled,false);assert.equal(p.deliveryReceipts[0].state,'pending');
});
test('remove flush failure never creates a successful tombstone and retry can finish it',async t=>{
  let fail=true;const h=setup(t,{remove:async(sid,id,state)=>{state.inbox=[];if(fail)throw Object.assign(Error('flush failed'),{deliveryRemovalApplied:true});}});await h.co.accept('s',item(),boundary);await h.co.drain();await assert.rejects(h.co.cancel('s','c'),/flush failed/);assert.notEqual(h.store.get('s','c').phase,'removed');fail=false;assert.equal((await h.co.cancel('s','c')).inputDeliveryCancelled,true);
});
test('clear boundary is atomic, monotonic on clock rollback, and fences late unknown enqueue',async t=>{
  let clock=100;const h=setup(t,{now:()=>clock});await h.co.clear('s');clock=1;await h.co.clear('s');assert.equal(h.store.boundary('s'),101);await assert.rejects(h.co.accept('s',item(),boundary),e=>e.code==='REMOTE_OPTIMISTIC_INPUT_CLEARED');assert.equal(h.calls,0);
});
test('clear during asynchronous preparation cannot ACK a pre-clear input',async t=>{
  const gate=deferred();const started=deferred();const h=setup(t,{prepare:async(sid,row)=>{started.resolve();await gate.promise;return{payload:{text:row.text},queued:row};}});
  const accept=h.co.accept('s',item(),boundary);const rejected=assert.rejects(accept,e=>e.code==='REMOTE_OPTIMISTIC_INPUT_CLEARED');await started.promise;const clear=h.co.clear('s');gate.resolve();await rejected;await clear;assert.equal(h.store.get('s','c'),null);assert.equal(h.calls,0);
});
test('delivery ID validation matches newest 0/64/65 and dedup contract',async t=>{
  const h=setup(t);assert.deepEqual((await h.co.projection('s',{deliveryClientIds:[]})).deliveryReceipts,[]);assert.equal((await h.co.projection('s',{deliveryClientIds:['x','x']})).deliveryReceipts.length,1);
  const ids=Array.from({length:64},(_,i)=>'id-'+i);assert.equal((await h.co.projection('s',{deliveryClientIds:ids})).deliveryReceipts.length,64);
  for(const bad of [[...ids,'overflow'],[''],['a'.repeat(257)],[1]])await assert.rejects(h.co.projection('s',{deliveryClientIds:bad}),e=>e.code==='INVALID_PARAMS');
});
test('one completed admission does not block the next clientId in the session FIFO',async t=>{
  const order=[];const h=setup(t,{dispatch:async(e,state)=>{order.push(e.clientId);state.running=true;}});await h.co.accept('s',item('first'),boundary);await h.co.accept('s',item('second'),boundary);await h.co.drain();assert.deepEqual(order,['first','second']);assert.equal(h.store.list('s').length,2);
});
