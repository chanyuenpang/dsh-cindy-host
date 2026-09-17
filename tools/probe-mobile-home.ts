/**
 * Diagnostic probe: run the phone's own home pipeline over the exact session row
 * this Host serves, and report how each stage treats it.
 *
 * "The phone shows nothing" is invisible from the Host — it answers `ok: true`
 * with N items and the UI is still empty. This feeds the real row through Cindy's
 * real code (`packages/maker-shared/src/mobileHome.ts`) so the stage that drops
 * it is identified instead of guessed.
 *
 * Run with Cindy's own tsx (it needs their TypeScript sources):
 *   G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-mobile-home.ts
 */
import { buildMobileHomePresentation } from 'file:///G:/Projects/Cindy/packages/maker-shared/src/mobileHome.ts';
import { buildRemoteSessionSections } from 'file:///G:/Projects/Cindy/packages/maker-shared/src/sessionList.ts';
import { toCindySessionList } from '../src/cindy-session-row.js';

/** The device identity the Host stamps on its rows (from `hello-ack`). */
const DEVICE_ID = 'dev-host';
const DEVICE_NAME = 'DSH Host';

/** The session shape this Host reads from `sessionController.list()`. */
const SOURCE_ROWS = [
  {
    id: 'session-32859d1e-301b-423a-b62b-06f86fd97ebe',
    title: 'hello',
    running: false,
    updatedAt: '2026-09-16T17:13:00.000Z',
    createdAt: '2026-09-16T17:12:00.000Z',
    cwd: 'G:\\Projects\\DSH-cindy-host',
    blank: false,
  },
];

const rows = toCindySessionList(SOURCE_ROWS, { device: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME } });
console.log('--- row we serve ---');
console.log(JSON.stringify(rows[0], null, 2));

const sessions = rows.map((row) => row.session);

/** Run the pipeline once and report what survived. */
function stage(label, options) {
  const presentation = buildMobileHomePresentation(options);
  const counts = {
    chats: presentation.chats.length,
    projects: presentation.projects.length,
    pinned: presentation.pinned.length,
  };
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(counts));
  console.log(`emptyKind=${presentation.emptyKind} rows=${counts.chats + counts.projects + counts.pinned}`);
  return counts;
}

// No device selected: is the row visible at all?
stage('no device selected', { sessions, devices: [], selectedDeviceId: null });

// The Host selected — the only way the user sees this device's sessions.
stage('our device selected', {
  sessions,
  devices: [{ deviceId: DEVICE_ID, name: DEVICE_NAME }],
  selectedDeviceId: DEVICE_ID,
});

// Selected, with the device list the phone actually holds (its own desktop too).
stage('our device selected, alongside another device', {
  sessions,
  devices: [
    { deviceId: DEVICE_ID, name: DEVICE_NAME },
    { deviceId: 'other-desktop', name: 'YOP' },
  ],
  selectedDeviceId: DEVICE_ID,
});

// The DEVICE DETAIL page uses a different builder than the home. This is the one
// the user actually opens when tapping the Host in the device list.
for (const statusFilter of [undefined, 'all', 'active'] as const) {
  const sections = buildRemoteSessionSections(sessions, Date.now(), statusFilter === undefined ? {} : { statusFilter });
  console.log(`--- device page builder (statusFilter=${String(statusFilter)}) ---`);
  console.log(JSON.stringify(sections.map((section) => ({ key: section.key, rows: section.data.length }))));
}
