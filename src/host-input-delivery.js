import { createHash } from 'node:crypto';
import { deliveryError } from './host-input-delivery-store.js';
const terminal = phase => phase==='accepted' || phase==='removed';
function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  return value;
}
export function inputFingerprint(value){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
export function deliveryClientIds(options) {
  if(!options || typeof options!=='object' || !('deliveryClientIds' in options))return [];
  const ids=options.deliveryClientIds;
  if(!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string'||!id||id.length>256))throw deliveryError('INVALID_PARAMS','deliveryClientIds must contain at most 64 nonempty IDs (256 characters each)');
  return [...new Set(ids)];
}
function identity(sessionId,clientId){if(typeof sessionId!=='string'||!sessionId||typeof clientId!=='string'||!clientId||clientId.length>256)throw deliveryError('INVALID_PARAMS','A sessionId and clientId of at most 256 characters are required');}
function requestShape(row){return Object.fromEntries(['text','persistedContent','files','agentReferences','sessionRefs','origin','sourcePlugin','createOpts'].filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));}
/** One owner for durable handoff, session command serialization, and permission to retry admission. */
export function createInputDeliveryCoordinator({store,backend,baseProjection=()=>({pendingQueue:[],steeringQueueClientIds:[]}),onChange=()=>{},onError=()=>{},validateProjection=()=>true,now=()=>Date.now()}){
  const lanes=new Map(), scheduled=new Set(), runningBySession=new Map();let stopped=false;
  function notify(sid){queueMicrotask(()=>Promise.resolve().then(()=>onChange(sid)).catch(onError));}
  function lane(sid,fn){const previous=lanes.get(sid)??Promise.resolve();const result=previous.catch(()=>{}).then(fn);const tail=result.catch(()=>{}).finally(()=>{if(lanes.get(sid)===tail)lanes.delete(sid);});lanes.set(sid,tail);return result;}
  function save(entry){store.transaction(()=>store.put(entry));}
  function view(sid,ids=[],override){
    const base={...baseProjection(sid),...override};
    const entries=store.list(sid);const owned=new Map(entries.map(e=>[e.clientId,e]));
    const isSteering=e=>e.phase==='DSH-pending'&&e.placement==='next-step';
    const pending=(base.pendingQueue??[]).filter(row=>{const e=owned.get(row.clientId);return !e||(!terminal(e.phase)&&e.phase!=='claimed'&&!isSteering(e));});
    const steering=new Set((base.steeringQueueClientIds??[]).filter(cid=>{const e=owned.get(cid);return !e||isSteering(e);}));
    // Admission into DSH is not consumption: keep the real pending occurrence visible
    // even before the independent control-stream mirror catches up.
    for(const e of entries){
      if(isSteering(e)){steering.add(e.clientId);continue;}
      if((e.phase==='stored'||e.phase==='DSH-pending')&&e.queued){const at=pending.findIndex(p=>p.clientId===e.clientId);if(at<0)pending.push(e.queued);else pending[at]=e.queued;}
    }
    const running=runningBySession.get(sid)??base.turnInProgress;
    return {...base,...(typeof running==='boolean'?{turnInProgress:running}:{}),sessionId:sid,pendingQueue:pending,steeringQueueClientIds:[...steering],inputDeliveryVersion:1,clearBoundaryMs:store.boundary(sid),deliveryReceipts:ids.map(clientId=>{const e=store.get(sid,clientId);return{clientId,state:e?e.phase==='removed'?'removed':e.phase==='accepted'?'accepted':e.payload===undefined?'unknown':'pending':'unknown'};})};
  }
  async function evidence(sid){
    const proof=await backend.evidence(sid);
    if(!proof || !Array.isArray(proof.users) || !Array.isArray(proof.inbox))throw deliveryError('DELIVERY_EVIDENCE_UNAVAILABLE','Durable DSH evidence is unavailable');
    let changed=false;const held=new Map(proof.inbox.map(item=>[item.clientId,item]));
    store.transaction(()=>{
      for(const user of proof.users){const e=store.get(sid,user.clientId);if(e?.phase==='removed')throw deliveryError('DELIVERY_CANCEL_CONFLICT','A sealed cancellation has a durable user message');if(e&&e.phase!=='accepted'){store.put({...e,phase:'accepted',payload:null,userSeq:user.seq,error:null});changed=true;}}
      for(const e of store.list(sid)){
        if(terminal(e.phase)||e.phase==='stored')continue;
        const item=held.get(e.clientId);
        if(item){const placement=item.placement??'next-turn';if(e.phase!=='DSH-pending'||e.placement!==placement){store.put({...e,phase:'DSH-pending',placement});changed=true;}}
        else if(e.phase==='DSH-pending'){store.put({...e,phase:'claimed',placement:null});changed=true;}
      }
    });
    if(typeof proof.running==='boolean'){if(runningBySession.get(sid)!==proof.running)changed=true;runningBySession.set(sid,proof.running);}
    if(changed)notify(sid);
    return proof;
  }
  async function runSession(sid){
    if(stopped)return;
    let proof=await evidence(sid);
    for(let current of store.list(sid)){
      if(stopped)return;
      current=store.get(sid,current.clientId);
      if(terminal(current.phase))continue;
      if(current.cancelRequested){await cancelNow(sid,current.clientId,proof);proof=await evidence(sid);continue;}
      if(current.phase!=='stored'){
        if(current.attemptEpoch===store.epoch)continue; // A live-process claim/admission may still settle.
        const held=proof.inbox.find(item=>item.clientId===current.clientId);
        if(held){
          if(typeof backend.recoverColdInbox!=='function'||!await backend.recoverColdInbox(sid,store.list(sid))) {save({...current,error:'DELIVERY_RECOVERY_WAITING'});continue;}
          proof=await evidence(sid);
          if(!proof.running && !proof.inbox.length)store.transaction(()=>{for(const e of store.list(sid))if(!terminal(e.phase)&&e.attemptEpoch!==store.epoch&&!e.cancelRequested)store.put({...e,phase:'stored',error:null});});
          if(proof.inbox.some(item=>item.clientId===current.clientId))throw deliveryError('DELIVERY_RECOVERY_WAITING','Cold inbox occurrence is still owned by DSH');
        }
        if(proof.running){save({...current,error:'DELIVERY_RECOVERY_WAITING'});continue;}
        current=store.get(sid,current.clientId);
        if(terminal(current.phase))continue;
        save({...current,phase:'stored',error:null});
      }
      current=store.get(sid,current.clientId);
      if(stopped || current.cancelRequested || current.phase!=='stored')continue;
      if((current.nextAttemptAt??0)>now())break;
      const attempted={...current,phase:'dispatching',attemptEpoch:store.epoch,attemptPid:store.pid,attemptNo:(current.attemptNo??0)+1,error:null};save(attempted);
      try {
        await backend.dispatch(attempted);
        proof=await evidence(sid);
        const settled=store.get(sid,current.clientId);
        if(!terminal(settled.phase))save({...settled,phase:proof.inbox.some(item=>item.clientId===current.clientId)?'DSH-pending':'claimed',error:null});
      }catch(error){const e=store.get(sid,current.clientId);if(!terminal(e.phase))save({...e,...(error.deliveryNotAdmitted?{phase:'stored',...(error.deliveryRetryMode?{payload:{...e.payload,mode:error.deliveryRetryMode}}:{}),nextAttemptAt:now()+Math.min(30000,1000*2**Math.min(e.attemptNo??1,5))}:{}),error:String(error?.code??'DELIVERY_ADMISSION_UNCERTAIN')});onError(error);if(error.deliveryNotAdmitted){notify(sid);break;}}
      notify(sid);
    }
  }
  function schedule(sid){if(stopped||scheduled.has(sid))return;scheduled.add(sid);setImmediate(()=>{scheduled.delete(sid);if(!stopped)void lane(sid,()=>runSession(sid)).catch(onError);});}
  async function cancelNow(sid,cid,initial){
    let e=store.get(sid,cid);if(e.phase==='removed')return true;
    const proof=initial??await evidence(sid);e=store.get(sid,cid);
    if(e.phase==='accepted'||proof.users.some(u=>u.clientId===cid))return false;
    const held=proof.inbox.find(item=>item.clientId===cid);
    if(held){if(e.payload===undefined)throw deliveryError('NOT_AVAILABLE','A foreign DSH input cannot be sealed by this delivery owner');try{await backend.remove(sid,held.id);}catch(error){if(error.deliveryRemovalApplied)save({...store.get(sid,cid),removalApplied:true});throw error;}const after=await evidence(sid);e=store.get(sid,cid);if(e.phase==='accepted'||after.users.some(u=>u.clientId===cid))return false;if(after.inbox.some(item=>item.clientId===cid))throw deliveryError('DELIVERY_CANCEL_UNCERTAIN','Input is still in the durable inbox');}
    else if(e.phase!=='stored' && !e.removalApplied && e.attemptEpoch===store.epoch)return false; // Claimed or admission still capable of arriving.
    else if(e.phase!=='stored' && proof.running)throw deliveryError('DELIVERY_CANCEL_UNCERTAIN','Cannot seal a potentially live input');
    save({...store.get(sid,cid),phase:'removed',payload:null,cancelRequested:false,error:null});notify(sid);return true;
  }
  const api={
    currentProjection:(sid,ids=[],base)=>view(sid,ids,base),
    owns:(sid,cid)=>store.get(sid,cid)!==null,
    async accept(sid,row,options={}){
      identity(sid,row?.clientId);if(stopped)throw deliveryError('DELIVERY_STOPPED','Input delivery is stopping');
      return lane(sid,async()=>{
        if(stopped)throw deliveryError('DELIVERY_STOPPED','Input delivery is stopping');
        let e=store.get(sid,row.clientId);const raw=inputFingerprint(requestShape(row));
        if(e?.phase==='removed')return view(sid,[row.clientId]);
        if(e && e.rawFingerprint===raw){schedule(sid);return view(sid,[row.clientId]);}
        const hasBoundary=Object.hasOwn(options,'expectedClearBoundaryMs');
        if(row.durableDelivery===true && !hasBoundary)throw deliveryError('INVALID_PARAMS','Durable input requires expectedClearBoundaryMs, including explicit null');
        const expectedBoundary=hasBoundary?options.expectedClearBoundaryMs:store.boundary(sid);
        if(!e && expectedBoundary!==store.boundary(sid))throw deliveryError('REMOTE_OPTIMISTIC_INPUT_CLEARED','REMOTE_OPTIMISTIC_INPUT_CLEARED: input clear boundary changed');
        const prepared=await backend.prepare(sid,row,options);
        if(!prepared || prepared.payload===undefined || !prepared.queued)throw deliveryError('DELIVERY_PREPARATION_FAILED','Host did not obtain complete replayable input');
        const {consumed: _transit,mode: _mode,...semanticPayload}=prepared.payload;const fingerprint=inputFingerprint(semanticPayload);e=store.get(sid,row.clientId);
        if(e){if(e.phase==='removed')return view(sid,[row.clientId]);if(e.fingerprint!==fingerprint)throw deliveryError('INPUT_DELIVERY_CONFLICT','clientId already belongs to a different input');return view(sid,[row.clientId]);}
        if(expectedBoundary!==store.boundary(sid))throw deliveryError('REMOTE_OPTIMISTIC_INPUT_CLEARED','REMOTE_OPTIMISTIC_INPUT_CLEARED: input was cleared during preparation');
        const preview=view(sid,[row.clientId]);preview.pendingQueue=[...preview.pendingQueue,prepared.queued];preview.deliveryReceipts=[{clientId:row.clientId,state:'pending'}];
        if(!validateProjection(preview))throw deliveryError('DELIVERY_TOO_LARGE','Input queue projection cannot fit the negotiated transport budget');
        save({sessionId:sid,clientId:row.clientId,phase:'stored',request:requestShape(row),rawFingerprint:raw,fingerprint,payload:prepared.payload,queued:prepared.queued,clearBoundaryMs:store.boundary(sid),sendAtMs:options.sendAtMs??null,createdAt:now(),attemptNo:0,cancelRequested:false});
        notify(sid);schedule(sid);return view(sid,[row.clientId]);
      });
    },
    async edit(sid,cid,value){
      identity(sid,cid);
      return lane(sid,async()=>{
        let entry=store.get(sid,cid);if(!entry?.payload||terminal(entry.phase)||entry.cancelRequested)throw deliveryError('NOT_FOUND','Input is no longer editable');
        const text=typeof value==='string'?value:value?.text;if(typeof text!=='string'||!text.trim())throw deliveryError('INVALID_PARAMS','Edited input needs text');
        const candidate={...entry.queued,...(typeof value==='object'?value:{}),clientId:cid,text,files:typeof value==='object'&&Array.isArray(value.files)?value.files:entry.queued.files};
        const filesChanged=inputFingerprint(candidate.files??[])!==inputFingerprint(entry.queued.files??[]);
        const prepared=filesChanged?await backend.prepare(sid,candidate,{}):{payload:{...entry.payload,text,mode:'queue'},queued:{...entry.queued,text,persistedContent:typeof value==='object'&&typeof value.persistedContent==='string'?value.persistedContent:text,chatMessage:{...entry.queued.chatMessage,content:text}}};
        entry=store.get(sid,cid);if(entry.cancelRequested||entry.clearBoundaryMs!==store.boundary(sid))throw deliveryError('REMOTE_OPTIMISTIC_INPUT_CLEARED','Input changed ownership during edit');
        const proof=await evidence(sid);const held=proof.inbox.find(item=>item.clientId===cid);
        if(held){if(held.placement==='next-step')throw deliveryError('NOT_AVAILABLE','An active steering input cannot be edited');await backend.remove(sid,held.id);const after=await evidence(sid);if(after.users.some(u=>u.clientId===cid)||after.inbox.some(item=>item.clientId===cid))throw deliveryError('DELIVERY_EDIT_UNCERTAIN','Input changed while editing');}
        else if(entry.phase!=='stored')throw deliveryError('NOT_FOUND','Input was already claimed');
        entry=store.get(sid,cid);if(terminal(entry.phase)||entry.cancelRequested)throw deliveryError('NOT_FOUND','Input changed while editing');
        const {consumed,mode,...semantic}=prepared.payload;save({...entry,phase:'stored',request:requestShape(candidate),rawFingerprint:inputFingerprint(requestShape(candidate)),fingerprint:inputFingerprint(semantic),payload:prepared.payload,queued:prepared.queued,nextAttemptAt:0,error:null});
        notify(sid);schedule(sid);return view(sid,[cid]);
      });
    },
    async steer(sid,row,options={}){
      identity(sid,row?.clientId);
      const promoted=await lane(sid,async()=>{
        const proof=await evidence(sid);const held=proof.inbox.find(x=>x.clientId===row.clientId);const entry=store.get(sid,row.clientId);
        if(held){if(!entry?.payload)throw deliveryError('NOT_AVAILABLE','This input has no Host-owned replay payload for safe promotion');await backend.promote(sid,held.id);await evidence(sid);notify(sid);return true;}
        if(entry)return entry.phase==='removed'?false:true;
        return null;
      });
      if(promoted!==null)return promoted;
      await api.accept(sid,row,{...options,mode:'steer'});return true;
    },
    async projection(sid,options){
      if(typeof sid!=='string'||!sid)throw deliveryError('INVALID_PARAMS','sessionId is required');const ids=deliveryClientIds(options);
      const proof=await evidence(sid);
      // Actual durable user history is authoritative even for an input not submitted through this instance.
      store.transaction(()=>{for(const cid of ids)if(!store.get(sid,cid)&&proof.users.some(u=>u.clientId===cid))store.put({sessionId:sid,clientId:cid,phase:'accepted',userSeq:proof.users.find(u=>u.clientId===cid).seq});});
      schedule(sid);return view(sid,ids);
    },
    async cancel(sid,cid){
      identity(sid,cid);if(stopped)throw deliveryError('DELIVERY_STOPPED','Input delivery is stopping');
      // Persist intent now, including cancel-before-enqueue, even while another admission awaits.
      store.transaction(()=>{const e=store.get(sid,cid);if(!e)store.put({sessionId:sid,clientId:cid,phase:'stored',cancelRequested:true,createdAt:now()});else if(!terminal(e.phase))store.put({...e,cancelRequested:true});});
      return lane(sid,async()=>{const cancelled=await cancelNow(sid,cid);return {...view(sid,[cid]),inputDeliveryCancelled:cancelled};});
    },
    async clear(sid){
      if(stopped)throw deliveryError('DELIVERY_STOPPED','Input delivery is stopping');
      store.transaction(()=>{const previous=store.boundary(sid);store.setBoundary(sid,Math.max(now(),previous===null?0:previous+1));for(const e of store.list(sid))if(!terminal(e.phase))store.put({...e,cancelRequested:true});});
      return lane(sid,async()=>{const proof=await evidence(sid);store.transaction(()=>{for(const item of proof.inbox)if(!store.get(sid,item.clientId))store.put({sessionId:sid,clientId:item.clientId,phase:'stored',cancelRequested:true,createdAt:now()});});for(const e of store.list(sid))if(e.cancelRequested)await cancelNow(sid,e.clientId);notify(sid);return view(sid);});
    },
    async drain(){while(scheduled.size||lanes.size){await new Promise(resolve=>setImmediate(resolve));await Promise.all([...lanes.values()]);}},
    recover(){for(const sid of new Set(store.list().filter(e=>!terminal(e.phase)).map(e=>e.sessionId)))schedule(sid);},
    diagnostics(){return store.list().filter(e=>!terminal(e.phase)).map(e=>({sessionId:e.sessionId,clientId:e.clientId,phase:e.phase,error:e.error??null}));},
    async close(){stopped=true;await Promise.all([...lanes.values()]);store.close();},
  };
  return api;
}
