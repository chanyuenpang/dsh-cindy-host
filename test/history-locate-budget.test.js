import test from 'node:test';import assert from 'node:assert/strict';import {fitInvokeResultToFrame,frameByteLength} from '../src/host-frame-budget.js';
for(const channel of ['local-db:messages:around','local-db:messages:around-client-id'])test(channel+' trimming preserves the actual confirmation anchor rather than the oldest prefix',()=>{
 const rows=Array.from({length:101},(_,i)=>({id:'s:message-'+i+':0',sessionId:'s',clientId:'client-'+i,role:'user',createdAt:new Date(i+1).toISOString(),content:'body'.repeat(1000),agentMeta:{extra:'x'.repeat(500)}}));
 const request={id:'r',src:'phone',payload:{channel,args:['s',channel.endsWith('around-client-id')?'client-50':'s:message-50:0',{radius:60}]}};const reply={v:1,kind:'invoke-result',id:'r',dst:'phone',payload:{ok:true,result:rows}};
 const fitted=fitInvokeResultToFrame({reply,request,channel,budgetBytes:5000});assert.equal(fitted.reply.payload.ok,true);assert.ok(frameByteLength(fitted.reply)<=5000);assert.ok(fitted.reply.payload.result.some(row=>row.clientId==='client-50'));assert.ok(fitted.reply.payload.result.length<rows.length);
});
