import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { startHost } from '../src/host.js';
import { FixtureDshSource } from '../src/fixture-source.js';
const tick=()=>new Promise(setImmediate);
const message=text=>({id:'native-id',source:{kind:'user',rpcId:'desktop-id'},content:[{type:'text',text}]});
const inbox=text=>({'next-turn':text?[message(text)]:[],'next-step':[]});
async function harness(t){
 const directory=mkdtempSync(join(tmpdir(),'native-control-'));const sent=[],handlers=new Map();let id=0,state={inbox:inbox()};
 const socket={readyState:1,on:(name,fn)=>handlers.set(name,fn),close(){},send:text=>sent.push(JSON.parse(text))};
 const source=new FixtureDshSource();source.sessions=[{id:'s',cwd:'/work',running:true,title:'test'}];
 const runtime=await startHost(source,{transportEnabled:true,remoteControlEnabled:true,controllers:{}},{
  inputDeliveryDirectory:directory,inputDeliveryNamespace:'native-control-test',
  resolveSession:async()=>({ok:true,session:{deviceId:'host',accessToken:'fixture'}}),openSocket:()=>socket,heartbeatMs:0,listDevices:async()=>({devices:[]}),
  resolveCapabilities:()=>({readSessionState:readState,inputDeliveryBackend:{available:()=>true,evidence:async()=>({users:[],inbox:[],running:true})}}),
 });
 async function readState(){return state;}
 t.after(async()=>{await runtime.stop();const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep+'native-control-'));rmSync(target,{recursive:true,force:true});});
 const frame=f=>handlers.get('message')(Buffer.from(JSON.stringify({v:1,...f})));
 handlers.get('open')();frame({kind:'hello-ack',payload:{serverProtocolVersion:1,deviceId:'host',userId:'owner'}});
 async function invoke(channel,args=[]){const requestId='r'+id++;frame({kind:'invoke',id:requestId,src:'phone',payload:{channel,args}});for(let i=0;i<8;i++)await tick();const response=sent.find(x=>x.kind==='invoke-result'&&x.id===requestId);assert.ok(response,'RPC answered');assert.equal(response.payload.ok,true,JSON.stringify(response.payload));return response.payload.result;}
 await invoke('local-db:sessions:list');await invoke('device-link:subscribe',[{topics:['session:s']}]);sent.length=0;
 return{runtime,sent,invoke,setInbox:value=>{state={inbox:value};},latest:channel=>sent.filter(x=>x.kind==='push'&&x.payload.channel===channel).at(-1)?.payload.payload};
}
test('actual Host publishes modern baseline, queue edits and removal with zero assistant output',async t=>{
 const h=await harness(t);
 h.runtime.applyControlFrame({type:'baseline',value:{projections:{s:{asOfSeq:1,values:{inbox:inbox('first')}}}}});
 assert.equal(h.latest('maker:input:projection')?.pendingQueue[0]?.text,'first');
 h.runtime.applyControlFrame({type:'projection',sessionId:'s',seq:2,changes:[{key:'inbox',val:inbox('edited')}]});
 assert.equal(h.latest('maker:input:projection')?.pendingQueue[0]?.text,'edited');
 h.runtime.applyControlFrame({type:'projection',sessionId:'s',seq:3,changes:[{key:'inbox',val:inbox()}]});
 assert.deepEqual(h.latest('maker:input:projection')?.pendingQueue,[]);
 h.runtime.applyControlFrame({type:'projection',sessionId:'s',seq:4,changes:[{key:'goal',val:{goal:{id:'g',phase:'active',objective:'work'}}}]});
 assert.equal(h.latest('maker:goal:status-changed')?.goal?.status,'active');
 assert.equal(h.sent.some(x=>x.kind==='push'&&['maker:event','local-db:messages:created'].includes(x.payload.channel)),false);
});
test('actual SQLite delivery-enabled get-projection imports external native pending input without inventing acceptance',async t=>{
 const h=await harness(t);h.setInbox(inbox('desktop only'));
 const projection=await h.invoke('maker:input:get-projection',['s',{deliveryClientIds:['desktop-id']}]);
 assert.equal(projection.inputDeliveryVersion,1);
 assert.equal(projection.pendingQueue[0]?.text,'desktop only');
 assert.equal(projection.deliveryReceipts[0]?.state,'unknown');
 assert.equal(h.sent.some(x=>x.kind==='push'&&x.payload.channel==='local-db:messages:created'),false);
});
test('native inbox event repair publishes new pending state before any assistant body',async t=>{
 const h=await harness(t);h.setInbox(inbox('event wake'));
 assert.equal(await h.runtime.refreshInputProjection('s',true),true);
 assert.equal(h.latest('maker:input:projection')?.pendingQueue[0]?.text,'event wake');
 h.setInbox(inbox());await h.runtime.refreshInputProjection('s',true);
 assert.deepEqual(h.latest('maker:input:projection')?.pendingQueue,[]);
});
