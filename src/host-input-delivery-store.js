import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const epochKey = Symbol.for('dsh-cindy-host.process-epoch');
export const INPUT_PROCESS_EPOCH = globalThis[epochKey] ??= randomUUID();
export function deliveryError(code, message) { return Object.assign(new Error(message), {code}); }
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if(error.code === 'ESRCH') return false; return true; }
}
/** A private, single-writer FULL-synchronous ledger. No input or tombstone expires implicitly. */
export function openInputDeliveryStore({ file, namespace, epoch=INPUT_PROCESS_EPOCH, pid=process.pid, isAlive=processAlive }) {
  if(!isAbsolute(file) || typeof namespace !== 'string' || !namespace) throw new TypeError('An absolute delivery database path and owner namespace are required');
  mkdirSync(dirname(file), {recursive:true,mode:0o700});
  const db = new DatabaseSync(file);
  const owner = randomUUID();
  let closed=false, inTransaction=false;
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if(version!==0 && version!==1) throw deliveryError('DELIVERY_SCHEMA_UNSUPPORTED','Unsupported input delivery database version');
    db.exec('CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance TEXT NOT NULL, epoch TEXT NOT NULL, pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions (namespace TEXT NOT NULL, session_id TEXT NOT NULL, boundary INTEGER, PRIMARY KEY(namespace,session_id)); CREATE TABLE IF NOT EXISTS inputs (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, session_id TEXT NOT NULL, client_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(namespace,session_id,client_id)); PRAGMA user_version=1;');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous=db.prepare('SELECT * FROM owner WHERE singleton=1').get();
      if(previous && (previous.pid===pid ? previous.epoch===epoch : isAlive(previous.pid))) throw deliveryError('DELIVERY_OWNER_ACTIVE','Another live Host still owns the input delivery database');
      db.prepare('INSERT OR REPLACE INTO owner VALUES (1,?,?,?)').run(owner,epoch,pid);
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
  } catch(error) {db.close();throw error;}
  function guard() {
    if(closed)throw deliveryError('DELIVERY_STORE_CLOSED','Input delivery store is closed');
    if(db.prepare('SELECT instance FROM owner WHERE singleton=1').get()?.instance!==owner)throw deliveryError('DELIVERY_OWNER_LOST','Input delivery writer ownership was replaced');
  }
  function writeGuard(){guard();if(!inTransaction)throw new Error('Delivery mutation requires a transaction');}
  const store={
    epoch,pid,
    transaction(fn){
      guard();if(inTransaction)throw new Error('Nested delivery transaction');
      db.exec('BEGIN IMMEDIATE');inTransaction=true;
      try {guard();const result=fn(store);if(result && typeof result.then==='function')throw new Error('Delivery transactions must be synchronous');db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}finally{inTransaction=false;}
    },
    boundary(sessionId){guard();return db.prepare('SELECT boundary FROM sessions WHERE namespace=? AND session_id=?').get(namespace,sessionId)?.boundary??null;},
    setBoundary(sessionId,boundary){writeGuard();db.prepare('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(namespace,session_id) DO UPDATE SET boundary=excluded.boundary').run(namespace,sessionId,boundary);},
    get(sessionId,clientId){guard();const row=db.prepare('SELECT ordinal,data FROM inputs WHERE namespace=? AND session_id=? AND client_id=?').get(namespace,sessionId,clientId);return row?{...JSON.parse(row.data),ordinal:row.ordinal}:null;},
    list(sessionId){guard();return db.prepare('SELECT ordinal,data FROM inputs WHERE namespace=?'+(sessionId===undefined?'':' AND session_id=?')+' ORDER BY ordinal').all(...(sessionId===undefined?[namespace]:[namespace,sessionId])).map(row=>({...JSON.parse(row.data),ordinal:row.ordinal}));},
    put(entry){
      writeGuard();const {ordinal,...value}=entry;const data=JSON.stringify(value);
      if(Buffer.byteLength(data)>64*1024*1024)throw deliveryError('DELIVERY_TOO_LARGE','Input exceeds the durable storage limit');
      db.prepare('INSERT INTO inputs(namespace,session_id,client_id,data) VALUES (?,?,?,?) ON CONFLICT(namespace,session_id,client_id) DO UPDATE SET data=excluded.data').run(namespace,value.sessionId,value.clientId,data);
    },
    close(){if(closed)return;guard();db.prepare('DELETE FROM owner WHERE singleton=1 AND instance=?').run(owner);db.close();closed=true;},
  };
  return store;
}
