import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticPreferenceStore, nativeInterruption, interruptionFields, EMPTY_INTERRUPTION, diagnosticOwner, preferenceHas, projectDismissedErrors } from '../src/diagnostic-presentation.js';
import { diagnosticSettings } from './support/diagnostic-settings.js';
const start={type:'turn/start',seq:1,time:2000,data:{turn:2}};
const end={type:'turn/end',seq:5,time:3000,data:{turn:2,reason:{kind:'interrupted'}}};
test('native pending tuple shares original turn/start identity across synthetic and persisted endings',()=>{
 const candidate=nativeInterruption('s',start,end,1000);
 assert.equal(candidate.id,nativeInterruption('s',start,{...end,seq:8},1000).id);
 assert.deepEqual(interruptionFields(candidate,false,false,{},'owner','s'),{activeTurnStartedAt:2000,interruptedTurnStartedAt:2000,lastTurnEndedAt:1000,clearedAt:null});
 assert.deepEqual(interruptionFields(candidate,true,false,{},'owner','s'),EMPTY_INTERRUPTION);
 assert.deepEqual(interruptionFields(candidate,false,true,{},'owner','s'),EMPTY_INTERRUPTION);
 assert.equal(nativeInterruption('s',start,{...end,data:{turn:3,reason:{kind:'interrupted'}}},null),null);
 assert.equal(nativeInterruption('s',start,end,2000),null,'do not invent timestamps for an inexpressible native tuple');
});
test('revisioned leaf confirmations survive a store recreation, remain scoped, and do not mutate messages',async()=>{
 const {settings,state,preferences}=diagnosticSettings(); const owner=diagnosticOwner('realm|account|host','profile');
 const candidate=nativeInterruption('s',start,end,null);
 await preferences.commit({owner,sessionId:'s',kind:'interruptions',id:candidate.id});
 assert.deepEqual(interruptionFields(candidate,false,false,preferences.snapshot(),owner,'s'),EMPTY_INTERRUPTION);
 const before=state.writes;await preferences.commit({owner,sessionId:'s',kind:'interruptions',id:candidate.id});assert.equal(state.writes,before);
 assert.equal(preferenceHas(preferences.snapshot(),diagnosticOwner('other'),'s','interruptions',candidate.id),false);
 assert.equal(preferenceHas(preferences.snapshot(),owner,'other','interruptions',candidate.id),false);
 const message={id:'s:turn-error:5',clientId:'s:turn-error:5',sessionId:'s',role:'error',content:{message:'failure'}};
 await preferences.commit({owner,sessionId:'s',kind:'errors',id:message.clientId});
 assert.equal(projectDismissedErrors([message],preferences.snapshot(),owner)[0].content.dismissed,true);
 assert.equal(message.content.dismissed,undefined);assert.deepEqual(settings.describe()[0].value,state.value);
 const restarted=diagnosticPreferenceStore(settings,'test');assert.equal(preferenceHas(restarted.snapshot(),owner,'s','interruptions',candidate.id),true);
});
test('conflicts retry from fresh revisions; persistence and expired scopes never return fake success',async()=>{
 const {state,preferences}=diagnosticSettings();const edit={owner:diagnosticOwner('owner'),sessionId:'s',kind:'errors',id:'error'};
 state.conflicts=1;await preferences.commit(edit);assert.equal(state.writes,2);
 state.fail=true;await assert.rejects(preferences.commit({...edit,id:'second'}),/disk write failed/);
 assert.equal(preferenceHas(preferences.snapshot(),edit.owner,'s','errors','second'),false);
 await assert.rejects(preferences.commit({...edit,id:'third'},()=>false));
});
