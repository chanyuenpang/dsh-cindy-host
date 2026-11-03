# ADR: Keep regional authentication and network ownership in the Host

## Context

The settings page must support official domestic/international authentication, Apple/social browser login and enterprise SSO, including account selection, binding and secondary verification. These are distinct official outcomes, not interchangeable phone-code logins. An account token from the wrong realm or membership must never be sent to a mainland-default relay/media endpoint. Browser callbacks and concurrent login/logout/refresh also introduce secrets and late-result races that a settings form cannot safely own.

## Decision

Use a single installation-scoped backend authentication controller with attempt capability ID, revision, epoch and deadlines. Only whitelisted display projections cross the settings API. Keep continuation tickets, PKCE verifier, poll secret and resource tokens server-side; persist the selected resource session in the existing secure store under a serialized authenticated lease. Preserve existing credentials on failed refresh; explicit logout fences/drains writes before deletion. [Controller](<src/cindy-auth-controller.js>), [session owner](<src/auth-session.js>), [HTTP owner](<src/host-routes.js>).

Bootstrap new attempts from the two fixed official manifests and validate a realm-bound immutable endpoint snapshot. Do not infer realm from Apple/iOS/email, silently cross regions or treat partial organization discovery failure as absence. Use the official hosted callback with PKCE and independent hashed poll state. Only an empty manifest callback enables local ephemeral loopback; a hosted failure never downgrades. [Endpoint registry](<src/cindy-auth-endpoints.js>), [browser transport](<src/cindy-browser-auth.js>).

After a successful credential commit, replace the entire network runtime, not just the auth URL/socket. Every socket/directory/media/ICE/export/controller owner remains bound to its captured identity/network context; stale runtimes reject mismatching credentials. [Runtime binding](<src/host.js#L126-L172>), [replacement](<src/dsh-plugin.js#L1824-L1857>).

For ordinary-browser CAPTCHA code delivery, retain the official verification page and explicitly require manual pasting of its successful result URL when automatic cross-origin return is unavailable. Validate that result against the chosen official auth origin/path; never inject, proxy or bypass verification. [Proof handling](<src/cindy-auth-controller.js#L139-L185>), [UI explanation](<lib/client.js#L450-L454>).

## Alternatives

- Copy the Cindy/Electron app or read its private credentials: unnecessary and outside the Host integration boundary; reuse the public official auth protocol instead.
- Let the page retain tickets or implement independent continuation state: rejected because it duplicates the secret owner and permits stale-page/late-response races. Legacy direct-code endpoints remain compatibility-only, not the settings page's owner.
- Change only the auth base/relay socket: rejected because devices/media/ICE and old export/controller resources could retain the previous realm.
- Guess the region, fall back after partial discovery, or downgrade hosted failure to loopback: rejected because availability failure is not permission to change account or callback trust boundaries.
- Pretend a localhost CAPTCHA site key or cross-origin page inspection works: rejected because browser restrictions are real; full automation requires a verified official browser-safe return mechanism.

## Consequences

The page can complete all four protocol outcomes without owning credentials, but must handle revision conflicts, explicit takeover, region confirmation and the non-cancellable short commit boundary. Resource lifetime replacement is broader than socket reconnect and must preserve old-owner isolation. Credential serialization is in-process, not cross-process CAS. Manual CAPTCHA URL entry is less convenient and the URL is sensitive; this does not make Apple/enterprise SSO depend on CAPTCHA proof entry.

Maintain [controller](<test/cindy-auth-controller.test.js>), [browser callback](<test/cindy-browser-auth.test.js>), [vault lease](<test/auth-session-lease.test.js>), [route race/admission](<test/host-auth-routes.test.js>), [regional runtime](<test/host-auth-region.test.js>) and [settings](<test/client-card.test.js>) regressions. Current behavior and validation/activation limits are owned by [login Truth](<.claw/truth/dsh-cindy-host-login.md>) and [relay Truth](<.claw/truth/dsh-cindy-host-relay-runtime.md>). Offline protocol success is not real IdP or iOS acceptance, and publication/install/reload needs separate authorization.
