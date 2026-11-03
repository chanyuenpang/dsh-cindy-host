import { createHash } from 'node:crypto';
import { refusalError } from './cindy-channels.js';
import { toCindySessionListRow } from './cindy-session-row.js';
const bad = text => refusalError('BAD_REQUEST', text);
const unavailable = text => refusalError('NOT_AVAILABLE', text);
const notFound = () => refusalError('NOT_FOUND', 'No visible native reminder matches this identity');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const reminderWireId = id => 'dsh-schedule:' + id;
const fields = ['name', 'prompt', 'kind', 'cronExpr', 'timezone', 'recurring', 'manual', 'intervalMs', 'agentKind', 'modelAgentKind', 'model', 'providerId', 'effort', 'fastMode', 'workspaceKind', 'workingDir', 'useWorktree', 'targetSessionId', 'persistentSession', 'silentWhenIdle', 'notify', 'executionMode'];
function input(value, create) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw bad('Unsupported reminder input/field');
  for (const key of ['name', 'prompt', 'kind', 'cronExpr', 'timezone', 'agentKind', 'workspaceKind', 'workingDir', 'targetSessionId', 'executionMode']) if (own(value, key) && typeof value[key] !== 'string') throw bad(key + ' must be a string');
  if (create && ['name', 'prompt', 'kind', 'cronExpr', 'timezone', 'agentKind', 'targetSessionId'].some(key => typeof value[key] !== 'string')) throw bad('Creating a reminder requires the complete recurring existing-session form');
  for (const key of ['recurring', 'manual', 'useWorktree', 'persistentSession', 'silentWhenIdle', 'fastMode']) if (own(value, key) && typeof value[key] !== 'boolean') throw bad(key + ' must be boolean');
  if (create && value.recurring !== true || own(value, 'recurring') && value.recurring !== true || value.manual === true) throw unavailable('Only recurring, non-manual native reminders are writable');
  if (own(value, 'kind') && value.kind !== 'cron') throw unavailable('Only the existing cron-family reminder form is writable');
  for (const key of ['useWorktree', 'persistentSession', 'silentWhenIdle', 'fastMode']) if (value[key] === true) throw unavailable('Native reminders cannot apply ' + key);
  for (const key of ['modelAgentKind', 'model', 'providerId', 'effort']) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== '') throw unavailable('Native reminders follow the target session; per-reminder ' + key + ' overrides are unsupported');
  }
  if (create && (value.workspaceKind !== 'dialogue' || value.useWorktree !== false || !value.notify || ['desktop', 'feishu', 'wecomGroup'].some(key => value.notify[key] !== false))) throw unavailable('Create must explicitly select an existing dialogue, no worktree and all notification switches off');
  if (value.workspaceKind !== undefined && value.workspaceKind !== 'dialogue') throw unavailable('This subset binds an existing dialogue; it does not create a project/run workspace');
  if (value.executionMode !== undefined && value.executionMode !== 'agent') throw unavailable('Native reminders do not execute scheduler scripts');
  if (value.notify !== undefined) {
    if (!value.notify || typeof value.notify !== 'object' || Array.isArray(value.notify) || Object.keys(value.notify).some(key => !['desktop', 'feishu', 'wecomGroup'].includes(key))) throw bad('Invalid notification configuration');
    for (const entry of Object.values(value.notify)) { if (typeof entry !== 'boolean') throw bad('Notification switches must be boolean'); if (entry) throw unavailable('No native per-reminder external/desktop notification delivery is mapped'); }
  }
  if (value.name !== undefined && (!value.name.trim() || value.name.length > 120)) throw bad('Reminder name must contain 1–120 characters');
  if (value.prompt !== undefined && (!value.prompt.trim() || value.prompt.length > 65536)) throw bad('Reminder prompt must be nonempty and within the Host text budget');
  if (value.agentKind !== undefined && !['claude-code', 'codex', 'pi'].includes(value.agentKind)) throw bad('Invalid target agent alias');
  if (value.intervalMs !== undefined && value.intervalMs !== null && (!Number.isSafeInteger(value.intervalMs) || value.intervalMs < 60000 || value.intervalMs % 1000 !== 0)) throw unavailable('Native intervals must be whole seconds of at least 60 seconds');
  return value;
}
function canonicalCron(value) { return typeof value === 'string' ? value.trim().split(/\s+/).join(' ') : ''; }
function recurrence(record) {
  if (record.kind === 'at' || record.kind === 'after') return { recurring: false, manual: false };
  if (record.kind === 'every') {
    const intervalMs = record.everySeconds * 1000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) throw unavailable('Native interval cannot be represented faithfully');
    return { kind: 'cron', recurring: true, manual: false, intervalMs, cronExpr: '' };
  }
  if (record.kind === 'cron') return { kind: 'cron', recurring: true, manual: false, cronExpr: record.expression, timezone: record.timeZone };
  if (record.kind === 'daily' || record.kind === 'weekly') {
    const parts = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?$/.exec(record.time);
    if (!parts || Number(parts[4] ?? 0) !== 0) throw unavailable('Fractional native calendar timing has no exact existing remote cron representation');
    const days = record.kind === 'weekly' ? record.weekdays : undefined;
    if (days && (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7))) throw unavailable('Invalid native weekly rule');
    const fields = [Number(parts[2]), Number(parts[1]), '*', '*', days ? days.join(',') : '*'];
    if (Number(parts[3]) !== 0) fields.unshift(Number(parts[3]));
    return { kind: 'cron', recurring: true, manual: false, cronExpr: fields.join(' '), timezone: record.timeZone };
  }
  throw unavailable('Native reminder timing is not expressible by the existing remote form');
}
/** DSH schedule alone persists rules, acknowledgments and binding. This adapter
 * owns only short-lived transport receipts; delivery is never called a run. */
export function createDshReminders({ getService, getSession, subscribeChanged, now = Date.now, maxRecords = 500, maxBytes = 384 * 1024, maxReads = 8, receiptLimit = 128, receiptTtlMs = 15 * 60000 }) {
  let epoch = 0; let disposed = false; const active = new Set(); const receipts = new Map(); const observers = new Set();
  function serviceNow() { const service = getService(); if (disposed || typeof service?.catalog !== 'function') throw unavailable('Native DSH reminder catalog is not composed'); return service; }
  async function scoped(options, work) {
    const service = serviceNow(); if (active.size >= maxReads) throw unavailable('Too many native reminder requests');
    const controller = new AbortController(); active.add(controller); const generation = epoch;
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const check = () => { if (disposed || signal.aborted || generation !== epoch || getService() !== service) throw unavailable('Native reminder request cancelled or source replaced'); };
    const targets = new Map();
    const target = async id => {
      if (targets.has(id)) return targets.get(id);
      const row = await getSession(id, { signal }); check();
      if (!row || row.id !== id) { targets.set(id, undefined); return undefined; }
      const view = options.getView ? await options.getView(id) : toCindySessionListRow(row); check();
      const value = view?.id === id ? { row, view } : undefined; targets.set(id, value); return value;
    };
    const catalog = async () => {
      const rows = await service.catalog(); check();
      if (!Array.isArray(rows) || rows.length > maxRecords) throw unavailable('Native reminder catalog is invalid or over budget');
      const ids = new Set();
      for (const row of rows) { if (typeof row?.id !== 'string' || !row.id || row.id.length > 256 || ids.has(row.id) || typeof row.sessionId !== 'string' || !['active', 'inactive'].includes(row.status)) throw unavailable('Invalid native reminder identity or binding'); ids.add(row.id); }
      return rows;
    };
    try { check(); const result = await work({ service, signal, check, target, catalog }); check(); return result; }
    catch (error) { if (signal.aborted || generation !== epoch || disposed) throw unavailable('Native reminder request cancelled; cancellation does not roll back persistence'); throw error; }
    finally { active.delete(controller); }
  }
  function project(record, target) {
    const timing = recurrence(record);
    if (typeof record.prompt !== 'string' || !Number.isFinite(Date.parse(record.scheduledAt))) throw unavailable('Native reminder content/next target is invalid');
    return { id: reminderWireId(record.id), name: typeof record.title === 'string' ? record.title : '', prompt: record.prompt,
      executionMode: 'agent', source: 'user', ...timing, status: record.status === 'active' ? 'active' : 'expired',
      agentKind: target.view.agentKind, workspaceKind: 'dialogue', workingDir: target.view.workingDir, targetSessionId: record.sessionId,
      useWorktree: false, persistentSession: false, silentWhenIdle: false, notify: { desktop: false, feishu: false, wecomGroup: false },
      ...(record.status === 'active' ? { nextFireAt: record.scheduledAt } : {}),
      ...(typeof record.lastDelivery?.deliveredAt === 'string' ? { lastFiredAt: record.lastDelivery.deliveredAt } : {}) };
  }
  function idValid(id) { if (typeof id !== 'string' || !id || id.length > 512) throw bad('An exact reminder identity is required'); }
  async function lookup(id, context) { idValid(id); const entry = (await context.catalog()).find(entry => reminderWireId(entry.id) === id); if (!entry) return undefined; const binding = await context.target(entry.sessionId); return binding ? { entry, binding } : undefined; }
  async function list(filter, options = {}) {
    filter ??= {}; if (typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).some(key => key !== 'status') || filter.status !== undefined && !['active', 'expired', 'paused'].includes(filter.status)) throw bad('Invalid reminder list filter');
    if (filter.status === 'paused') throw unavailable('Native reminders have no paused state');
    return scoped(options, async context => { const result = []; let bytes = 2;
      for (const record of await context.catalog()) {
        if (filter.status !== undefined && filter.status !== (record.status === 'active' ? 'active' : 'expired')) continue;
        const binding = await context.target(record.sessionId); if (!binding) continue;
        const value = project(record, binding);
        bytes += Buffer.byteLength(JSON.stringify(value)) + 1; if (bytes > maxBytes) throw unavailable('Native reminder list exceeds the response byte budget'); result.push(value);
      } return result;
    });
  }
  function fit(value) { if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw unavailable('Native reminder exceeds the response byte budget'); return value; }
  async function get(id, options = {}) { idValid(id); return scoped(options, async context => { const found = await lookup(id, context); return found ? fit(project(found.entry, found.binding)) : null; }); }
  async function validateTarget(body, id, context) {
    if (typeof id !== 'string' || !id.trim()) throw unavailable('An already existing target session is required');
    if (body.targetSessionId !== undefined && body.targetSessionId !== id) throw unavailable('Native reminder binding cannot be changed');
    const binding = await context.target(id); if (!binding) throw refusalError('NOT_FOUND', 'No visible ordinary target session');
    if (binding.view.status && binding.view.status !== 'active') throw unavailable('The target session is not active; no wake or rebind is performed');
    if (body.agentKind !== undefined && body.agentKind !== binding.view.agentKind) throw unavailable('Agent kind must match the target alias; reminders never switch engines/models');
    if (body.workingDir && body.workingDir !== binding.view.workingDir) throw unavailable('Working directory must equal the existing target; it cannot be changed by a reminder');
    if (Buffer.byteLength(JSON.stringify(body)) + Buffer.byteLength(JSON.stringify(binding.view.workingDir ?? '')) > maxBytes - 8192) throw unavailable('Reminder write exceeds the bounded response/readback budget');
    return binding;
  }
  function timing(body, existing) {
    const previous = existing ? recurrence(existing) : undefined;
    const interval = own(body, 'intervalMs') ? body.intervalMs : previous?.intervalMs;
    if (typeof interval === 'number') return { kind: 'every', every_seconds: interval / 1000 };
    if (existing && !['cronExpr', 'timezone', 'intervalMs'].some(key => own(body, key))) return undefined;
    const expression = canonicalCron(body.cronExpr ?? previous?.cronExpr); const timezone = body.timezone ?? previous?.timezone;
    if (existing && expression === canonicalCron(previous?.cronExpr) && timezone === previous?.timezone && previous?.intervalMs === undefined) return undefined;
    if (!expression || expression.split(' ').length !== 5 || typeof timezone !== 'string' || !timezone.trim()) throw unavailable('Writable cron needs a native five-field rule/timezone; clearing an interval requires an explicit cron rule');
    return { kind: 'cron', cron: { expression, time_zone: timezone } };
  }
  async function once(operation, id, body, options, action) {
    const fingerprint = createHash('sha256').update(JSON.stringify([operation, id, fields.filter(key => own(body, key)).map(key => [key, body[key]])])).digest('hex');
    if (options.requestKey !== undefined && (typeof options.requestKey !== 'string' || options.requestKey.length > 2048)) throw bad('Invalid reminder request receipt key');
    const key = options.requestKey === undefined ? undefined : epoch + ':' + options.requestKey;
    for (const [key, item] of receipts) if (!item.pending && now() - item.at > receiptTtlMs) receipts.delete(key);
    let receipt = key === undefined ? undefined : receipts.get(key);
    if (receipt && receipt.fingerprint !== fingerprint) throw bad('A reminder envelope was reused with different arguments');
    if (!receipt) {
      if (key !== undefined && receipts.size >= receiptLimit) { const oldest = [...receipts].find(([, value]) => !value.pending); if (!oldest) throw unavailable('Native reminder write receipt budget is busy'); receipts.delete(oldest[0]); }
      receipt = { fingerprint, epoch, pending: true, at: now(), nativeId: undefined };
      receipt.promise = scoped(options, context => action(context, receipt)).then(value => { receipt.pending = false; receipt.at = now(); return value; }, error => { receipt.pending = false; receipt.at = now(); throw error; });
      if (key !== undefined) receipts.set(key, receipt);
    }
    try { const value = await receipt.promise; if (disposed || receipt.epoch !== epoch) throw unavailable('Reminder source changed after native admission'); return value; }
    catch (error) {
      if (operation === 'create' && receipt.nativeId) throw unavailable('Native reminder created id=' + reminderWireId(receipt.nativeId) + '; do not repeat creation; refresh the catalog. ' + String(error?.message ?? error));
      throw error;
    }
  }
  async function create(value, options = {}) {
    const generation = epoch; const body = input(value, true); const id = await once('create', '', body, options, async (context, receipt) => {
      if (typeof context.service.create !== 'function') throw unavailable('Native reminder creation is not composed');
      await validateTarget(body, body.targetSessionId, context); const rule = timing(body); context.check();
      const selector = rule.kind === 'every' ? { every_seconds: rule.every_seconds } : { cron: rule.cron };
      const record = await context.service.create(body.targetSessionId, { title: body.name, prompt: body.prompt, ...selector }, context.signal);
      if (typeof record?.id !== 'string' || !record.id) throw unavailable('Native reminder creation returned no identity; refresh before retrying');
      receipt.nativeId = record.id; return record.id;
    });
    try {
      if (disposed || generation !== epoch) throw unavailable('Native reminder source changed after creation');
      const result = await get(reminderWireId(id), options);
      if (disposed || generation !== epoch || !result || result.targetSessionId !== body.targetSessionId) throw unavailable('Native reminder is no longer visible under the original binding/source');
      return result;
    }
    catch (error) { throw unavailable('Native reminder created id=' + reminderWireId(id) + '; do not repeat creation; refresh the catalog. ' + String(error?.message ?? error)); }
  }
  async function update(id, value, options = {}) {
    const generation = epoch; idValid(id); const body = input(value, false);
    await once('update', id, body, options, async context => {
      if (typeof context.service.update !== 'function') throw unavailable('Native reminder update is not composed');
      const found = await lookup(id, context); if (!found) throw notFound();
      const { entry } = found; if (entry.status !== 'active') throw unavailable('schedule_ended: native reminder is inactive');
      if (entry.kind === 'at' || entry.kind === 'after') throw unavailable('Existing one-time reminders are read/delete-only; no conversion to recurring');
      await validateTarget(body, entry.sessionId, context); const change = timing(body, entry);
      const { sessionId, status: _status, lastDelivery: _delivery, ...expected } = entry;
      const result = await context.service.update({ sessionId, id: entry.id, expected, ...(change ? { change } : {}), ...(body.name !== undefined ? { title: body.name } : {}), ...(body.prompt !== undefined ? { prompt: body.prompt } : {}) }, context.signal);
      if (!result || typeof result.updated !== 'boolean' || !result.record) throw unavailable(String(result?.code ?? 'native_update_failed') + ': ' + String(result?.message ?? 'refresh before retrying; no unconditional overwrite is attempted'));
      return entry.id;
    });
    if (disposed || generation !== epoch) throw unavailable('Native reminder source changed after update; refresh rather than blindly retry');
    const result = await get(id, options); if (disposed || generation !== epoch) throw unavailable('Native reminder readback source changed'); if (!result) throw notFound(); return result;
  }
  async function remove(id, options = {}) {
    idValid(id); await once('delete', id, {}, options, async context => {
      if (typeof context.service.delete !== 'function') throw unavailable('Native reminder deletion is not composed');
      const found = await lookup(id, context); if (!found) throw notFound();
      const result = await context.service.delete({ sessionId: found.entry.sessionId, id: found.entry.id }, context.signal);
      if (result?.deleted !== true) throw notFound(); return found.entry.id;
    }); // Existing protocol returns void; it never reports success for deleted:false.
  }
  function onChange(listener) {
    if (disposed || typeof subscribeChanged !== 'function') return () => {};
    let closed = false; const stop = subscribeChanged(() => { if (!closed && !disposed && typeof getService()?.catalog === 'function') listener({ type: 'ready' }); });
    const close = () => { if (!closed) { closed = true; observers.delete(close); if (typeof stop === 'function') stop(); } }; observers.add(close); return close;
  }
  function cancelAll() { epoch++; for (const controller of active) controller.abort(); }
  function dispose() { disposed = true; cancelAll(); for (const close of [...observers]) close(); }
  return { list, get, create, update, delete: remove, onChange, cancelAll, dispose };
}
