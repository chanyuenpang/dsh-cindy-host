# ADR: DSH's own packages are peer dependencies, and only exported names may be imported

## Context

`0.1.1` was published as a GitHub Release tarball and it **breaks the profile it is installed
into**. Measured on a fresh `DSH_HOME` with a `--from-default-profile web` profile:

```
dsh plugin --profile <p> add dsh-cindy-host-demo-0.1.1.tgz    → exit 0   (it installs)
dsh --profile <p> --dump-config                               → exit 0   (it composes)
dsh --profile <p> --no-open --port <port>                     → dies:
  @deepseek-ai/dsh-client-file-upload
    ctx.commands.registerFileReceiptResolver is not a function
```

The install succeeded, the composition succeeded, and only *loading* failed — and DSH treats a
failed loader entry as fatal, so the whole profile is down.

The cause was ours, and it was two layers deep:

1. `package.json` declared `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-settings` as
   `dependencies`, and `@deepseek-ai/dsh-host-apiproxy` as an `optionalDependency`.
   `dsh-host-apiproxy@0.1.1-rc.2` depends on **28 `@deepseek-ai/*` packages at `^0.1.1-rc.2`**, and
   **pnpm installs optional dependencies by default** — so a whole old DSH generation was written
   into the profile (measured: profile-local `@deepseek-ai` went from 0 to 21 packages, all
   `0.1.1-rc.2`) next to the host's own `0.1.5-rc.2`. A composition holding two generations of one
   module graph fails at load: `file-upload` got the other generation's `ctx.commands`, and the
   `session` entry's 0.1.1 `dsh-session` imported the host's 0.1.5 `dsh-llm`, which has no `CallId`.
2. The reason those packages were declared at all: the code imported
   `settingsNamespace` from `@deepseek-ai/dsh-settings`, and **that export only exists in
   `0.1.1-rc.2`**. `0.1.5-rc.2`'s export surface is `SettingsProvider`, `SettingsConflictError`,
   `redactSecrets`, `default` (verified by importing it). The plugin had been loading by dragging
   the old generation in.

Two diagnostics made this hard to see, and both are worth keeping:

- **The failing stack named DSH's own packages**, so the first conclusion was "a DSH-side defect,
  not ours" — written into `doc/publishing.md` §5.4 as such. A stack frame naming someone else's
  package does not say who supplied the copy of it that failed; that question ("where did this
  resolve from, and which generation is it?") is the one that settles blame.
- **"`file:` installs fail, `link:` installs work" looked like a property of the install form.**
  The real variable was whether pnpm had actually resolved our dependency graph into the profile:
  the `link:` run that "worked" printed `resolved 71, reused 1, added 0` — it did nothing.

## Decision

1. **No `@deepseek-ai/*` package appears in `dependencies` or `optionalDependencies`.** Every DSH
   package the plugin uses is a `peerDependency`, so the host supplies it and no generation can be
   duplicated. `@deepseek-ai/dsh-host-apiproxy` is additionally
   `peerDependenciesMeta.optional: true`, because current DSH does not mount it at all.
   `dependencies` holds only libraries the host does not provide (`keytar`, `ws`).
2. **Peer ranges must cover the host's generation.** Under semver's prerelease rule
   `^0.1.1-rc.2` cannot match `0.1.5-rc.2` (the comparator's `[major,minor,patch]` must be equal),
   so an OR range is required: `^0.1.1-rc.2 || ^0.1.5-rc.2`. The ecosystem does the same —
   `dsh-codex` peers at `^0.1.5-rc.2`, `dsh-cost-meter` at
   `^0.1.0-rc.6 || ^0.1.1-0 || ^0.1.2-0 || ^0.1.3-0 || ^0.1.5-0`.
3. **Import only names the current host actually exports.** If a helper is missing, inline the
   behaviour where it is small (as with `settingsNamespace`, a brand: validate
   `/^[a-z][a-z0-9-]*$/` and return the string) instead of pinning an older DSH to get it.
4. **A clean-install gate must prove loading, not composition.** `--dump-config` passing says
   nothing about whether an entry can be imported — `0.1.1` composed perfectly and could not load.
   The gate is: install into a brand-new `DSH_HOME`, assert `profile-local @deepseek-ai == 0`, then
   **start it and read `/api/dsh-cindy-host/status`**.

## Alternatives

- **Keep the DSH packages as `dependencies` but pin the current generation
  (`0.1.5-rc.2`)** — rejected: it duplicates modules the host already provides, and it becomes
  wrong for every other host version, which is the failure this ADR exists to prevent.
- **Leave `dsh-host-apiproxy` in `optionalDependencies`** — rejected: pnpm installs optional
  dependencies by default, so "optional" bought nothing; it was the 28-package entry point.
- **Import `settingsNamespace` dynamically and degrade when absent** — rejected: the settings
  namespace is not optional to this plugin (the card and the flags both register through it), so
  the degradation path is "the plugin does nothing". Inlining three lines is strictly better.
- **Detect a mixed-generation tree at startup and refuse to mount** — rejected as a cure for a
  self-inflicted wound: the plugin must not create that tree in the first place, and paying for a
  runtime check on every host to keep a packaging mistake honest is the wrong trade.

## Consequences

- Installing this plugin adds **nothing** to the profile's `@deepseek-ai` tree, so it cannot
  poison the host's composition regardless of the host's version. Verified on a fresh
  `DSH_HOME`: `profile-local @deepseek-ai = 0`, `dsh web` starts,
  `/api/dsh-cindy-host/status` → `200 installed=true`.
- **A DSH upgrade can break the plugin at load time without changing a line of our code** — an
  export we import can disappear, exactly as `settingsNamespace` did. The release checklist
  therefore keeps a hard step: install into a clean home and start it, on the DSH version you
  claim to support (`doc/publishing.md` §5.6).
- `0.1.1`'s tarball stays published and stays defective; the CHANGELOG and README say so rather
  than quietly replacing it, because anyone holding it needs to know not to install it.
- The plugin owns three lines of a DSH helper now. It is a brand with a pattern, and the pattern
  is the contract; if DSH's pattern changes, `test/host-settings.test.js` and the settings
  registration are where it will show.

## Decision evolution

<!-- dated: 2026-09-30 -->
### `dsh-host-apiproxy` left `peerDependencies` entirely, so "declare it optional" stopped being the rule

Decision 1 said the apiproxy package is "additionally `peerDependenciesMeta.optional: true`",
and that was right for the host generation it was written against. DSH 0.2 deleted the package,
and declaring it at all became actively harmful. `unmetRequirements` in
`@deepseek-ai/dsh-app-boot` walks **every** `peerDependencies` key whose name is
`@deepseek-ai/dsh` or starts with `@deepseek-ai/dsh-`, and compares each range against the runtime
version — it **never consults `peerDependenciesMeta`**. So an optional-marked peer is still a hard
requirement: its presence rejected the whole plugin at install time (`installation rejected`) and
got the bundle silently skipped at boot, so the `dsh-cindy-host` row never appeared. Fixed in
`132da4d` by removing the peer and keeping the adapter as a lazy `createRequire` with a
failure-degrades-to-nothing path (`src/dsh-plugin.js`).

`package.json` now carries a `//peerDependenciesMeta` note recording that the field is absent on
purpose. Two details that make the rule exactly as wide as it needs to be:

- The walk only covers `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers. `@deepseek-ai/schemastery`
  is a peer this check never examines, which is why it can carry a plain `^3.18.1` range.
- An own `engines.dsh` range would decide compatibility **alone**, ignoring peers entirely. This
  plugin deliberately does not set one: the peers are the claim we verified per package, and a
  single hand-written DSH range would silently assert more than the tests cover.

The general instruction therefore survives, but narrower than it reads above: **for libraries the
host does not provide**, `peerDependencies` + `peerDependenciesMeta.optional` is how you say "use
it if the host has it"; **for `@deepseek-ai/dsh*`**, the peer key must not exist at all unless the
plugin genuinely requires that package, and an optional seam is expressed by removing the peer
(decision 1) plus a lazy, failure-tolerant load.

