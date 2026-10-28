import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openInputDeliveryStore} from '../src/host-input-delivery-store.js';import {createInputDeliveryCoordinator} from '../src/host-input-delivery.js';
function killedWriter(t,phase){const dir=mkdtempSync(join(tmpdir(),'host-kill-proof-'));const file=join(dir,'ledger.sqlite');const moduleURL=new URL('../src/host-input-delivery-store.js',import.meta.url).href;
 const code='import {openInputDeliveryStore} from '+JSON.stringify(moduleURL)+';const s=openInputDeliveryStore({file:'+JSON.stringify(file)+',namespace:"account"});s.transaction(()=>s.put({sessionId:"s",clientId:"c",phase:'+JSON.stringify(phase)+',attemptEpoch:s.epoch,attemptPid:s.pid,attemptNo:1,payload:{text:"durable before process death",assets:[]},queued:{clientId:"c",text:"durable before process death"}}));process.kill(process.pid,"SIGKILL");';
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{stdio:'inherit',windowsHide:true});assert.notEqual(child.status,0,'child must die without graceful store close');return{file,dir};}
test('FULL/WAL committed ownership survives a genuinely killed process and releases its lease',async t=>{
 const {file,dir}=killedWriter(t,'claimed');const store=openInputDeliveryStore({file,namespace:'account'});let dispatches=0;
 const co=createInputDeliveryCoordinator({store,backend:{evidence:async()=>({users:[],inbox:[],running:false}),dispatch:async entry=>{assert.equal(entry.payload.text,'durable before process death');dispatches++;}}});
 try{co.recover();await co.drain();assert.equal(dispatches,1);assert.equal(store.get('s','c').attemptNo,2);co.recover();await co.drain();assert.equal(dispatches,1);}finally{await co.close();rmSync(dir,{recursive:true,force:true});}
});
test('sealed cancellation survives process kill and cannot become a replay',async t=>{
 const {file,dir}=killedWriter(t,'removed');const store=openInputDeliveryStore({file,namespace:'account'});let dispatches=0;const co=createInputDeliveryCoordinator({store,backend:{evidence:async()=>({users:[],inbox:[],running:false}),dispatch:async()=>{dispatches++;}}});
 try{co.recover();await co.drain();assert.equal(dispatches,0);assert.equal(co.currentProjection('s',['c']).deliveryReceipts[0].state,'removed');}finally{await co.close();rmSync(dir,{recursive:true,force:true});}
});
