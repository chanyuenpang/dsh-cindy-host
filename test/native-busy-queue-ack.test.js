import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{stripTypeScriptTypes}from'node:module';
import{openInputDeliveryStore}from'../src/host-input-delivery-store.js';import{createInputDeliveryCoordinator}from'../src/host-input-delivery.js';
// Real current Android normalization and authority/remote-epoch commit functions.
// Only React notifications, unrelated tool-error parsing, and kernel I/O are ports.
import {mobileReader} from './support/latest-mobile-queue-reader.mjs';
const row={clientId:'busy-message',text:'queued while agent is busy',persistedContent:'queued while agent is busy',model:'pi',workingDir:'/work',createOpts:{agentKind:'pi',workingDir:'/work',model:'pi'},chatMessage:{role:'user',clientId:'busy-message',content:'queued while agent is busy'}};
async function fixture(t,placement='next-turn'){
 const mobile=await mobileReader();const dir=mkdtempSync(join(tmpdir(),'native-busy-ack-'));const store=openInputDeliveryStore({file:join(dir,'ledger.sqlite'),namespace:'owner'});const proof={users:[],inbox:[],running:true};let co;const pushes=[];
 co=createInputDeliveryCoordinator({store,backend:{prepare:async()=>({payload:{text:row.text,assets:[]},queued:row}),dispatch:async()=>{proof.inbox=[{clientId:row.clientId,id:'real-inbox-id',placement}];},evidence:async()=>structuredClone(proof)},onChange:sid=>{const raw=co.currentProjection(sid);pushes.push(raw);mobile.setInputProjection(sid,raw);}});t.after(async()=>{await co.close();rmSync(dir,{recursive:true,force:true});});return{co,mobile,proof,pushes};
}
test('busy enqueue ACK and subsequent push retain the actual queued row in Android after stale-ACK fencing',async t=>{
 const h=await fixture(t);const ack=await h.co.accept('busy-session',row,{expectedClearBoundaryMs:null});assert.equal(h.mobile.normalizeInputProjection(ack).pendingQueue.length,1);
 // A queued push may outrun the enqueue ACK; the real Android epoch fence rejects that late ACK.
 assert.equal(h.mobile.setInputProjectionIfCurrent('busy-session',ack,0,0),false);
 await h.co.drain();assert.equal(h.proof.inbox.length,1,'DSH still genuinely owns the pending occurrence');assert.equal(h.mobile.current('busy-session').pendingQueue.length,1,'Host must not overwrite the accepted busy queue with an empty push');
 const poll=await h.co.projection('busy-session',{deliveryClientIds:[row.clientId]});assert.equal(h.mobile.normalizeInputProjection(poll).pendingQueue[0].clientId,row.clientId);
});
test('a claimed-but-not-yet-user occurrence leaves the queued UI without allowing a resend',async t=>{
 const h=await fixture(t);await h.co.accept('claim-session',row,{expectedClearBoundaryMs:null});await h.co.drain();h.proof.inbox=[];const p=await h.co.projection('claim-session',{deliveryClientIds:[row.clientId]});assert.equal(p.pendingQueue.length,0);assert.equal(p.deliveryReceipts[0].state,'pending');
});
test('actual next-step evidence appears as steering, never as a missing accepted input',async t=>{
 const h=await fixture(t,'next-step');await h.co.accept('steer-session',row,{expectedClearBoundaryMs:null});await h.co.drain();const p=await h.co.projection('steer-session',{deliveryClientIds:[row.clientId]});assert.equal(p.pendingQueue.length,0);assert.deepEqual(p.steeringQueueClientIds,[row.clientId]);assert.equal(p.deliveryReceipts[0].state,'pending');
});
