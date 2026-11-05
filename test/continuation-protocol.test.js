import test from 'node:test';import assert from 'node:assert/strict';
import {ensureNativeContinuationPlanOff} from '../src/continuation-protocol.js';
test('native plan getter must prove committed off, not queued or merely accepted commands',async()=>{
 let active=true;let switched=0;const agent={session:{},ctx:{get:()=>undefined}};
 const controller={get:()=>({active}),set:async(a,value)=>{assert.equal(a,agent);switched++;active=value;return 'committed';}};
 await ensureNativeContinuationPlanOff({agent,controller,getService:()=>undefined});assert.equal(active,false);assert.equal(switched,1);
 await ensureNativeContinuationPlanOff({agent,controller,getService:()=>undefined});assert.equal(switched,1);
 active=true;controller.set=async()=> 'queued';await assert.rejects(ensureNativeContinuationPlanOff({agent,controller,getService:()=>undefined}),e=>e.code==='PLAN_MODE_UNAVAILABLE');
});
test('command-only plan off requires the native projection proof; no human prose inference',async()=>{
 let state={active:true,wanted:null,running:null};let calls=0;const agent={session:{},ctx:{get:()=>undefined}};
 const registry={stateOf:(session,key)=>{assert.equal(session,agent.session);assert.equal(key,'plan');return state;}};
 const commands={find:()=>({name:'plan'}),execute:async(a,text)=>{assert.equal(text,'/plan off');calls++;state={active:false,wanted:null,running:null};return {result:{kind:'success',text:'irrelevant human prose'}};}};
 await ensureNativeContinuationPlanOff({agent,getService:name=>({sessionProjections:registry,commands})[name]});assert.equal(calls,1);
 state={active:true,wanted:null,running:null};commands.execute=async()=>({result:{kind:'success',text:'Plan mode off.'}});
 await assert.rejects(ensureNativeContinuationPlanOff({agent,getService:name=>({sessionProjections:registry,commands})[name]}));
});
test('logged off without the live getter still issues off to cancel a possible private pending entry',async()=>{
 let pending=true;let calls=0;const agent={session:{},ctx:{get:()=>undefined}};
 const services={sessionProjections:{stateOf:()=>({active:false,wanted:null,running:null})},commands:{find:()=>({name:'plan'}),execute:async()=>{calls++;pending=false;return{result:{kind:'success'}};}}};
 await ensureNativeContinuationPlanOff({agent,getService:name=>services[name]});assert.equal(calls,1);assert.equal(pending,false);
});
test('absence is per exact resolved agent composition; an unknown global port is not absence',async()=>{
 const agent={session:{},ctx:{get:()=>undefined}};await ensureNativeContinuationPlanOff({agent,getService:()=>({find:()=>undefined})});
 await assert.rejects(ensureNativeContinuationPlanOff({agent,getService:()=>undefined}),e=>e.code==='PLAN_MODE_UNAVAILABLE');
});
