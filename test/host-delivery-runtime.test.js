import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startHost} from '../src/host.js';import {FixtureDshSource} from '../src/fixture-source.js';
class Socket{constructor(){this.sent=[];this.handlers=new Map();this.readyState=1;}on(type,fn){this.handlers.set(type,[...(this.handlers.get(type)??[]),fn]);return this;}emit(type,...args){for(const fn of this.handlers.get(type)??[])fn(...args);}send(data){this.sent.push(JSON.parse(data));}close(){}frame(frame){this.emit('message',Buffer.from(JSON.stringify(frame)));}}
async function setup(t,{verified=true,online=false,dir}={}){
 let ownsDir=false;if(!dir){dir=mkdtempSync(join(tmpdir(),'host-v1-runtime-'));ownsDir=true;}
 let available=true,dispatches=0;const proof={users:[],inbox:[],running:false};const sockets=[];
 const backend={available:()=>available,prepare:async(sid,row)=>({payload:{text:row.text,assets:[]},queued:{...row,workingDir:'/work'}}),evidence:async()=>structuredClone(proof),dispatch:async entry=>{dispatches++;proof.inbox.push({id:'dsh-'+entry.clientId,clientId:entry.clientId});},remove:async(sid,id)=>{proof.inbox=proof.inbox.filter(x=>x.id!==id);}};
 const runtime=await startHost(new FixtureDshSource(),{transportEnabled:online,remoteControlEnabled:true,controllers:{}},{inputDeliveryDirectory:dir,...(verified?{inputDeliveryNamespace:'isolated-account'}:{}),resolveCapabilities:()=>({inputDeliveryBackend:backend}),resolveSession:async()=>({ok:true,session:{deviceId:'host-id',accessToken:'test'}}),openSocket:()=>{const s=new Socket();sockets.push(s);return s;},heartbeatMs:0,listDevices:async()=>({devices:[]})});
 let closed=false;async function close(){if(closed)return;closed=true;await runtime.stop();}t.after(async()=>{await close();if(ownsDir)rmSync(dir,{recursive:true,force:true});});
 const invoke=async(channel,args)=>{const result=await runtime.invokeForTest(channel,args);assert.equal(result.ok,true,result.error);return result.reply.payload;};
 return{runtime,invoke,sockets,proof,dir,close,setAvailable:value=>{available=value;},get dispatches(){return dispatches;}};
}
test('actual Host runtime routes projection and enqueue through its account-scoped SQLite owner',async t=>{
 const h=await setup(t);const initial=await h.invoke('maker:input:get-projection',['s',{deliveryClientIds:['c']}]);assert.equal(initial.ok,true);assert.equal(initial.result.inputDeliveryVersion,1);assert.equal(h.runtime.getStatus().inputDelivery.ready,true);
 const accepted=await h.invoke('maker:input:enqueue',['s',{clientId:'c',text:'runtime input',files:[],durableDelivery:true},{expectedClearBoundaryMs:null}]);assert.equal(accepted.ok,true);assert.equal(accepted.result.deliveryReceipts[0].state,'pending');await new Promise(setImmediate);await new Promise(setImmediate);assert.equal(h.dispatches,1);
 const removed=await h.invoke('maker:input:remove',['s','c',{durableDelivery:true}]);assert.equal(removed.ok,true);assert.equal(removed.result.inputDeliveryCancelled,true);
 await h.close();const next=await setup(t,{dir:h.dir});const receipt=await next.invoke('maker:input:get-projection',['s',{deliveryClientIds:['c']}]);assert.equal(receipt.result.deliveryReceipts[0].state,'removed');await next.close();
});
test('runtime does not manufacture v1 readiness before a verified account or a durable backend',async t=>{
 const h=await setup(t,{verified:false});const unbound=await h.invoke('maker:input:get-projection',['s']);assert.equal(unbound.ok,false);assert.equal(unbound.error.code,'DELIVERY_NOT_AVAILABLE');assert.equal(h.runtime.getStatus().inputDelivery.ready,false);
 const q=await setup(t);q.setAvailable(false);const unavailable=await q.invoke('maker:input:get-projection',['s']);assert.equal(unavailable.ok,false);assert.equal(unavailable.error.code,'DELIVERY_NOT_AVAILABLE');assert.equal(q.runtime.getStatus().inputDelivery.ready,false);
});
test('queued edits mutate the replay owner rather than leaving stale payload on disk',async t=>{
 const h=await setup(t);await h.invoke('maker:input:enqueue',['s',{clientId:'edit',text:'before',files:[]},{expectedClearBoundaryMs:null}]);await new Promise(setImmediate);await new Promise(setImmediate);
 const edited=await h.invoke('maker:input:update-text',['s','edit','after']);assert.equal(edited.ok,true);assert.equal(edited.result.pendingQueue.find(x=>x.clientId==='edit').text,'after');
});
