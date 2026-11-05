import test from 'node:test';import assert from 'node:assert/strict';
import {createDshInputDeliveryBackend,durableInputEvidence} from '../src/dsh-input-delivery.js';
import { CONTINUE_INTERRUPTED, CONTINUE_ERROR } from '../src/continuation-protocol.js';
const message=(id,cid)=>({id,role:'user',content:[{type:'text',text:'hello'}],source:{kind:'user',rpcId:cid}});
const splice=(seq,start,removedCount,inserted,target='next-turn')=>({seq,time:seq+1,type:'agent/inbox/spliced',data:{target,start,removedCount,inserted}});
function fixture(options={}){
  let memory=[],stored=[],closed=0,flushFailure=false,promptFailure=null,readFailure=false;let uploads=0,prompts=0;
  const session={snapshotEvents:()=>structuredClone(memory)};const agent={status:'idle',session};
  const services={sessions:{get:()=>session,flush:async()=>{if(flushFailure)throw Error('flush rejected');stored=structuredClone(memory);return true;}},persistence:{open:async(sid,access)=>{assert.equal(access,'read');return{read:async()=>{if(readFailure)throw Error('corrupt log');return{events:structuredClone(stored)};},close:async()=>{closed++;}};}},agents:{get:()=>agent},fileSystem:{resolve:async path=>path,stat:async()=>({type:'file',size:3}),readByteRange:async()=>Buffer.from('abc')},fileUploads:{upload:async()=>({receiptId:'receipt-'+(++uploads)})}};
  const controller={resolveAgent:async()=>({agent}),prompt:async req=>{prompts++;if(promptFailure)throw promptFailure;const proof=durableInputEvidence(memory,'s');memory.push(splice(memory.length,proof.inbox.filter(x=>x.placement==='next-turn').length,0,[message('dsh-'+req.requestId,req.requestId)]));return{accepted:true};},updateQueue:async req=>{const proof=durableInputEvidence(memory,'s');const item=proof.inbox.find(x=>x.id===req.itemId);if(!item)throw Object.assign(Error('already claimed'),{code:'session/queue-item-not-found'});const current=proof.inbox.filter(x=>x.placement===item.placement);memory.push(splice(memory.length,current.findIndex(x=>x.id===item.id),1,[],item.placement));}};
  const backend=createDshInputDeliveryBackend({getServices:()=>services,sessionController:controller,getSession:async()=>({id:'s',cwd:'/work'}),...options});
  return{backend,services,controller,agent,get memory(){return memory;},set memory(value){memory=value;},get stored(){return stored;},get closed(){return closed;},get prompts(){return prompts;},get uploads(){return uploads;},set flushFailure(v){flushFailure=v;},set promptFailure(v){promptFailure=v;},set readFailure(v){readFailure=v;}};
}

test('manual continuation preserves shared prompt, pins original interruption and verifies plan off before native admission',async()=>{
 let switched=0;const h=fixture({ensurePlanModeOff:async()=>{switched++;}});
 h.memory=[{seq:0,type:'turn/start',time:1000,data:{turn:1}},{seq:1,type:'turn/end',time:2000,data:{turn:1,reason:{kind:'interrupted'}}}];
 const row={clientId:'continue',text:CONTINUE_INTERRUPTED,createOpts:{planMode:false}};
 const prepared=await h.backend.prepare('s',row);assert.equal(h.prompts,0);assert.equal(prepared.queued.createOpts.planMode,false);assert.ok(prepared.payload.continuation.tailId.includes('interrupted:0:1000:1'));
 let sent;const original=h.controller.prompt;h.controller.prompt=async req=>{sent=req;return original(req);};
 await h.backend.dispatch({sessionId:'s',clientId:'continue',payload:prepared.payload});
 assert.equal(switched,1);assert.equal(sent.content[0].text,CONTINUE_INTERRUPTED);assert.equal(h.prompts,1);assert.equal((await h.backend.evidence('s')).users.length,0,'admission is not a durable consumed user receipt');
});

test('new native turn or a plan-mode refusal never replays a stale manual continuation',async()=>{
 const h=fixture({ensurePlanModeOff:async()=>{throw Object.assign(Error('off refused'),{code:'PLAN_MODE_UNAVAILABLE'});}});
 h.memory=[{seq:0,type:'turn/start',time:1000,data:{turn:1}},{seq:1,type:'turn/end',time:2000,data:{turn:1,reason:{kind:'interrupted'}}}];
 const row={clientId:'continue',text:CONTINUE_INTERRUPTED,createOpts:{planMode:false}};
 const prepared=await h.backend.prepare('s',row);
 await assert.rejects(h.backend.dispatch({sessionId:'s',clientId:'continue',payload:prepared.payload}),e=>e.code==='PLAN_MODE_UNAVAILABLE'&&e.deliveryNotAdmitted===true);assert.equal(h.prompts,0);
 h.memory.push({seq:2,type:'turn/start',time:3000,data:{turn:2}});
 await assert.rejects(h.backend.dispatch({sessionId:'s',clientId:'continue',payload:prepared.payload}),e=>e.deliverySuperseded===true);assert.equal(h.prompts,0);
 await assert.rejects(h.backend.prepare('s',row),e=>e.code==='CONTINUATION_SUPERSEDED');
});

test('error and interruption manual prompts require their own current native tails, not an arbitrary UI trigger',async()=>{
 const h=fixture();h.memory=[{seq:0,type:'turn/start',time:1000,data:{turn:1}},{seq:1,type:'turn/end',time:2000,data:{turn:1,reason:{kind:'error',error:{message:'failed'}}}}];
 assert.equal((await h.backend.prepare('s',{clientId:'c',text:CONTINUE_ERROR,createOpts:{planMode:false}})).payload.continuation.kind,'error');
 await assert.rejects(h.backend.prepare('s',{clientId:'c',text:CONTINUE_INTERRUPTED,createOpts:{planMode:false}}));
 const normal=await h.backend.prepare('s',{clientId:'other',text:'[UI_ACTION_TRIGGER] some other action'});assert.equal(normal.payload.continuation,undefined);
});

test('raw claim removal is not an accepted receipt; only a persisted user event is',()=>{
 const events=[splice(0,0,0,[message('m','c')]),splice(1,0,1,[])];const gap=durableInputEvidence(events,'s');assert.equal(gap.inbox.length,0);assert.equal(gap.users.length,0);
 events.push({seq:2,type:'user/message',time:3,data:message('m','c')});assert.deepEqual(durableInputEvidence(events,'s').users,[{clientId:'c',seq:2}]);
});
test('corrupt sequence, invalid splice and duplicate inbox occurrences fail closed',()=>{
 for(const events of [[{seq:2,type:'x'}],[splice(0,1,0,[])],[splice(0,0,0,[message('m','a'),message('m','b')])]])assert.throws(()=>durableInputEvidence(events,'s'),e=>e.code==='DELIVERY_EVIDENCE_CORRUPT');
});
test('evidence awaits the real flush then a separate public persistent read handle',async()=>{
 const h=fixture();h.memory=[splice(0,0,0,[message('m','c')])];assert.equal(h.stored.length,0);const proof=await h.backend.evidence('s');assert.equal(h.stored.length,1);assert.equal(proof.inbox[0].clientId,'c');assert.equal(h.closed,1);
});
test('a flush rejection cannot become an accepted receipt or an empty history',async()=>{const h=fixture();h.memory=[{seq:0,type:'user/message',time:1,data:message('m','c')}];h.flushFailure=true;await assert.rejects(h.backend.evidence('s'),/flush rejected/);await assert.rejects(h.backend.readRows('s'),/flush rejected/);});
test('persistent read failures close handles and remain visible',async()=>{const h=fixture();h.readFailure=true;await assert.rejects(h.backend.evidence('s'),/corrupt log/);assert.equal(h.closed,1);});
test('durable preparation captures attachment bytes without ephemeral file receipts or prompt admission',async()=>{
 const h=fixture();const prepared=await h.backend.prepare('s',{clientId:'c',text:'photo',files:[{path:'/photo.png',name:'photo.png',mimeType:'image/png'}]});
 assert.equal(prepared.payload.assets[0].data,Buffer.from('abc').toString('base64'));assert.equal(prepared.payload.assets[0].mediaType,'image/png');assert.equal(h.uploads,0);assert.equal(h.prompts,0);
});
test('durable preparation rejects a missing attachment instead of ACKing just its caption',async()=>{
 const h=fixture();h.services.fileSystem.readByteRange=async()=>{throw Error('denied');};await assert.rejects(h.backend.prepare('s',{clientId:'c',text:'caption',files:[{path:'/missing.png'}]}),e=>e.code==='ATTACHMENT_UNAVAILABLE');assert.equal(h.prompts,0);
});
test('replay uses journal-owned bytes and creates fresh file receipts',async()=>{
 const h=fixture();await h.backend.dispatch({sessionId:'s',clientId:'c',payload:{text:'file',assets:[{name:'a.txt',mediaType:null,data:'YWJj'}]}});assert.equal(h.uploads,1);assert.equal(h.prompts,1);assert.equal(h.stored.length,1);
});
test('post-admission flush failure remains uncertain, never safe-to-repeat',async()=>{
 const h=fixture();h.flushFailure=true;await assert.rejects(h.backend.dispatch({sessionId:'s',clientId:'c',payload:{text:'hello',assets:[]}}),e=>e.message==='flush rejected'&&e.deliveryNotAdmitted!==true);assert.equal(h.memory.length,1);
});
test('only a settled prompt rejection with no live insertion trace grants retry permission',async()=>{
 const h=fixture();h.promptFailure=Error('pre-admission rejection');await assert.rejects(h.backend.dispatch({sessionId:'s',clientId:'c',payload:{text:'hello',assets:[]}}),e=>e.deliveryNotAdmitted===true);
 const q=fixture();q.memory=[splice(0,0,0,[message('m','c')]),splice(1,0,1,[])];q.promptFailure=Error('ambiguous late rejection');await assert.rejects(q.backend.dispatch({sessionId:'s',clientId:'c',payload:{text:'hello',assets:[]}}),e=>e.deliveryNotAdmitted!==true);
});
test('remove durability failure carries an applied-but-unsealed marker',async()=>{
 const h=fixture();h.memory=[splice(0,0,0,[message('m','c')])];await h.backend.evidence('s');h.flushFailure=true;await assert.rejects(h.backend.remove('s','m'),e=>e.deliveryRemovalApplied===true);assert.equal(h.memory.length,2);
});
test('cold recovery refuses foreign or reordered input rather than silently changing FIFO',async()=>{
 const h=fixture();h.memory=[splice(0,0,0,[message('m1','first'),message('m2','foreign')])];assert.equal(await h.backend.recoverColdInbox('s',[{clientId:'first',payload:{text:'a'},ordinal:1,phase:'DSH-pending'}]),false);assert.equal(h.memory.length,1);
});
test('cold owned FIFO removal is durable before re-admission can begin',async()=>{
 const h=fixture();h.memory=[splice(0,0,0,[message('m1','first'),message('m2','second')])];const entries=[{clientId:'first',payload:{text:'a'},ordinal:1,phase:'DSH-pending'},{clientId:'second',payload:{text:'b'},ordinal:2,phase:'DSH-pending'}];assert.equal(await h.backend.recoverColdInbox('s',entries),true);assert.equal(durableInputEvidence(h.stored,'s').inbox.length,0);assert.equal(h.prompts,0);
});
