import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDshSource } from '../src/dsh-plugin.js';

test('native source event ports use the Host-owned guarded subscription boundary', () => {
  const registrations = [];
  const services = { sessionController: { list: async () => ({ items: [] }) } };
  const ctx = {
    get: name => services[name],
    inject() { return () => {}; },
    on() { assert.fail('native event ports must not bypass the supplied Host boundary'); },
  };
  let disposed = 0;
  const seam = buildDshSource(ctx, 'sessionController', {
    subscribe(event, listener) {
      registrations.push({ event, listener });
      return () => { disposed++; };
    },
  });
  const stops = [
    seam.sessionArchive.onChange(() => {}),
    seam.reminders.onChange(() => {}),
    seam.projectOrder.onChange(() => {}),
  ];
  assert.deepEqual(registrations.map(entry => entry.event), ['domain/changed', 'schedule/changed', 'domain/changed']);
  assert.ok(registrations.every(entry => typeof entry.listener === 'function'));
  for (const stop of stops) stop();
  assert.equal(disposed, 3);
});
