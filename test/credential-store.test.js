import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ACCOUNT, credentialAccount, defaultDshHome } from '../src/credential-store.js';

// The OS credential store is per (service, account) and there is one machine, so the
// account name is the only thing that can separate two DSH installations — and separating
// them is what gives each one its own relay device, and therefore its own task list.

test('the default installation keeps the account name it always had', () => {
  // The rule is "is this the default home", **not** "is `DSH_HOME` set". This deployment
  // sets `DSH_HOME=C:\Users\<user>\.dsh` explicitly, and a rule keyed on the variable being
  // present made the real installation boot with no session at all — the reported
  // "重启 dsh 貌似不会自动连接 cindy", offering a login form for an account already signed in.
  assert.equal(credentialAccount({}), DEFAULT_ACCOUNT);
  assert.equal(credentialAccount({ DSH_HOME: '' }), DEFAULT_ACCOUNT);
  assert.equal(credentialAccount({ DSH_HOME: '   ' }), DEFAULT_ACCOUNT);
  assert.equal(credentialAccount({ DSH_HOME: defaultDshHome() }), DEFAULT_ACCOUNT, 'the default home spelled out is still the default');
  assert.equal(credentialAccount({ DSH_HOME: `${defaultDshHome()}${process.platform === 'win32' ? '\\' : '/'}` }), DEFAULT_ACCOUNT, 'a trailing separator is not a different home');
  assert.equal(credentialAccount({ DSH_HOME: '~/.dsh' }), DEFAULT_ACCOUNT, 'a tilde expands to the same home');
  if (process.platform === 'win32') {
    assert.equal(credentialAccount({ DSH_HOME: defaultDshHome().toUpperCase() }), DEFAULT_ACCOUNT, 'Windows paths are case-insensitive');
  }
  assert.equal(DEFAULT_ACCOUNT, 'session-v1');
});

test('a different home gets its own entry, stably and without leaking a path', () => {
  const sandbox = credentialAccount({ DSH_HOME: 'G:\\Projects\\DSH-cindy-host\\.sandbox\\dsh-home' });
  assert.notEqual(sandbox, DEFAULT_ACCOUNT, 'a second installation must not present the same device as the first');
  assert.match(sandbox, /^session-v1@[0-9a-f]{12}$/, 'a digest, never the path itself');
  // Stable across calls (and across processes), or the login would never be found again.
  assert.equal(sandbox, credentialAccount({ DSH_HOME: 'G:\\Projects\\DSH-cindy-host\\.sandbox\\dsh-home' }));
  // Whitespace is not a different installation.
  assert.equal(sandbox, credentialAccount({ DSH_HOME: '  G:\\Projects\\DSH-cindy-host\\.sandbox\\dsh-home  ' }));
  // A different home is a different entry.
  assert.notEqual(sandbox, credentialAccount({ DSH_HOME: 'D:\\other-dsh-home' }));
  // The default home is an argument, not a constant of the machine: that is what makes the
  // rule testable without depending on where the test itself runs.
  assert.equal(credentialAccount({ DSH_HOME: 'D:\\other-dsh-home' }, 'D:\\other-dsh-home'), DEFAULT_ACCOUNT);
  assert.notEqual(credentialAccount({ DSH_HOME: join(homedir(), '.dsh') }, 'D:\\somewhere-else'), DEFAULT_ACCOUNT);
});
