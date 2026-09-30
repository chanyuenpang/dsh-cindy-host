// Deterministic work-count comparison, not a live/phone latency benchmark.
// Run before deployment with the installed package root as argv[2], or against
// any complete baseline package tree. No real services, sessions or disk logs.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readActiveSessionSummaries } from '../src/dsh-active-sessions.js';

async function probe(root) {
  const { createSessionControllerSource } = await import(pathToFileURL(path.join(root, 'src/dsh-session-source.js')));
  const { createMessageReader } = await import(pathToFileURL(path.join(root, 'src/dsh-message-fold.js')));
  let activeCorpusReads = 0;
  let metadataCorpusReads = 0;
  let transcriptSeeds = 0;
  const at = 1700000000000;
  const session = { header: { id: 'task', cwd: 'G:/fixture', createdAt: at }, seq: 2 };
  const agent = { id: 'task', session, status: 'running' };
  const services = {
    agents: { list: () => [agent], get: () => agent }, sessions: { get: () => session },
    sessionProjections: { snapshot: () => ({ values: { sessionListMetadata: { blank: false } } }) },
  };
  const summary = { sessionId: 'task', running: true, blank: false, createdAt: at, updatedAt: at, cwd: 'G:/fixture' };
  const source = createSessionControllerSource({
    sessionController: { list: async () => { activeCorpusReads++; return { items: [summary] }; } },
    readActiveSessions: () => readActiveSessionSummaries({ get: name => services[name] }),
    readSessionSummary: async () => summary,
    readSessionMeta: async () => { metadataCorpusReads++; return new Map([['task', { createdAt: new Date(at).toISOString(), cwd: summary.cwd }]]); },
  });
  for (let index = 0; index < 5; index++) await source.listSessionStates();
  await Promise.all([source.getSession('task'), source.getSession('task')]);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const reader = createMessageReader({ readSessionLog: async () => { transcriptSeeds++; await barrier; return { events: [] }; } });
  const pending = Promise.all([reader.count('task'), reader.all('task'), reader('task')]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await pending;
  return { activePolls: 5, activeCorpusReads, concurrentExactGets: 2, metadataCorpusReads, concurrentTranscriptSurfaces: 3, transcriptSeeds };
}
const current = path.resolve(import.meta.dirname, '..');
const baseline = process.argv[2];
if (!baseline) throw new Error('Provide a complete baseline package root (read-only).');
console.log(JSON.stringify({ kind: 'injected-fixture-operation-counts', baseline: await probe(path.resolve(baseline)), optimized: await probe(current) }, null, 2));
