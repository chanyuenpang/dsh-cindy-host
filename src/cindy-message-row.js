/**
 * Fold DSH model messages into the rows the Cindy phone renders.
 *
 * DSH stores one message with a `content: ContentBlock[]`; the phone stores one
 * row per block. The split is the whole job: an assistant turn that thought,
 * called a tool, and then answered becomes a `thinking` row, a `tool_use` row,
 * and an `assistant` row, in that order.
 *
 * The target is `RemoteMessage` (`apps/mobile/src/session/types.ts`), and the
 * fields each role reads are defined by the phone's own normalizer
 * (`apps/mobile/src/session/messageNormalize.ts`), not by this file:
 *
 *   assistant / user  content: { text }              read as `parsed.text`
 *   thinking          content: { text, durationMs? } read as `content.text`
 *   tool_use          content: { toolName, input }   read by `parseMessageToolUse`
 *   tool_result       content: anything previewable  read by `contentToPreview`
 */

/**
 * DSH message roles this Host renders, and the phone row role each becomes.
 *
 * A role that is NOT in this map produces no rows at all. The earlier test was
 * `role === 'user' ? 'user' : 'assistant'`, which made **every** unknown role an
 * assistant turn — so DSH's `system/message` events arrived on the phone as
 * ordinary replies. Those events are the prompt injection itself: DSH requires
 * their source to be `{kind: 'plugin'}` and the plugin name to be present
 * (`dsh-session`'s own `assertMessageEventShape`), and the plugin that emits
 * them is `@deepseek-ai/dsh-system-prompt`. Nothing about the model's
 * instructions belongs in a conversation transcript, so the default is silence
 * rather than a guess.
 */
const ROW_ROLE_BY_MESSAGE_ROLE = new Map([
  ['user', 'user'],
  ['assistant', 'assistant'],
]);

/** Roles the phone knows; anything else would be dropped by its normalizer. */
const ROLE_BY_BLOCK = {
  text: 'text',
  reasoning: 'thinking',
  'tool-call': 'tool_use',
  'tool-result': 'tool_result',
};

/** Parse the raw JSON argument string a tool call carries. */
function parseToolArguments(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // A malformed argument string is still the only thing the model produced;
    // the phone's summary formatter handles a non-object input.
    return trimmed;
  }
}

/**
 * DSH tool names → the names the phone's renderer switches on.
 *
 * Most of the phone's cards are chosen by input shape, but the plan/todo card is
 * chosen by **name**: `extractPlanTodos` reads `input.todos` only for
 * `TodoWrite`, and `agentPlanSource` returns `'todo'` for that name alone
 * (`@cindy/maker-shared/message-render`). DSH's equivalent tool is `todo_write`
 * and carries the identical `{ todos: [{ content, status, activeForm? }] }`
 * input, so the card was never selected and the agent's plan stayed invisible on
 * the phone. This translates the name only — never the data.
 */
const TOOL_NAME_BY_DSH_NAME = { todo_write: 'TodoWrite' };

/** Map one DSH tool name to the phone's vocabulary. */
function cindyToolName(name) {
  return TOOL_NAME_BY_DSH_NAME[name] ?? name;
}

/**
 * The phone's entry for one durable DSH attachment block.
 *
 * The phone reads an attachment from the message's **content JSON**, and it reads
 * the two kinds from two different fields (`messageNormalize.ts`):
 *
 *  - `files[]` → `readFileAttachments`: `{ name, path?, url?, mimeType? }`. A file
 *    with neither `path` nor `url` renders as 没有可展示的远程路径 — which is what an
 *    image reported here used to look like.
 *  - `images[]` → `readImageAttachments`: needs a `url` **or** `base64`, and an entry
 *    with neither is dropped outright.
 *
 * DSH stores an image content-addressed and states that its reference is "never a
 * filesystem path or bearer URL", so there is nothing to put in `path` and nothing to
 * serve as a URL. What it does give is a `attachmentId` that `ctx.attachments.readImage`
 * can turn back into bytes — so an image entry carries that handle **internally**
 * (`imageRef`), the page is hydrated into `images[]` by
 * {@link hydrateImageAttachments}, and the handle is stripped before the row leaves
 * this Host. An image whose bytes cannot be read stays an honest file chip rather than
 * a fabricated path.
 *
 * @param block - one `image` or `file` content block.
 * @returns the entry, or null when the block names nothing.
 */
function attachmentEntryOf(block) {
  const ref = block?.attachment;
  const name = typeof ref?.name === 'string' && ref.name !== '' ? ref.name : '';
  const bytes = Number.isFinite(ref?.bytes) ? ref.bytes : undefined;
  if (name === '' && bytes === undefined) return null;
  const mimeType = typeof ref?.mediaType === 'string' && ref.mediaType !== '' ? ref.mediaType : undefined;
  // The **whole** durable descriptor travels as the handle, not a subset: the store
  // validates the reference it is asked to read (it re-derives the object from it), and
  // a handle missing `width`/`height`/`name` is a different value than the one DSH
  // stored. Measured: a subset silently failed every image read.
  const imageRef = block?.type === 'image' && ref !== null && typeof ref === 'object' && typeof ref.attachmentId === 'string' && ref.attachmentId !== ''
    ? { ...ref }
    : null;
  return {
    ...(name === '' ? {} : { name }),
    ...(bytes === undefined ? {} : { size: bytes }),
    ...(mimeType === undefined ? {} : { mimeType }),
    ...(imageRef === null ? {} : { imageRef }),
  };
}

/**
 * Longest image this Host will inline into a transcript row.
 *
 * An inlined image is base64 (≈4/3 of the bytes) inside a JSON row the phone keeps in
 * memory and in its on-disk message cache, so this is a memory budget rather than a
 * protocol limit — and DSH's own normalization has usually shrunk the stored image
 * well below it. Past the bound the entry stays a file chip: honest, if not pretty.
 */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

/**
 * How much inlined image data one page may carry in total.
 *
 * This is the bound that actually matters, and it comes from the wire, not from
 * memory: the relay **rejects** any device-link frame over `MAX_FRAME_BYTES`
 * (2 MiB) outright, so a page whose images add up past the ceiling does not arrive
 * late — it does not arrive at all, and the controller is left with a window it
 * cannot fill (reported as 整个对话变成只有一行我的输出、重新加载更早消息也没有响应).
 *
 * 1 MiB of base64 is ≈ 768 KiB of image data, and after JSON and the page's own text
 * rows the frame still lands around 1.1–1.4 MiB — comfortably inside the 2 MiB
 * ceiling with room for the rest of the transcript. Images beyond the budget stay
 * file chips, which is a per-attachment degradation rather than a per-page failure.
 */
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 1024 * 1024;

/** Estimated JSON overhead one inlined image adds on top of its base64. */
const INLINE_IMAGE_ENTRY_BYTES = 96;

/**
 * Turn the page's image handles into bytes the phone can render.
 *
 * Only the rows being returned are hydrated (not the whole session log), so a
 * transcript with a hundred photos costs one page's worth of reads. Each image is
 * read once even when several rows share it, and **one unreadable image costs that
 * image, never the page** — the row keeps its file entry instead.
 *
 * The page's rows arrive newest first, so the budget is spent from the newest
 * picture backwards: the images the user is looking at are the ones that render.
 *
 * @param rows - the page of rows about to be served.
 * @param options - `readImage` (the attachment store's reader), `maxBytes` (one
 *   image), and `maxTotalBytes` (the whole page).
 * @returns the same rows, with readable images moved into `content.images[]`.
 */
export async function hydrateImageAttachments(rows, {
  readImage,
  maxBytes = MAX_INLINE_IMAGE_BYTES,
  maxTotalBytes = MAX_INLINE_IMAGE_TOTAL_BYTES,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Plan first, read second.
  //
  // The page's rows arrive newest first, so the budget is spent from the newest
  // picture backwards — the images the user is looking at are the ones that render.
  // A descriptor that declares its size is judged on that number, so an image too
  // large for the page is never read at all: reading 2.4 MB to throw it away is work
  // the page does not owe anyone (and it made the inlining counters lie about what
  // the page tried to serve).
  const planned = new Set();
  const wanted = new Map();
  let spent = 0;
  for (const row of list) {
    for (const entry of Array.isArray(row?.content?.files) ? row.content.files : []) {
      const handle = entry?.imageRef;
      if (handle === null || typeof handle !== 'object' || typeof handle.attachmentId !== 'string') continue;
      if (wanted.has(handle.attachmentId)) continue;
      const declared = Number.isFinite(entry?.size) ? entry.size : (Number.isFinite(handle?.bytes) ? handle.bytes : null);
      if (declared !== null && declared > maxBytes) continue;
      if (declared !== null) {
        // base64 is ≈4/3 of the bytes, plus the entry's own JSON.
        const cost = Math.ceil((declared * 4) / 3) + INLINE_IMAGE_ENTRY_BYTES;
        if (spent + cost > maxTotalBytes) continue;
        spent += cost;
      }
      wanted.set(handle.attachmentId, handle);
      planned.add(handle.attachmentId);
    }
  }
  const inlined = new Map();
  if (typeof readImage === 'function' && wanted.size > 0) {
    await Promise.all([...wanted].map(async ([attachmentId, handle]) => {
      try {
        const stored = await readImage(handle);
        if (stored === null || typeof stored !== 'object') return;
        if (typeof stored.base64 !== 'string' || stored.base64 === '') return;
        // An undeclared size can only be judged now, and an oversize one costs this
        // image rather than the page.
        if (Number.isFinite(stored.bytes) && stored.bytes > maxBytes) return;
        inlined.set(attachmentId, stored);
      } catch {
        // Per attachment, exactly like every other unservable attachment here.
      }
    }));
  }
  for (const row of list) {
    const files = Array.isArray(row?.content?.files) ? row.content.files : null;
    if (files === null) continue;
    const images = [];
    const kept = [];
    for (const entry of files) {
      const handle = entry?.imageRef;
      const stored = handle === undefined ? undefined : inlined.get(handle.attachmentId);
      if (stored !== undefined) {
        // `base64` (not `url`) is what the phone's normalizer turns into
        // `data:<mimeType>;base64,…`, which `isPreviewableUri` accepts — so the bubble
        // renders the picture itself, with no media channel and no fetch.
        const mimeType = stored.mediaType ?? entry.mimeType ?? 'image/png';
        images.push({
          base64: stored.base64,
          mimeType,
          ...(entry.name === undefined ? {} : { originalName: entry.name }),
        });
        continue;
      }
      const { imageRef: _handle, ...rest } = entry;
      kept.push(rest);
    }
    const content = { ...row.content };
    if (images.length > 0) content.images = images;
    if (kept.length > 0) content.files = kept;
    else delete content.files;
    row.content = content;
  }
  return list;
}

/** Flatten nested tool-result content into the text the phone previews. */
function flattenToolResult(blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const parts = [];
  for (const block of list) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The message sources this Host renders, on purpose and by name.
 *
 * DSH states the rule itself: a `user/message` event carries **three** producers
 * — a human's prompt, a plugin notification, and an injected goal continuation
 * round — and "all three project their `content` verbatim; `source` tells them
 * apart" (`dsh-session` known event types). Role alone is therefore never enough,
 * and a *denylist* is never enough either: this started as "drop `plugin`", which
 * cleaned up the system prompt and the runtime snapshot and still left the skills
 * catalog in the transcript, because `@deepseek-ai/dsh-tool-skill` builds that one
 * with `source: { kind: 'skill-catalog', form: 'catalog' }` on a `user` message.
 *
 * So the test is inverted: render exactly what a participant produced — the
 * human (`user`), the model (`model`), and a tool's own result (`tool`) — and
 * every other named kind is producer-supplied context that belongs in the model's
 * request, not in a conversation transcript. A source that is absent entirely is
 * still rendered: DSH requires one on every message, so its absence means a shape
 * this Host cannot classify, and hiding a user's own words is the worse failure.
 */
const RENDERABLE_SOURCE_KINDS = new Set(['user', 'model', 'tool']);

/**
 * Build the Cindy rows for one DSH message.
 * @param message - `{ id, role, content }` in DSH's model shape.
 * @param context - the session id, the row's creation time (ISO), and — for a
 *   user turn — the `clientId` the controller minted for the prompt.
 * @returns one row per renderable content block, in order.
 */
export function toCindyMessageRows(message, { sessionId, createdAt, now = () => new Date(), promptClientId = null }) {
  const rows = [];
  const role = ROW_ROLE_BY_MESSAGE_ROLE.get(message?.role);
  // `system` (the prompt injection), a hook's injected turn, or any role this
  // Host has never seen: none of them is something a participant said.
  if (role === undefined) return rows;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  // DSH records a tool result as a `user`-role message whose source is
  // `{kind: 'tool'}`. Its content block is what makes it a result row; a *text*
  // block on such a message is not the user speaking, so it is not rendered as
  // one.
  const sourceKind = typeof message?.source?.kind === 'string' ? message.source.kind : null;
  // Everything a producer injected — the system prompt and runtime-context
  // snapshot (`plugin`), the skills catalog (`skill-catalog`), and whatever kind
  // the next plugin adds — is the model's request, not the conversation. The
  // runtime snapshot is re-injected on every turn, so rendering it meant the
  // phone showed the whole system prompt as an assistant reply and a
  // "Current runtime context. This snapshot supersedes…" bubble as a user message.
  if (sourceKind !== null && !RENDERABLE_SOURCE_KINDS.has(sourceKind)) return rows;
  const toolResultMessage = sourceKind === 'tool';
  const time = createdAt ?? now().toISOString();
  // A user turn's attachments belong to the message, not to a block: the phone
  // reads them from the same `content` object as the text, so they are collected
  // here and carried by the message's text row (or by a row of their own when the
  // message was nothing but attachments).
  const attachments = role === 'user' && !toolResultMessage
    ? blocks.filter((block) => block?.type === 'image' || block?.type === 'file').map(attachmentEntryOf).filter(Boolean)
    : [];
  let attachmentsCarried = false;

  blocks.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return;
    const kind = ROLE_BY_BLOCK[block.type];
    // Images and files are not rows of their own here: an image needs a media
    // channel this Host does not serve, and the file's chip travels on the text
    // row above. Emitting them as empty rows would add noise, not information.
    if (kind === undefined) return;
    if (toolResultMessage && block.type !== 'tool-result') return;

    // A stable id: the phone keys, dedupes, and patches rows by it.
    const id = `${sessionId}:${message.id}:${index}`;
    // The controller shows a message the moment it sends it, and retires that
    // optimistic copy by matching `clientId` against the durable row's
    // (`projectOptimisticUserMessages` splices out the echo on exactly that
    // field). A synthetic id here means the echo is never recognised, so the
    // user sees their message twice — once spinning, once real — until some
    // later reconciliation drops one. Carrying the prompt's own `clientId` on
    // the user row is what lets the controller retire its copy immediately.
    const clientId = role === 'user' && typeof promptClientId === 'string' && promptClientId !== '' ? promptClientId : id;
    const base = {
      id,
      clientId,
      sessionId,
      role: kind === 'text' ? role : kind,
      toolUseId: null,
      agentMeta: null,
      createdAt: time,
    };

    switch (block.type) {
      case 'text':
        // Reasoning models emit empty text blocks for usage only; the phone's
        // normalizer drops them, but not emitting them at all is cheaper.
        if (typeof block.text !== 'string' || block.text === '') return;
        rows.push({
          ...base,
          content: {
            text: block.text,
            ...(attachments.length > 0 && !attachmentsCarried ? { files: attachments } : {}),
          },
        });
        attachmentsCarried = attachmentsCarried || attachments.length > 0;
        return;
      case 'reasoning':
        if (typeof block.text !== 'string' || block.text === '') return;
        rows.push({ ...base, content: { text: block.text } });
        return;
      case 'tool-call':
        rows.push({
          ...base,
          toolUseId: typeof block.id === 'string' ? block.id : null,
          content: {
            toolName: typeof block.name === 'string' ? cindyToolName(block.name) : '',
            input: parseToolArguments(block.arguments),
            ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}),
          },
        });
        return;
      case 'tool-result':
        rows.push({
          ...base,
          toolUseId: typeof block.toolCallId === 'string' ? block.toolCallId : null,
          content: { text: flattenToolResult(block.content), isError: block.isError === true },
        });
        return;
      default:
        return;
    }
  });

  // A message that was nothing but attachments still has to show them: the phone
  // renders the chip from the user row, and a message with no rows at all would
  // simply not exist in the transcript.
  if (attachments.length > 0 && !attachmentsCarried) {
    const id = `${sessionId}:${message.id}:attachments`;
    rows.unshift({
      id,
      clientId: typeof promptClientId === 'string' && promptClientId !== '' ? promptClientId : id,
      sessionId,
      role: 'user',
      toolUseId: null,
      agentMeta: null,
      createdAt: time,
      content: { text: '', files: attachments },
    });
  }

  return rows;
}

/**
 * Fold a whole session's messages, newest first.
 *
 * The phone's paging contract is `ORDER BY createdAt DESC` with the oldest row
 * at the page tail (`apps/mobile/src/session/historyWindowGap.ts`), and its
 * cursor is a timestamp, so the order here is part of the contract.
 * @param messages - DSH model messages with their event times.
 * @param context - the session id.
 * @returns the rows the phone parses, newest first.
 */
export function toCindyMessages(messages, { sessionId, now = () => new Date() }) {
  const list = Array.isArray(messages) ? messages : [];
  // Reverse the MESSAGE order only. Within one message the blocks keep their
  // order (thought → tool → answer): they share a timestamp, so the phone's
  // stable sort would otherwise present them backwards.
  const perMessage = list.map((entry) => toCindyMessageRows(entry.message, {
    sessionId,
    createdAt: entry.createdAt,
    now,
    promptClientId: entry.promptClientId ?? null,
  }));
  const rows = [];
  for (const group of perMessage.reverse()) rows.push(...group);
  return rows;
}
