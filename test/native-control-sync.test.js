import test from 'node:test';
import assert from 'node:assert/strict';
import { createInputQueueTracker, queueItemsFromInbox } from '../src/host-input-queue.js';
import { createProjectionTracker } from '../src/host-goals.js';
import { createChannelRouter } from '../src/cindy-channels.js';
import { createInputDeliveryCoordinator } from '../src/host-input-delivery.js';
const session={id:'s',cwd:'/work'};
const message=(text='desktop queued')=>({id:'native-input',source:{kind:'user',rpcId:'desktop-rpc'},content:[{type:'text',text}]});
const inbox=(text,step=false)=>({'next-turn':step?[]:[message(text)],'next-step':step?[message(text)]:[]});
const empty=()=>({'next-turn':[],'next-step':[]});
const frame=(value)=>({type:'projection',sessionId:'s',seq:2,changes:[{key:'inbox',val:value}]});
const projection=q=>q.projectionFor('s',session);

test('modern baseline exposes desktop-origin pending input without assistant output',()=>{
 const q=createInputQueueTracker();
 q.apply({type:'baseline',value:{projections:{s:{asOfSeq:1,values:{inbox:inbox()}}}}});
 assert.deepEqual(projection(q).pendingQueue.map(x=>[x.clientId,x.text]),[['desktop-rpc','desktop queued']]);
});
test('modern inbox replacements edit, steer and remove without any assistant event',()=>{
 const q=createInputQueueTracker();q.apply(frame(inbox('first')));
 assert.equal(projection(q).pendingQueue[0]?.text,'first');
 q.apply(frame(inbox('edited',true)));
 assert.equal(projection(q).pendingQueue[0]?.text,'edited');
 assert.deepEqual(projection(q).steeringQueueClientIds,['desktop-rpc']);
 q.apply(frame(empty()));assert.deepEqual(projection(q).pendingQueue,[]);
});
test('goal changes array is live, including an explicit clear',()=>{
 const q=createProjectionTracker();
 q.apply({type:'projection',sessionId:'s',seq:3,changes:[{key:'goal',val:{goal:{id:'g',phase:'active',objective:'work'}}}]});
 assert.equal(q.goalOf('s')?.goal?.phase,'active');
 q.apply({type:'projection',sessionId:'s',seq:4,changes:[{key:'goal',val:null}]});
 assert.equal(q.goalOf('s'),null);
});
test('enabled delivery refreshes native queue before its early projection return; foreign input stays unknown, not accepted',async()=>{
 const q=createInputQueueTracker();let refreshes=0;
 const store={list:()=>[],get:()=>undefined,boundary:()=>0,transaction:fn=>fn(),close(){}};
 const delivery=createInputDeliveryCoordinator({store,backend:{evidence:async()=>({users:[],inbox:[]})},baseProjection:()=>projection(q)});
 const router=createChannelRouter({listSessions:async()=>[session],subscribers:new Set(),resolveCapabilities:()=>({
  inputDelivery:()=>delivery,refreshInputProjection:async()=>{refreshes++;q.adopt('s',queueItemsFromInbox(inbox()));},
  inputProjection:()=>projection(q),
 })});
 try{
 const reply=await router({v:1,kind:'invoke',src:'phone',id:'r',payload:{channel:'maker:input:get-projection',args:['s',{deliveryClientIds:['desktop-rpc']}]}});
 assert.equal(reply.payload.ok,true);assert.equal(refreshes,1);
 assert.deepEqual(reply.payload.result.pendingQueue.map(x=>x.clientId),['desktop-rpc']);
 assert.equal(reply.payload.result.deliveryReceipts[0].state,'unknown');assert.deepEqual(store.list(),[]);
 }finally{await delivery.close();}
});
