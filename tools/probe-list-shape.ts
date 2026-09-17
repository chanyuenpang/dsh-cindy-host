/**
 * Shape gate: does the exact array the Host serves on `local-db:sessions:list`
 * survive the controller's own render pipeline?
 *
 * Why this exists rather than an end-to-end check: the controller never
 * validates and never unwraps. It hands the raw invoke result to
 * `remoteSessionStore.setDeviceSessions` and de-dupes on `session.id`, so a row
 * with the wrong shape is not rejected — it silently becomes an empty list. A
 * green handset test is the only other symptom, and it takes a phone.
 *
 * Run with Cindy's own tsx (it imports their TypeScript sources):
 *   G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-list-shape.ts
 *
 * Exits non-zero when the shape this Host produces stops rendering.
 */
import { buildMobileHomePresentation } from 'file:///G:/Projects/Cindy/packages/maker-shared/src/mobileHome.ts';
import { buildRemoteSessionSections } from 'file:///G:/Projects/Cindy/packages/maker-shared/src/sessionList.ts';
import { toCindySessionList } from '../src/cindy-session-row.js';

const DEVICE_ID = '<host-device>';
const DEVICE_NAME = 'DSH Host';

const SOURCE_ROWS = [
  {
    id: 'session-32859d1e-301b-423a-b62b-06f86fd97ebe',
    title: 'Untitled DSH task',
    running: false,
    updatedAt: '2026-09-16T17:12:03.253Z',
    createdAt: '2026-09-16T17:12:03.253Z',
    cwd: 'G:\\Projects\\DSH-cindy-host',
    blank: false,
  },
];

/** The retired mistake, kept as a control: the view model must NOT cross the wire. */
const WRAPPED = [
  {
    session: { id: SOURCE_ROWS[0].id, title: SOURCE_ROWS[0].title, status: 'active', workingDir: SOURCE_ROWS[0].cwd },
    title: SOURCE_ROWS[0].title,
    lastActivityAt: SOURCE_ROWS[0].updatedAt,
    pendingInteractionCount: 0,
    scheduleInfo: null,
  },
];

/** Exactly what `cindy-channels.js` returns through `invokeResult()`. */
const served = toCindySessionList(SOURCE_ROWS, { device: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME } });
const devices = [{ deviceId: DEVICE_ID, name: DEVICE_NAME }];

function measure(sessions: unknown[]) {
  const selected = { sessions: sessions as never, devices, selectedDeviceId: DEVICE_ID };
  const home = buildMobileHomePresentation({ ...selected });
  const homeAll = buildMobileHomePresentation({ ...selected, statusFilter: 'all' });
  const detailActive = buildRemoteSessionSections(sessions as never, Date.now(), { statusFilter: 'active' });
  const rows = (sections: { data: readonly unknown[] }[]) => sections.reduce((n, section) => n + section.data.length, 0);
  // A project group carries its rows as `sessions` (the mobile wrapper maps
  // `project.sessions`), and a dialogue bucket is `chats`.
  const homeRows = (presentation: typeof home) => presentation.projects.reduce(
    (n, group) => n + ((group as unknown as { sessions?: readonly unknown[] }).sessions?.length ?? 0),
    0,
  ) + presentation.chats.length + presentation.pinned.length;
  return {
    home_rows: homeRows(home),
    home_empty: `${home.emptyKind} / ${home.emptyTitle}`,
    home_all_rows: homeRows(homeAll),
    detail_active_rows: rows(detailActive),
  };
}

const control = measure(WRAPPED);
const actual = measure(served as unknown[]);

console.log('--- control: the retired wrapped shape (must NOT render) ---');
console.log(JSON.stringify(control, null, 2));
console.log('--- actual: what this Host serves now (must render) ---');
console.log(JSON.stringify(actual, null, 2));

const first = served[0] ?? {};
console.log('--- identity the controller filters and de-dupes on ---');
console.log(JSON.stringify({
  id: first.id ?? null,
  status: first.status ?? null,
  deviceLinkDeviceId: first.deviceLinkDeviceId ?? null,
  deviceLinkDeviceName: first.deviceLinkDeviceName ?? null,
  has_envelope: 'session' in first,
}, null, 2));

const failures = [];
if (actual.home_rows !== 1) failures.push(`home rows = ${actual.home_rows}, expected 1 (device selected, default status filter)`);
if (actual.detail_active_rows !== 1) failures.push(`device page active rows = ${actual.detail_active_rows}, expected 1`);
for (const field of ['id', 'status', 'deviceLinkDeviceId', 'deviceLinkDeviceName']) {
  if (first[field] === undefined || first[field] === null) failures.push(`${field} must be a top-level, defined field`);
}
if ('session' in first) failures.push('the row still carries a `session` envelope; the controller never unwraps');
if (control.home_rows !== 0) failures.push(`the control shape unexpectedly rendered ${control.home_rows} rows; the control is no longer proving anything`);

if (failures.length > 0) {
  console.error('\nSHAPE GATE FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nshape gate passed: the served rows render, the wrapped control does not.');
