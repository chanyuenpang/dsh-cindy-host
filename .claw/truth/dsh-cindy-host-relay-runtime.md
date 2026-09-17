# DeviceLink relay runtime and connection state

<!-- state: current -->
## Current behavior

`src/host.js` owns the Cindy DeviceLink connection for this Host. The switch in the
settings card is the only user control; the runtime starts disconnected and prints
nothing. Relay endpoint: `wss://device-link.cindy.com.cn/api/device-link/ws`
(`RELAY_WS_URL`). Heartbeat: `HEARTBEAT_INTERVAL_MS = 20_000`.

Handshake and framing:

- `hello` carries this Host's identity and **must** declare
  `remoteControlEnabled: policy.isEnabled()`. The relay only routes
  `link-open`/`invoke` to a target that advertised `remoteControlEnabled: true`, so
  a Host that stays silent is invisible to the phone.
- `hello-ack` is the only identity the relay returns: `deviceId` and `userId`
  (protocol `HelloAckPayload` also carries `serverProtocolVersion` and optional
  `capabilities`). There is no pairing token.
- Outbound: `ping` every 20 s. Inbound: `ping`, `hello-ack`, `presence-changed`,
  `link-open`, `link-close`, `invoke`, `relay-error`.
- `link-open` is answered with `link-accept` and the controller is added to the
  accepted-controller set; `link-close` removes it. A listing-only controller never
  sends `link-open`, so an `invoke` from an unknown controller is itself treated as a
  link and named.
- An unanswered socket is dropped while the switch stays on, so the next attempt can
  reconnect instead of parking the state at `failed`.

Connection state vocabulary (five states, the same set the card renders):

| State | Meaning |
|---|---|
| `disconnected` | switch off, or nothing has started |
| `authenticating` | a Cindy session is being read, refreshed, or logged in |
| `waiting` | relay online (`hello-ack` received); no device has reached this Host |
| `connected` | a device opened a link to, or invoked, this Host |
| `failed` | a concrete failure; `message` names it |

`connected`/`waiting` are re-derived from the device ledger: `connected` when a
linked controller exists, otherwise `waiting` once this Host has its own
`deviceId`. A late frame cannot mask a real failure or flip a `disconnected`/
`failed` state back to connected.

Device ledger:

- Same-account devices arrive as `presence-changed` snapshots. Presence alone shows
  the device row but leaves the state at `waiting`, so the card can honestly say
  「等待手机连接」 while a phone is merely online.
- Devices that were already online never re-announce themselves, so after
  `hello-ack` the runtime performs one read-only
  `GET /api/device-link/devices` (derived from the relay URL by swapping `ws`→`http`
  and dropping `/ws`) to name the rows. A controller whose platform is still unknown
  is looked up once more.
- Because any same-account Cindy client is a valid controller, `connected` means "a
  Cindy client reached this Host", not "a phone reached this Host". Device rows
  always carry the platform so the card can distinguish a linked desktop.

Switch-off semantics (turning the switch off means torn down, not idled):

- `disconnect()` closes the socket, stops the projection, and clears the in-process
  subscriber set, the accepted-controller set, and the device ledger. The runtime
  keeps no idling projection: it exists to feed the phone.
- `stop()` is the plugin-teardown path: it calls `disconnect()` and returns the
  status to `disconnected`.
- After a switch-off the Host holds zero established sockets; this was observed
  live, not just asserted in unit tests.

Pitfalls:

- Declaring `remoteControlEnabled` from anything other than the user's own opt-in
  (`policy.isEnabled()`) would advertise remote control the user did not grant.
- A Host identity (`deviceId`) is required to render device rows; without a session
  the runtime reports `authenticating`/`failed`, never a fabricated connected state.
- The relay's own source is not in the Cindy checkout, so relay behaviour is taken
  from the shared protocol package both sides compile against.

Code anchors:

- `src/host.js` (`RELAY_WS_URL`, `HEARTBEAT_INTERVAL_MS`, frame switch, `disconnect`,
  `stop`, device-directory lookup)
- `src/host-status.js` (`HostStatus`, device ledger, state re-derivation)
- `src/authorization-policy.js`, `src/host-authorization.js` (who may control this Host)
- `src/cindy-sessions.js` (`handleInvoke` for accepted invokes)
- `src/projection.js`, `src/projection-read-model-sink.js`, `src/session-publisher.js`

Verification rules:

- `test/host.test.js` (relay frames, heartbeat, ordering, revoke, switch-off),
  `test/host-status.test.js`, `test/authorization-policy.test.js`,
  `test/projection.test.js`, `test/session-read-model.test.js` and
  `test/projection-read-model-sink.test.js` cover the runtime.
- Live check used for this Host: after switching on in an isolated profile the Host
  connected to the relay, received a real `deviceId`/`userId`, resolved real device
  names/platforms, and reported `connected` once a same-account client opened a link;
  switching off returned `disconnected` with 0 established sockets.
