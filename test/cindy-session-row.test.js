import test from 'node:test';
import assert from 'node:assert/strict';
import { toCindyActiveSessions, toCindySessionList, toCindySessionListRow } from '../src/cindy-session-row.js';

const ROW = {
  id: 'session-1',
  title: 'Fix the relay handshake',
  running: true,
  updatedAt: '2026-01-02T03:04:05.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  cwd: 'G:\\Projects\\DSH-cindy-host',
};
const DEVICE = { deviceId: 'dev-host', deviceName: 'DSH Host' };

/**
 * The four fields the controller filters and de-dupes on. They must sit at the
 * TOP LEVEL of the row: the controller never unwraps a `session` envelope, so a
 * nested identity is indistinguishable from a missing one and the row vanishes
 * without any error.
 */
const IDENTITY_FIELDS = ['id', 'status', 'deviceLinkDeviceId', 'deviceLinkDeviceName'];

test('emits a FLAT session row, never a view-model envelope', () => {
  const row = toCindySessionListRow(ROW, { device: DEVICE });
  assert.equal('session' in row, false, 'the wire shape is a flat RemoteSession; the controller never unwraps');
  for (const field of IDENTITY_FIELDS) {
    assert.ok(field in row, `${field} must be a top-level field`);
    assert.notEqual(row[field], undefined, `${field} must be defined`);
  }
});

test('carries the identity the controller de-dupes and filters on', () => {
  const row = toCindySessionListRow(ROW, { device: DEVICE });
  assert.equal(row.id, 'session-1');
  assert.equal(row.status, 'active', 'the default status filter is "active", so this decides visibility');
  assert.equal(row.deviceLinkDeviceId, 'dev-host', 'without this the row is dropped once the device is selected');
  assert.equal(row.deviceLinkDeviceName, 'DSH Host');
});

test('reports no display-model fields, which the controller derives itself', () => {
  const row = toCindySessionListRow(ROW, { device: DEVICE });
  for (const field of ['subtitle', 'detail', 'messagePreview', 'liveActivity', 'lastActivityAt', 'pendingInteractionCount', 'scheduleInfo', 'worktreeLabel']) {
    assert.equal(field in row, false, `${field} belongs to the controller's view model, not the wire`);
  }
});

test('fields the controller reads for grouping and labelling', () => {
  const row = toCindySessionListRow(ROW, { device: DEVICE });
  assert.equal(row.workingDir, 'G:\\Projects\\DSH-cindy-host');
  assert.equal(row.workspaceKind, 'project', 'a session with a working directory groups under its project');
  assert.equal(row.agentKind, 'pi', 'the wire kind must be one the controller can label');
  assert.equal(row.title, 'Fix the relay handshake');
  assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(row.updatedAt, '2026-01-02T03:04:05.000Z');
});

test('reports the session’s own effort, falling back only when it has none', () => {
  // DSH carries effort inside the model selection. A hardcoded "default" makes a
  // successful `maker:set-effort` look like it did nothing, because the composer
  // reads the current value from this row.
  assert.equal(toCindySessionListRow({ ...ROW, effort: 'high' }, { device: DEVICE }).effort, 'high');
  assert.equal(toCindySessionListRow(ROW, { device: DEVICE }).effort, 'default', 'a session that never chose keeps the honest placeholder');
});

test('a session with no working directory becomes a dialogue, not a broken project', () => {
  const row = toCindySessionListRow({ ...ROW, cwd: undefined }, { device: DEVICE });
  assert.equal(row.workingDir, null);
  assert.equal(row.workspaceKind, 'dialogue', 'the controller puts dialogue rows in the chats bucket');
});

test('falls back to the activity time when no creation time was read', () => {
  const row = toCindySessionListRow({ ...ROW, createdAt: undefined }, { device: DEVICE });
  assert.equal(row.createdAt, '2026-01-02T03:04:05.000Z', 'a required string field must never be undefined');
});

test('defaults and truncates titles the way the local read model does', () => {
  assert.equal(toCindySessionListRow({ ...ROW, title: undefined }, { device: DEVICE }).title, 'Untitled DSH task');
  assert.equal(toCindySessionListRow({ ...ROW, title: '   ' }, { device: DEVICE }).title, 'Untitled DSH task');
  assert.equal(toCindySessionListRow({ ...ROW, title: 'x'.repeat(300) }, { device: DEVICE }).title.length, 160);
});

test('a Host with no relay identity still answers with rows', () => {
  const row = toCindySessionListRow(ROW, {});
  assert.equal(row.deviceLinkDeviceId, null, 'absent, but present as a key so the shape is stable');
  assert.equal(row.deviceLinkDeviceName, null);
});

test('fold a listing without throwing on empty or malformed input', () => {
  assert.deepEqual(toCindySessionList(), []);
  assert.deepEqual(toCindySessionList(undefined), []);
  assert.equal(toCindySessionList([ROW], { device: DEVICE }).length, 1);
});

test('maker:list-active uses its own shape, not session rows', () => {
  const entries = toCindyActiveSessions([
    { id: 'a', running: true },
    { id: 'b', running: false },
    { id: 'c', running: true },
  ]);
  assert.deepEqual(entries, [
    { sessionId: 'a', isTurnRunning: true },
    { sessionId: 'c', isTurnRunning: true },
  ]);
  assert.deepEqual(toCindyActiveSessions(undefined), []);
});
