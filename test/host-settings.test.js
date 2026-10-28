import test from 'node:test'; import assert from 'node:assert/strict'; import { DEFAULT_HOST_SETTINGS, validateHostSettings, rememberedDeviceId, hostDeviceName } from '../src/host-settings.js';
test('defaults transport to disabled and validates explicit controller authorization settings',()=>{assert.equal(DEFAULT_HOST_SETTINGS.transportEnabled,false); assert.doesNotThrow(()=>validateHostSettings({transportEnabled:false,remoteControlEnabled:true,controllers:{phone:{state:'authorized'}}})); assert.throws(()=>validateHostSettings({transportEnabled:false,remoteControlEnabled:true,controllers:{phone:{state:'unknown'}}}));});

test('host names preserve legacy defaults and validate single-line Unicode labels', () => {
  assert.equal(hostDeviceName({}), 'DSH Host');
  assert.equal(hostDeviceName(DEFAULT_HOST_SETTINGS), 'DSH Host');
  assert.equal(hostDeviceName({ deviceName: ' 工作站 🖥️ ' }), '工作站 🖥️');
  for (const deviceName of ['', 'DSH Host', '家用电脑', 'a'.repeat(64), '🖥'.repeat(32)]) {
    assert.doesNotThrow(() => validateHostSettings({ ...DEFAULT_HOST_SETTINGS, deviceName }));
  }
  for (const deviceName of [null, 12, '  ', 'a'.repeat(65), '🖥'.repeat(33), 'a\nb', 'a\tb', '\u0000hi', 'hi\u0085']) {
    assert.throws(() => validateHostSettings({ ...DEFAULT_HOST_SETTINGS, deviceName }));
  }
});

test('remembers the relay device id, because the credential can disappear', () => {
  // A phone links to the Host's *device id*, not to its credential. Credentials
  // legitimately vanish — expiry, a fresh install, or the refresh failure that once
  // deleted one — and generating a fresh id in that moment re-pairs the Host as a
  // different device, leaving the phone's existing link dangling.
  assert.equal(rememberedDeviceId({ deviceId: ' dev-1 ' }), 'dev-1');
  assert.equal(rememberedDeviceId({}), '', 'an unset id means "never recorded", not a value');
  assert.equal(rememberedDeviceId({ deviceId: '   ' }), '');
  assert.equal(rememberedDeviceId(undefined), '');

  // The field is still schema-validated: a non-string id is refused rather than
  // silently ignored, because a corrupt document must not decide the Host's identity.
  assert.doesNotThrow(() => validateHostSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {}, deviceId: 'dev-1' }));
  assert.doesNotThrow(() => validateHostSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {} }));
  assert.throws(() => validateHostSettings({ transportEnabled: true, remoteControlEnabled: true, controllers: {}, deviceId: 42 }));
});
