import { createAttachmentMaterializer, hostAttachmentsOf } from './host-attachments.js';
import { foldSessionEvent } from './dsh-message-fold.js';
import { queuedRowFromController } from './host-input-queue.js';
import { deliveryError } from './host-input-delivery-store.js';

/** Replay only a validated persisted prefix. A claim removal is not a user receipt. */
export function durableInputEvidence(events,sessionId) {
  const queues={'next-turn':[],'next-step':[]};const users=[];
  if(!Array.isArray(events))throw deliveryError('DELIVERY_EVIDENCE_UNAVAILABLE','Stored session log has no event array');
  for(let i=0;i<events.length;i++){
    const event=events[i];if(event.seq!==i)throw deliveryError('DELIVERY_EVIDENCE_CORRUPT','Stored session prefix is not contiguous');
    if(event.type==='agent/inbox/spliced'){
      const s=event.data;const previous=queues[s?.target];const count=s?.removedCount??0;
      if(!previous||!Number.isSafeInteger(s.start)||s.start<0||s.start>previous.length||!Number.isSafeInteger(count)||count<0||s.start+count>previous.length||!Array.isArray(s.inserted))throw deliveryError('DELIVERY_EVIDENCE_CORRUPT','Stored inbox splice is invalid');
      const next=[...previous];next.splice(s.start,count,...s.inserted);queues[s.target]=next;
      const ids=[...queues['next-turn'],...queues['next-step']].map(m=>m.id);if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw deliveryError('DELIVERY_EVIDENCE_CORRUPT','Stored inbox identities are invalid');
    }
    const source=event.data?.source;
    if(event.type==='user/message'&&source?.kind==='user'&&typeof source.rpcId==='string'&&source.rpcId)users.push({clientId:source.rpcId,seq:event.seq});
  }
  const inbox=Object.entries(queues).flatMap(([placement,items])=>items.map(message=>({id:message.id,clientId:message.source?.kind==='user'&&typeof message.source.rpcId==='string'?message.source.rpcId:message.id,placement,message,foreign:message.source?.kind!=='user'})));
  return {sessionId,users,inbox,throughSeq:events.length-1};
}
export function createDshInputDeliveryBackend({getServices,sessionController,getSession}){
  let active=true;
  function services(){if(!active)throw deliveryError('DELIVERY_BACKEND_STOPPED','Input delivery service was detached');const s=getServices();if(!s.sessions||typeof s.sessions.flush!=='function'||!s.persistence||typeof s.persistence.open!=='function')throw deliveryError('DELIVERY_NOT_AVAILABLE','Durable DSH session services are not mounted');return s;}
  async function readLog(sid){
    const s=services();const live=s.sessions.get(sid);
    if(live && !await s.sessions.flush(live))throw deliveryError('DELIVERY_DURABILITY_UNAVAILABLE','No session durability listener participated');
    const handle=await s.persistence.open(sid,'read',{signal:AbortSignal.timeout(30000)});
    try{const result=await handle.read(0,Number.MAX_SAFE_INTEGER,{signal:AbortSignal.timeout(30000)});const events=result.events;durableInputEvidence(events,sid);return events;}finally{await handle.close();}
  }
  async function agentFor(sid){const resolved=await sessionController.resolveAgent(sid);if(resolved?.error)throw resolved.error;if(!resolved?.agent)throw deliveryError('DELIVERY_AGENT_UNAVAILABLE','DSH did not resolve an agent');return resolved.agent;}
  async function flush(sid){const s=services();const session=s.sessions.get(sid);if(!session||!await s.sessions.flush(session))throw deliveryError('DELIVERY_DURABILITY_UNAVAILABLE','Cannot verify the DSH mutation durability');}
  const backend={
    available(){try{services();return true;}catch{return false;}},
    stop(){active=false;},
    async readRows(sid){const events=await readLog(sid);const rows=[];for(const event of events){const folded=foldSessionEvent(event,{sessionId:sid});folded.forEach((row,index)=>{const rowid=event.seq*65536+index;if(!Number.isSafeInteger(rowid))throw deliveryError('DELIVERY_EVIDENCE_CORRUPT','Message order exceeds the safe protocol range');rows.push({...row,rowid});});}return rows.reverse();},
    async evidence(sid){const events=await readLog(sid);const proof=durableInputEvidence(events,sid);const agent=getServices().agents?.get(sid);return {...proof,running:agent?.status==='running',live:agent!==undefined};},
    async prepare(sid,row,{resolveAttachmentRef,mode='queue'}={}){
      services();const session=await getSession(sid);if(!session)throw deliveryError('NOT_FOUND','Session does not exist');
      const incoming=hostAttachmentsOf(row);if(Array.isArray(row.files)&&incoming.length!==row.files.length)throw deliveryError('ATTACHMENT_UNAVAILABLE','Every submitted attachment must be persistently obtainable');
      const text=typeof row.text==='string'?row.text:'';if(!text.trim()&&!incoming.length)throw deliveryError('BAD_REQUEST','Input has no text or attachment');
      const materializer=createAttachmentMaterializer({fileSystem:getServices().fileSystem,resolveAttachmentRef,captureOnly:true});
      const owned=await materializer.materialize({attachments:incoming,signal:AbortSignal.timeout(30000)});
      if(owned.dropped.length)throw deliveryError('ATTACHMENT_UNAVAILABLE','Cannot durably receive all attachments: '+owned.dropped.map(x=>x.reason).join(', '));
      const queued=queuedRowFromController({clientId:row.clientId,text,session});if(!queued)throw deliveryError('DELIVERY_SESSION_UNAVAILABLE','Session working directory is unavailable');
      return {payload:{text,assets:owned.parts,consumed:owned.consumed,mode},queued:{...queued,files:incoming,chatMessage:{...queued.chatMessage,...(row.chatMessage?.images?{images:row.chatMessage.images}:{})}}};
    },
    async dispatch(entry,{releaseAttachmentRef}={}){
      let agent;
      try{agent=await agentFor(entry.sessionId);}catch(error){error.deliveryNotAdmitted=true;throw error;}
      const content=entry.payload.text?[{type:'text',text:entry.payload.text}]:[];
      for(const asset of entry.payload.assets??[]){
        if(asset.mediaType)content.push({type:'image',mediaType:asset.mediaType,data:asset.data,name:asset.name});
        else {try{const uploads=getServices().fileUploads;if(typeof uploads?.upload!=='function')throw deliveryError('ATTACHMENT_UNAVAILABLE','File upload service is unavailable');const uploaded=await uploads.upload(agent,{data:asset.data,name:asset.name},AbortSignal.timeout(30000));if(!uploaded?.receiptId)throw deliveryError('ATTACHMENT_UNAVAILABLE','No file receipt was created');content.push({type:'file',receiptId:uploaded.receiptId});}catch(error){error.deliveryNotAdmitted=true;throw error;}}
      }
      // Do not interpret an aborted signal as proof that admission did not happen.
      const mode=entry.payload.mode==='steer'&&agent.status==='running'?'steer':'queue';
      try{await sessionController.prompt({sessionId:entry.sessionId,requestId:entry.clientId,mode,content},AbortSignal.timeout(30000));}
      catch(error){
        const trace=agent.session.snapshotEvents().some(event=>event.type==='user/message'&&event.data?.source?.rpcId===entry.clientId || event.type==='agent/inbox/spliced'&&event.data?.inserted?.some(message=>message.source?.rpcId===entry.clientId));
        if(!trace){error.deliveryNotAdmitted=true;if(mode==='steer')error.deliveryRetryMode='queue';}
        throw error;
      }
      await flush(entry.sessionId);await readLog(entry.sessionId);
      for(const key of entry.payload.consumed??[])if(typeof releaseAttachmentRef==='function')void releaseAttachmentRef(key).catch(()=>{});
    },
    async promote(sid,itemId){await sessionController.updateQueue({sessionId:sid,itemId,action:{kind:'steer'}});await flush(sid);await readLog(sid);},
    async remove(sid,itemId){
      await sessionController.updateQueue({sessionId:sid,itemId,action:{kind:'remove'}});
      try{await flush(sid);await readLog(sid);}catch(error){error.deliveryRemovalApplied=true;throw error;}
    },
    async recoverColdInbox(sid,entries){
      const initial=await backend.evidence(sid);if(initial.running||initial.inbox.some(item=>item.foreign))return false;
      const owned=new Map(entries.filter(e=>e.payload&&e.phase!=='accepted'&&e.phase!=='removed').map(e=>[e.clientId,e]));
      if(initial.inbox.some(item=>!owned.has(item.clientId)))return false;
      const order=initial.inbox.map(x=>owned.get(x.clientId).ordinal);if(order.some((n,i)=>i>0&&n<order[i-1]))return false;
      const agent=await agentFor(sid);if(agent.status==='running')return false;
      // A public remove+durable checkpoint before re-admission is the only verified wake compensation.
      for(const item of initial.inbox){if(agent.status==='running')throw deliveryError('DELIVERY_RECOVERY_WAITING','Agent became active during cold queue recovery');await backend.remove(sid,item.id);}
      const after=await backend.evidence(sid);return !after.running&&!after.inbox.length;
    },
  };
  return backend;
}
