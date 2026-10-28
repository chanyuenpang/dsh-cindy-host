import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openInputDeliveryStore} from '../src/host-input-delivery-store.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'cindy-delivery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'delivery.sqlite');}
test('committed input, payload and terminal cancellation survive a real reopen',t=>{
  const file=fixture(t);let s=openInputDeliveryStore({file,namespace:'owner'});
  s.transaction(()=>{s.put({sessionId:'s',clientId:'c',phase:'stored',payload:{text:'真实输入'}});s.setBoundary('s',123);});s.close();
  s=openInputDeliveryStore({file,namespace:'owner'});assert.equal(s.get('s','c').payload.text,'真实输入');assert.equal(s.boundary('s'),123);
  s.transaction(()=>s.put({...s.get('s','c'),phase:'removed'}));s.close();s=openInputDeliveryStore({file,namespace:'owner'});assert.equal(s.get('s','c').phase,'removed');s.close();
});
test('rollback never exposes a partially updated boundary or ownership receipt',t=>{
  const s=openInputDeliveryStore({file:fixture(t),namespace:'owner'});assert.throws(()=>s.transaction(()=>{s.put({sessionId:'s',clientId:'c',phase:'stored'});s.setBoundary('s',99);throw Error('disk boundary injection');}));assert.equal(s.get('s','c'),null);assert.equal(s.boundary('s'),null);s.close();
});
test('same process cannot acquire a second writer, but graceful handoff works',t=>{
  const file=fixture(t);const s=openInputDeliveryStore({file,namespace:'owner'});assert.throws(()=>openInputDeliveryStore({file,namespace:'owner'}),e=>e.code==='DELIVERY_OWNER_ACTIVE');s.close();const next=openInputDeliveryStore({file,namespace:'owner'});next.close();
});
test('dead process lease can be recovered, live foreign PID cannot',t=>{
  const file=fixture(t);let s=openInputDeliveryStore({file,namespace:'owner'});s.close();const raw=new DatabaseSync(file);raw.prepare('INSERT INTO owner VALUES(1,?,?,?)').run('old','old-epoch',12345);raw.close();
  assert.throws(()=>openInputDeliveryStore({file,namespace:'owner',isAlive:()=>true}),e=>e.code==='DELIVERY_OWNER_ACTIVE');s=openInputDeliveryStore({file,namespace:'owner',isAlive:()=>false});s.close();
});
test('account namespaces do not leak receipts even in the same database',t=>{
  const file=fixture(t);let s=openInputDeliveryStore({file,namespace:'account-A'});s.transaction(()=>s.put({sessionId:'s',clientId:'c',phase:'accepted'}));s.close();s=openInputDeliveryStore({file,namespace:'account-B'});assert.equal(s.get('s','c'),null);assert.equal(s.list().length,0);s.close();
});
test('mutations outside a transaction are refused',t=>{const s=openInputDeliveryStore({file:fixture(t),namespace:'owner'});assert.throws(()=>s.put({sessionId:'s',clientId:'c'}));s.close();});
