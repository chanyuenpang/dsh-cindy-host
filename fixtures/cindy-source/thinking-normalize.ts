// Exact pure consumer functions from Cindy dc294b02cadf2339da10c07df8d7c005bcad3dc0.

// Sources: apps/mobile/src/session/messageNormalize.ts and packages/maker-shared/src/messageNormalize.ts.

// Only unrelated module imports/declarations are omitted; test erases types, not behavior.

function normalizeThinking(message: RemoteMessage): NormalizedRemoteMessage | null {
  const content = readRecord(message.content);
  const text = readString(content?.text) ?? '';
  const durationMs = readNumber(content?.durationMs) ?? 0;
  const redacted = content?.isRedacted === true;
  // Opus 4.8+ / Fable 5 的 omitted thinking 占位块(空文本 + 零时长):上游只回带
  // 签名的空块,渲染出来就是满屏"思考 1s"噪音,直接不进渲染流(对齐桌面 #467 的
  // isOmittedThinkingPlaceholder 判定;redacted 块与真实流过增量的空块不受影响)。
  if (!redacted && text === '' && durationMs === 0) return null;
  return {
    key: messageNormalizeKey(message),
    source: message,
    kind: 'thinking',
    role: message.role,
    label: durationMs > 0 ? `thinking ${formatDuration(durationMs)}` : 'thinking',
    body: redacted ? 'Thinking hidden' : text,
    align: 'agent',
    createdAt: normalizeThinkingCreatedAt(message.createdAt, content, durationMs),
    // 流式标记必须随 thinking 透传:ThinkingCard 的「思考中 Xs」实时计时以
    // message.isStreaming 为运行判定,丢掉它计时器永远不启动(review #643 实锤)。
    isStreaming: readMessageStreaming(message) || undefined,
  };
}

function normalizeThinkingCreatedAt(
  createdAt: string,
  content: Record<string, unknown> | null,
  durationMs: number,
): string {
  const finishedAt = readTimestamp(content?.finishedAt) ?? readTimestamp(createdAt);
  if (finishedAt === null || durationMs <= 0) return createdAt;
  return new Date(finishedAt - durationMs).toISOString();
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readMessageStreaming(message: RemoteMessage): boolean {
  if (message.agentMeta?.isStreaming === true || message.agentMeta?.streaming === true) return true;
  const content = readRecord(message.content);
  return content?.isStreaming === true || content?.streaming === true;
}

function messageNormalizeKey(message: MessageNormalizeSourceMessageLike): string {
  return readNonEmptyString(message.id)
    ?? readNonEmptyString(message.clientId)
    ?? `${message.role}:${message.createdAt ?? ''}`;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export { normalizeThinking };
