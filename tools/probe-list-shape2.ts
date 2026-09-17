/**
 * Follow-up to probe-list-shape.ts: count the home pipeline's rows with the real
 * group field names, and show which stage drops a row for each shape.
 *
 * Run: G:\Projects\Cindy\node_modules\.bin\tsx.cmd tools\probe-list-shape2.ts
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

const served = toCindySessionList(SOURCE_ROWS, {
  device: { deviceId: DEVICE_ID, deviceName: DEVICE_NAME },
});
const flat = served.map((row) => row.session);

// The phone's device list entry, as DeviceLinkContext builds it.
const devices = [{ deviceId: DEVICE_ID, name: DEVICE_NAME, state: 'ready', available: true }];

function countHome(label: string, sessions: unknown[]) {
  for (const statusFilter of ['active', 'all'] as const) {
    const p = buildMobileHomePresentation({
      sessions: sessions as never,
      devices: devices as never,
      selectedDeviceId: DEVICE_ID,
      statusFilter,
    });
    const projects = p.projects as unknown as { items?: unknown[]; sessions?: unknown[] }[];
    console.log(`--- ${label} / statusFilter=${statusFilter} ---`);
    console.log(JSON.stringify({
      projectGroups: projects.length,
      firstGroupKeys: projects[0] ? Object.keys(projects[0]) : null,
      projectRows: projects.reduce((n, g) => n + ((g.items ?? g.sessions ?? []) as unknown[]).length, 0),
      chats: p.chats.length,
      pinned: p.pinned.length,
      deviceFilters: p.deviceFilters.map((d) => ({ deviceId: d.deviceId, available: d.available })),
      selectedDeviceId: p.selectedDeviceId,
      overview: p.overview,
    }, null, 2));
  }
}

countHome('A. as served (wrapped)', served as unknown[]);
countHome('B. flat (desktop contract)', flat as unknown[]);

// Device-detail page: the same rows under each status filter.
for (const [label, sessions] of [['A. wrapped', served], ['B. flat', flat]] as const) {
  const sections = buildRemoteSessionSections(sessions as never, Date.now(), { statusFilter: 'active' });
  console.log(`--- detail / ${label} / active ---`);
  console.log(JSON.stringify(sections.map((s) => ({ key: s.key, rows: s.data.length }))));
}
