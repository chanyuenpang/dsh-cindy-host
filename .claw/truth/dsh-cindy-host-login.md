# Non-interactive Cindy login and credential store

<!-- state: current -->
## Current behavior

A DSH Host has no TTY, so the readline fallback used by the CLI can never run in the
card. `src/cindy-login-flow.js` is the non-interactive login path shared by the card
and the runtime; `src/cindy-login.js` keeps the interactive terminal path for
`npm run login` / `npm run host`.

Non-interactive flow:

- `LOGIN_KINDS = ['phone', 'email']`. `validateIdentifier(kind, identifier)` rejects
  an unknown kind, an empty value, a phone that does not match
  `/^\+?[0-9][0-9\s-]{4,19}$/`, or an email that does not match
  `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- `requestLoginCode({ kind, identifier })` validates first and returns
  `{ ok: true, identifier }` after Cindy accepted the request, or `{ ok: false, message }`
  (`'验证码发送失败，请检查账号或网络'`) otherwise.
- `verifyLoginCode({ kind, identifier, code, deviceId })` requires a non-empty code
  and a `deviceId`; it maps Cindy's answers to values instead of exceptions:
  `select_account` returns `{ ok: false, status: 'select_account', accounts, loginTicket }`,
  `binding_required` and `sso_verification_required` return `{ ok: false, status, message }`,
  and any other unknown non-`ok` status returns a message naming it.
- A successful answer must contain string `accessToken` and `refreshToken`; otherwise
  the call returns `{ ok: false, message: 'Cindy 未返回登录凭据' }`. `expiresAt` is
  carried through only when present.
- `selectLoginAccount({ loginTicket, accountId, deviceId })` finishes the
  `select_account` branch.
- Default auth base URL is the China-mainland endpoint
  `https://auth.cindy.com.cn` (`MAINLAND_CINDY_AUTH_BASE_URL`). `CINDY_AUTH_BASE_URL`
  (via `normalizeAuthBaseUrl`) is an explicit override for a non-mainland environment;
  there is no implicit fallback between the two.

Session lifecycle (`src/auth-session.js`):

- `restoreSession()` loads the stored session and refreshes it. A rejected refresh
  token is dropped (`clearSession()`), so the card shows a login form instead of
  retrying a dead token forever; the failure reason is `missing` or `expired`.
- `adoptSession(session)` persists a session the card just established, minting a
  `deviceId` when Cindy did not supply one.
- `forgetSession()` clears the stored session; the next connect starts from the login
  form.
- The CLI path (`getAuthenticatedSession()`) reuses a stored session when it can and
  otherwise asks on the terminal.

Credential store (`src/credential-store.js`):

- Sessions live in the OS credential store through `keytar`, service `DSH Cindy Host`,
  account `session-v1`, as JSON. Tokens only ever travel between that store and the
  relay handshake; nothing prints them, and the card only ever sees booleans and a
  masked identifier.
- The OS credential store is shared across DSH profiles, so a session created by
  `npm run login` is visible to the disposable smoke profile too. The smoke profile
  itself only owns its settings document.

Pitfalls:

- Do not turn the `select_account` / `binding_required` / `sso_verification_required`
  answers into thrown transport errors: the card must render them as answers, and
  callers must be able to tell "Cindy said no" from "the request broke".
- Never log or return tokens over HTTP; the routes surface only `deviceId` and status.

Code anchors:

- `src/cindy-login-flow.js` (`LOGIN_KINDS`, `validateIdentifier`, `requestLoginCode`,
  `verifyLoginCode`, `selectLoginAccount`, `refreshStoredSession`)
- `src/auth-session.js` (`restoreSession`, `adoptSession`, `forgetSession`,
  `getAuthenticatedSession`)
- `src/credential-store.js` (`SERVICE`, `ACCOUNT`)
- `src/cindy-login.js` (CLI readline path, `MAINLAND_CINDY_AUTH_BASE_URL`)
- `src/host-routes.js` (login/verify/select-account/logout handlers)

Verification rules:

- `test/cindy-login-flow.test.js` covers identifier validation, `ok`/nested/flat token
  answers, and the `select_account` / `binding_required` / `sso_verification_required`
  branches; `test/cindy-login.test.js` and `test/cindy-sessions.test.js` cover the CLI
  path and session handling.
- Live check used for this Host: `POST …/login/request-code` with an empty identifier
  answered `400` without touching Cindy.
