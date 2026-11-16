import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { toCindyMessageRows } from './cindy-message-row.js';
import { appendReadonlyRows } from './readonly-row-suffix.js';

const require = createRequire(import.meta.url);
let decoder;
function expand(stream) {
  // The Host owns this dependency; never install another DSH generation in the bundle.
  decoder ??= require('@deepseek-ai/dsh-llm').expandAssistantStream;
  if (typeof decoder !== 'function') throw new Error('Native assistant stream decoder is unavailable');
  return decoder(stream);
}
const natural = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => Object.assign(new Error(code), { code });

/** One disposable presentation owner per observed session. DSH remains the durable owner. */
export function createNativeAssistantSource({ follow, decode = expand, maxBytes = 1024 * 1024,
  schedule = setTimeout, cancel = clearTimeout, onError = () => {} } = {}) {
  const sessions = new Map();
  const metrics = { opens: 0, frames: 0, repairs: 0, gaps: 0, limited: 0, unsupported: 0, errors: 0 };
  let stopped = false;

  function attemptPosition(state) {
    const attempt = state.attempt;
    return attempt ? { turn: attempt.turn, step: attempt.step, startedAfterSeq: attempt.startedAfterSeq } : null;
  }
  function notify(state, { immediate = false, reason = 'chunk', historyChanged = true } = {}) {
    state.version++;
    if (historyChanged) state.historyVersion++;
    state.rows = state.attempt ? [...state.attempt.blocks.values()].sort((a, b) => a.index - b.index).flatMap(block => {
      if (!block.text) return [];
      const clientId = `${state.sessionId}:assistant-live:${state.epoch}:${state.agentGeneration}:${state.attempt.id}:${block.index}`;
      return [{ id: `history-live:${clientId}`, clientId, sessionId: state.sessionId,
        role: block.kind === 'reasoning' ? 'thinking' : 'assistant',
        content: block.kind === 'reasoning' ? { text: block.text, isStreaming: block.running } : block.text,
        agentMeta: { isStreaming: block.running }, isStreaming: block.running, createdAt: block.createdAt,
        toolUseId: null, historyContentStamp: `${state.version}:${block.version}` }];
    }) : [];
    const change = { rows: state.rows, immediate, reason, historyChanged, revision: state.version,
      attempt: attemptPosition(state) };
    for (const listener of state.listeners) {
      try { listener(change); } catch (error) { onError(error); }
    }
  }

  function reset(state, reason, immediate = true) {
    const hadRows = state.rows.length > 0;
    if (reason === 'turn/end' && state.attempt) {
      // Keep only bounded identity metadata for an exact late end/seq join, never
      // a terminal body's text. The direct durable feed can outrun follow's queue.
      state.retiredAttempt = { id: state.attempt.id, ending: state.attempt.ending,
        rows: state.rows.map(row => ({ id: row.id, clientId: row.clientId, role: row.role })) };
    }
    state.attempt = null;
    state.bytes = 0;
    if (hadRows) notify(state, { immediate, reason });
  }

  function chunk(state, value, time) {
    const attempt = state.attempt;
    if (!attempt || attempt.limited || !value || !natural(value.index)) return false;
    const isDelta = value.type === 'reasoning-delta' || value.type === 'text-delta';
    const isEnd = value.type === 'block-end';
    const kind = isDelta ? (value.type === 'reasoning-delta' ? 'reasoning' : 'text') : value.block?.type;
    if (!['reasoning', 'text'].includes(kind)) return false;
    const text = isDelta ? value.text : isEnd ? value.block?.text : undefined;
    if (typeof text !== 'string') return false;
    const previous = attempt.blocks.get(value.index);
    if (!previous && text === '') return false;
    if (previous && previous.kind !== kind) throw fail('ASSISTANT_BLOCK_MISMATCH');
    if (isDelta && previous?.running === false) throw fail('ASSISTANT_CLOSED_BLOCK_DELTA');
    const addition = Buffer.byteLength(text, 'utf8');
    const removed = isEnd && previous ? Buffer.byteLength(previous.text, 'utf8') : 0;
    if (state.bytes + addition - removed > maxBytes || (!previous && attempt.blocks.size >= 512)) {
      // Retire the incomplete body rather than advertising a truncated full prefix.
      if (!attempt.limited) {
        metrics.limited++; attempt.limited = true; attempt.blocks.clear(); state.bytes = 0;
        notify(state, { immediate: true, reason: 'live-limit' });
      }
      return false;
    }
    state.bytes += addition - removed;
    attempt.blocks.set(value.index, { index: value.index, kind,
      text: isDelta ? (previous?.text ?? '') + text : text, running: !isEnd,
      createdAt: previous?.createdAt ?? new Date(Number.isFinite(time) ? time : 0).toISOString(),
      version: (previous?.version ?? 0) + 1 });
    return kind === 'reasoning' ? 'thinking' : 'text';
  }

  function begin(state, frame) {
    if (typeof frame.attemptId !== 'string' || !frame.attemptId || !natural(frame.turn) || !natural(frame.step)) throw fail('ASSISTANT_INVALID_START');
    reset(state, 'replaced');
    state.bytes = 0;
    state.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step,
      nextIndex: 0, blocks: new Map(), startedAfterSeq: frame.startedAfterSeq ?? -1, ending: null };
  }

  function settle(state, attempt = state.attempt) {
    const ending = attempt?.ending;
    if (!ending) return;
    const event = state.commits.get(`${ending.eventType}:${ending.seq}`);
    if (!event) return;
    const previous = attempt === state.attempt ? state.rows : attempt.rows;
    if (event.type === 'assistant/message') {
      const rows = toCindyMessageRows(event.data.message, { sessionId: state.sessionId,
        createdAt: new Date(event.time).toISOString(), reasoningIdentity: event.data });
      for (const row of previous) {
        const index = Number(row.clientId.slice(row.clientId.lastIndexOf(':') + 1));
        const target = rows.find(r => r.id === `${state.sessionId}:${event.data.message.id}:${index}` && r.role === row.role);
        if (target) state.aliases.set(row.id, target.id);
      }
    }
    while (state.aliases.size > 256) state.aliases.delete(state.aliases.keys().next().value);
    if (attempt === state.attempt) reset(state, event.type);
    else if (attempt === state.retiredAttempt) state.retiredAttempt = null;
  }

  function accept(state, frame) {
    if (!frame || !natural(frame.revision)) throw fail('ASSISTANT_INVALID_FRAME');
    if (frame.type === 'start' && frame.revision === 1 && state.revision !== 0) {
      state.agentGeneration++; state.revision = 0; state.endedTurn = -1; reset(state, 'agent-replaced');
    }
    if (frame.revision <= state.revision) return;
    if (frame.revision !== state.revision + 1) throw fail('ASSISTANT_REVISION_GAP');
    state.revision = frame.revision;
    if (frame.type === 'start') {
      if (frame.turn <= state.endedTurn) return;
      begin(state, frame); return;
    }
    const attempt = state.attempt;
    // The direct durable observer may see turn/end before this async follow drains
    // its already queued old chunks. Those frames cannot resurrect terminal content.
    if (!attempt && state.endedTurn >= 0) {
      if (frame.type === 'end' && state.retiredAttempt?.id === frame.attemptId && frame.outcome?.kind === 'committed'
        && natural(frame.outcome.seq) && ['assistant/message', 'assistant/attempt'].includes(frame.outcome.eventType)) {
        state.retiredAttempt.ending = frame.outcome; settle(state, state.retiredAttempt);
      }
      return;
    }
    if (!attempt || frame.attemptId !== attempt.id || frame.index !== attempt.nextIndex) throw fail('ASSISTANT_CHUNK_GAP');
    if (frame.type === 'chunk') {
      attempt.nextIndex++;
      const wasEmpty = state.rows.length === 0;
      const changed = chunk(state, frame.chunk, frame.time);
      if (changed) notify(state, { immediate: wasEmpty, historyChanged: changed === 'thinking', reason: 'chunk' });
    } else if (frame.type === 'end') {
      if (frame.outcome?.kind === 'abandoned') reset(state, 'abandoned');
      else if (frame.outcome?.kind === 'committed' && natural(frame.outcome.seq)
        && ['assistant/message', 'assistant/attempt'].includes(frame.outcome.eventType)) {
        attempt.ending = frame.outcome; settle(state);
      } else throw fail('ASSISTANT_INVALID_END');
    } else throw fail('ASSISTANT_INVALID_FRAME');
  }

  function baseline(state, value) {
    if (!value || !natural(value.revision)) { metrics.unsupported++; throw fail('ASSISTANT_STREAM_UNSUPPORTED'); }
    reset(state, 'baseline'); state.agentGeneration++; state.revision = value.revision; state.supported = true;
    const active = value.activeAttempt;
    if (!active || active.turn <= state.endedTurn) return;
    if (!natural(active.nextIndex) || !Array.isArray(active.stream)) throw fail('ASSISTANT_INVALID_BASELINE');
    begin(state, active);
    // Bound reconnect expansion before calling the official decoder. A compact
    // record may contain many tiny chunks (including private tool arguments).
    let replayChunks = 0; let replayBytes = 0;
    for (const record of active.stream) {
      replayChunks += record?.type === 'chunk' ? 1 : (record?.texts?.length ?? record?.args?.length ?? 0);
      if (replayChunks > 65536) break;
      if (Array.isArray(record?.texts)) for (const text of record.texts) {
        if (typeof text === 'string') replayBytes += Buffer.byteLength(text, 'utf8');
        if (replayBytes > maxBytes) break;
      }
      if (replayBytes > maxBytes) break;
    }
    if (replayChunks > 65536 || replayBytes > maxBytes) {
      metrics.limited++; state.attempt.limited = true; state.attempt.nextIndex = active.nextIndex;
      notify(state, { immediate: true, reason: 'baseline-limit' }); return;
    }
    const chunks = decode(active.stream);
    if (chunks.length !== active.nextIndex) throw fail('ASSISTANT_BASELINE_INDEX');
    for (const timed of chunks) chunk(state, timed.chunk, timed.time);
    if (state.attempt) state.attempt.nextIndex = active.nextIndex;
    notify(state, { immediate: true, reason: 'baseline' });
  }

  function close(state) {
    if (sessions.get(state.sessionId) !== state) return;
    sessions.delete(state.sessionId);
    state.controller.abort();
    if (state.timer) cancel(state.timer);
    state.listeners.clear(); state.attempt = null; state.rows = []; state.commits.clear(); state.aliases.clear();
  }

  async function run(state) {
    for (let tries = 0; tries < 3 && !state.controller.signal.aborted; tries++) {
      const lease = new AbortController();
      const abort = () => lease.abort();
      state.controller.signal.addEventListener('abort', abort, { once: true });
      try {
        metrics.opens++;
        let opened = false;
        for await (const value of follow(state.sessionId, lease.signal)) {
          if (state.controller.signal.aborted || sessions.get(state.sessionId) !== state) return;
          if (value.type === 'snapshot') {
            // An end may refer to a commit already covered by the opening cursor,
            // so that commit will correctly NOT be replayed as a later event.
            for (const record of value.records ?? []) if (record?.type === 'event') noteEvent(state.sessionId, record.event);
            baseline(state, value.assistantStream); opened = true;
          }
          else if (!opened) throw fail('ASSISTANT_NO_BASELINE');
          else if (value.type === 'assistant-stream') { metrics.frames++; accept(state, value.frame); }
          else if (value.type === 'event') noteEvent(state.sessionId, value.event);
        }
        if (!state.controller.signal.aborted) throw fail('ASSISTANT_FOLLOW_CLOSED');
      } catch (error) {
        if (state.controller.signal.aborted) return;
        metrics.errors++; if (/GAP/.test(error.code ?? '')) metrics.gaps++;
        reset(state, 'repair');
        try { onError(error); } catch { /* Diagnostics cannot break the source loop. */ }
        if (error.code === 'ASSISTANT_STREAM_UNSUPPORTED') return;
        if (tries < 2) {
          metrics.repairs++;
          await new Promise(resolve => {
            const done = () => { if (state.timer) cancel(state.timer); state.timer = null; state.controller.signal.removeEventListener('abort', done); resolve(); };
            state.timer = schedule(done, 250 * 2 ** tries); state.timer?.unref?.();
            state.controller.signal.addEventListener('abort', done, { once: true });
          });
        }
      } finally { lease.abort(); state.controller.signal.removeEventListener('abort', abort); }
    }
  }

  function watch(sessionId, listener, signal) {
    if (stopped || signal?.aborted || typeof follow !== 'function') return () => {};
    let state = sessions.get(sessionId);
    if (!state) {
      state = { sessionId, epoch: randomUUID(), agentGeneration: 0, revision: 0, version: 0, historyVersion: 0,
        rows: [], bytes: 0, attempt: null, listeners: new Set(), controller: new AbortController(),
        commits: new Map(), aliases: new Map(), timer: null, supported: false, endedTurn: -1,
        projection: null, projectionBase: null };
      sessions.set(sessionId, state);
      state.listeners.add(listener);
      // Start only after the lease has installed its cancellation handler.
      queueMicrotask(() => { if (!state.controller.signal.aborted) void run(state); });
    } else {
      state.listeners.add(listener);
      if (state.rows.length) listener({ rows: state.rows, immediate: true, reason: 'subscriber', historyChanged: true, revision: state.version,
        attempt: attemptPosition(state) });
    }
    let disposed = false;
    const dispose = () => { if (disposed) return; disposed = true; signal?.removeEventListener('abort', dispose); state.listeners.delete(listener); if (!state.listeners.size) close(state); };
    signal?.addEventListener('abort', dispose, { once: true });
    return dispose;
  }

  function noteEvent(sessionId, event) {
    const state = sessions.get(sessionId);
    if (!state || !event) return;
    if (['assistant/message', 'assistant/attempt'].includes(event.type) && natural(event.seq)) {
      state.commits.set(`${event.type}:${event.seq}`, event);
      while (state.commits.size > 32) state.commits.delete(state.commits.keys().next().value);
      settle(state);
      if (state.retiredAttempt) settle(state, state.retiredAttempt);
    } else if (event.type === 'turn/end') {
      state.endedTurn = Math.max(state.endedTurn, event.data?.turn ?? -1);
      reset(state, 'turn/end');
    }
  }

  function overlay(sessionId, base) {
    const state = sessions.get(sessionId);
    if (!state?.supported) return base;
    const live = state.rows.filter(row => row.role === 'thinking');
    const rows = appendReadonlyRows(base.rows, live);
    if (state.projectionBase !== base.projection?.identity) {
      state.projectionBase = base.projection?.identity; state.projection = {};
    }
    const lookup = new Map(live.map((row, index) => [row.id, base.rows.length + index]));
    return { ...base, rows,
      ...(base.projection ? { projection: { identity: state.projection,
        version: `${base.projection.version}:${state.historyVersion}`, sealedPrefixLength: base.projection.sealedPrefixLength } } : {}),
      resolve(id, options) {
        if (lookup.has(id)) return lookup.get(id);
        return base.resolve(state.aliases.get(id) ?? id, options);
      } };
  }

  return { watch, noteEvent, overlay, snapshot: sid => sessions.get(sid)?.rows ?? [],
    supported: sid => sessions.get(sid)?.supported === true,
    stats: () => ({ ...metrics, sessions: sessions.size, liveBytes: [...sessions.values()].reduce((sum, state) => sum + state.bytes, 0) }),
    stop() { stopped = true; for (const state of [...sessions.values()]) close(state); } };
}
