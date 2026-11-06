/**
 * One session's in-flight, public reasoning text. Raw DSH chunks are log-only,
 * so deriveEventMessage deliberately excludes them. Keep a display-only overlay
 * until assistant/message supplies the authoritative rows (including abort prefixes).
 * Never copy signatures, replay state or provider-private metadata to the phone.
 */
export function createReasoningStream(sessionId) {
  let key = null;
  let lastSeq = null;
  const blocks = new Map();

  function clear() {
    const changed = blocks.size > 0;
    blocks.clear();
    key = null;
    return changed;
  }

  function consume(event) {
    if (!event || typeof event !== 'object') return false;
    if (Number.isSafeInteger(event.seq)) {
      if (lastSeq !== null && event.seq <= lastSeq) return false;
      lastSeq = event.seq;
    }
    if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start'
      || event.type === 'step/end' || event.type === 'assistant/message') return clear();
    if (event.type !== 'assistant/chunk') return false;
    const { turn, step, chunk } = event.data ?? {};
    if (!Number.isSafeInteger(turn) || turn < 0 || !Number.isSafeInteger(step) || step < 0) return false;
    if (!chunk || !Number.isSafeInteger(chunk.index) || chunk.index < 0) return false;
    const isStart = chunk.type === 'block-start' && chunk.blockType === 'reasoning';
    const isDelta = chunk.type === 'reasoning-delta' && typeof chunk.text === 'string';
    const isEnd = chunk.type === 'block-end' && chunk.block?.type === 'reasoning' && typeof chunk.block.text === 'string';
    if (!isStart && !isDelta && !isEnd) return false;
    const nextKey = `${turn}:${step}`;
    if (key !== nextKey) { clear(); key = nextKey; }
    let block = blocks.get(chunk.index);
    if (!block) {
      block = { chunks: [], createdAt: new Date(Number.isFinite(event.time) ? event.time : 0).toISOString(), isStreaming: true };
      blocks.set(chunk.index, block);
    }
    if (isDelta && block.isStreaming) block.chunks.push(chunk.text);
    if (isEnd) { block.chunks = [chunk.block.text]; block.isStreaming = false; }
    return isDelta || isEnd;
  }

  function entries() {
    return [...blocks].sort(([a], [b]) => a - b).flatMap(([index, block]) => {
      const content = block.chunks.join('');
      if (!content) return [];
      const clientId = `${sessionId}:reasoning-stream:${key}:${index}`;
      return [{ scope: key, index, row: { id: `history-live:${clientId}`, clientId, sessionId, role: 'thinking', content: { text: content, isStreaming: block.isStreaming },
        toolUseId: null, agentMeta: null, createdAt: block.createdAt, isStreaming: block.isStreaming } }];
    });
  }

  const rows = () => entries().map(entry => entry.row);
  return { consume, rows, entries, clear };
}
