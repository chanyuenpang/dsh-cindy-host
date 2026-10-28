import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import {stripTypeScriptTypes} from 'node:module';
import {createChannelRouter} from '../src/cindy-channels.js';import {openInputDeliveryStore} from '../src/host-input-delivery-store.js';import {createInputDeliveryCoordinator} from '../src/host-input-delivery.js';
// Execute pinned upstream 1dba6f01 outbox code, not a rewritten imitation.
// Only type erasure, import relocation, AsyncStorage and transport/cache ports are substituted.
async function setup(t,{loseAck=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'latest-mobile-contract-'));let host;
 t.after(async()=>{if(host)await host.close();rmSync(dir,{recursive:true,force:true});});
 const refs=fileURLToPath(new URL('../fixtures/cindy-source/apps/mobile/src/session/',import.meta.url));
 const transpile=name=>stripTypeScriptTypes(readFileSync(join(refs,name),'utf8'),{mode:'transform'});
 const outboxCode=transpile('durableOutbox.ts');writeFileSync(join(dir,'outbox.mjs'),outboxCode);
 const worktree=transpile('newSessionWorktree.ts');const start=worktree.indexOf('export function isExplicitRemoteNotFoundError');assert.ok(start>=0);const end=worktree.indexOf(String.fromCharCode(10)+'}',start)+2;assert.ok(end>start);writeFileSync(join(dir,'not-found.mjs'),worktree.slice(start,end));
 let code=transpile('durableOutboxDelivery.ts');code=code.replace('from "./newSessionWorktree"','from "./not-found.mjs"').replace('from "./durableOutbox"','from "./outbox.mjs"');writeFileSync(join(dir,'delivery.mjs'),code);
 const {createDurableOutbox}=await import(pathToFileURL(join(dir,'outbox.mjs')).href);const {createDurableOutboxDelivery}=await import(pathToFileURL(join(dir,'delivery.mjs')).href);
 const disk=new Map();const phone=createDurableOutbox({getAllKeys:async()=>[...disk.keys()],getItem:async k=>disk.get(k)??null,setItem:async(k,v)=>{disk.set(k,v);},removeItem:async k=>{disk.delete(k);}});await phone.activate('realm/account');
 const proof={users:[],inbox:[],running:false};let dispatches=0,enqueues=0,cancels=0,ackLost=false;const history=new Map(),cached=new Set(),cleaned=[];
 const store=openInputDeliveryStore({file:join(dir,'ledger.sqlite'),namespace:'realm/account'});
 host=createInputDeliveryCoordinator({store,backend:{prepare:async(sid,row)=>({payload:{text:row.text,assets:[]},queued:row}),dispatch:async e=>{dispatches++;proof.inbox.push({id:'dsh-'+e.clientId,clientId:e.clientId});proof.running=true;},evidence:async()=>structuredClone(proof),remove:async(sid,id)=>{proof.inbox=proof.inbox.filter(x=>x.id!==id);}}});
 const router=createChannelRouter({listSessions:async()=>[],subscribers:new Set(),resolveCapabilities:()=>({inputDelivery:()=>host,readAllMessages:async()=>[...history.values()]})});
 async function invoke(channel,args){const reply=(await router({v:1,kind:'invoke',id:'envelope-'+Math.random(),src:'latest-phone',payload:{channel,args}})).payload;if(!reply.ok)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.result;}
 const driver=createDurableOutboxDelivery({store:phone,isCurrent:()=>true,canRun:()=>true,session:async()=>({id:'s',status:'active'}),projection:r=>invoke('maker:input:get-projection',[r.item.sessionId,{deliveryClientIds:[r.item.clientId]}]),prepare:async r=>({clientId:r.item.clientId,text:r.item.text,persistedContent:r.item.text,files:[],chatMessage:{role:'user',clientId:r.item.clientId,content:r.item.text}}),upload:async()=>{throw Error('No uploads in text contract');},enqueue:async r=>{enqueues++;const result=await invoke('maker:input:enqueue',[r.item.sessionId,r.prepared,{expectedClearBoundaryMs:r.clearBoundaryMs,sendAtMs:r.sendAtMs}]);if(loseAck&&!ackLost){ackLost=true;throw Object.assign(Error('simulated lost ACK'),{code:'TIMEOUT'});}return result;},cancel:async r=>{cancels++;return(await invoke('maker:input:remove',[r.item.sessionId,r.item.clientId,{durableDelivery:true}])).inputDeliveryCancelled===true;},history:async r=>(await invoke('local-db:messages:around-client-id',[r.item.sessionId,r.item.clientId,{radius:1}])).some(m=>m.clientId===r.item.clientId&&m.role==='user'),cacheHistory:async r=>cached.has(r.item.clientId),applyProjection:()=>{},cleanup:async(r,cancelled)=>{cleaned.push({id:r.item.clientId,cancelled});},retryable:error=>error.code==='TIMEOUT',describe:error=>error.message,confirmationMessage:'Unconfirmed',clearedMessage:'Cleared'});
 t.after(()=>driver.stop());
 async function add(cid){await phone.add({version:1,accountId:'realm/account',deviceId:'host',item:{sessionId:'s',clientId:cid,text:'message '+cid,files:[]},createdAt:Date.now()+phone.getSnapshot().length,state:'queued',uploads:[]});}
 async function step(){driver.wake();await driver.run();await host.drain();}
 function commit(cid){proof.inbox=proof.inbox.filter(x=>x.clientId!==cid);proof.users.push({clientId:cid,seq:proof.users.length+1});history.set(cid,{id:'row-'+cid,sessionId:'s',clientId:cid,role:'user',content:'message '+cid,createdAt:new Date().toISOString(),rowid:proof.users.length});}
 return{phone,host,driver,proof,history,cached,cleaned,add,step,commit,get enqueues(){return enqueues;},get dispatches(){return dispatches;},get cancels(){return cancels;}};
}
test('real latest phone transfers v1 ownership, frees the next FIFO, then cleans only after history cache',async t=>{
 const h=await setup(t);await h.add('first');await h.add('second');await h.step();assert.equal(h.phone.getSnapshot().find(r=>r.item.clientId==='first').state,'host-owned');assert.equal(h.enqueues,1);
 await h.step();assert.equal(h.enqueues,2);assert.equal(h.dispatches,2);assert.ok(h.phone.getSnapshot().every(r=>r.state==='host-owned'));
 h.commit('first');h.commit('second');await h.step();assert.equal(h.phone.getSnapshot().length,2,'history without local cache must not destroy phone recovery evidence');assert.ok(h.phone.getSnapshot().every(r=>r.historyConfirmed));
 h.cached.add('first');h.cached.add('second');await h.step();assert.equal(h.phone.getSnapshot().length,0);assert.equal(h.enqueues,2);assert.equal(h.cleaned.length,2);
});
test('real latest phone reconciles a lost durable ACK without a second enqueue',async t=>{
 const h=await setup(t,{loseAck:true});await h.add('lost-ack');await h.step();assert.equal(h.enqueues,1);await h.step();assert.equal(h.enqueues,1);assert.equal(h.dispatches,1);assert.equal(h.phone.getSnapshot()[0].state,'host-owned');
 h.commit('lost-ack');h.cached.add('lost-ack');await h.step();assert.equal(h.phone.getSnapshot().length,0);assert.equal(h.enqueues,1);
});
test('real latest phone cancellation seals the Host receipt and completes local cleanup',async t=>{
 const h=await setup(t);await h.add('cancel');await h.step();const record=h.phone.getSnapshot()[0];await h.phone.update(record,{cancelRequested:true});await h.step();assert.equal(h.cancels,1);assert.equal(h.phone.getSnapshot().length,0);assert.deepEqual(h.cleaned,[{id:'cancel',cancelled:true}]);
 const projection=await h.host.projection('s',{deliveryClientIds:['cancel']});assert.equal(projection.deliveryReceipts[0].state,'removed');
});
