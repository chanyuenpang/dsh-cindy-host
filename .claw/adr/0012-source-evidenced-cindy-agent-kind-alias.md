# ADR: Cindy agent-kind icons require an evidenced model source

## Context

Cindy's `agentKind` is a closed presentation vocabulary (`claude-code`, `codex`, `pi`),
while this Host runs a single DSH harness with independently selected models and providers.
The earlier single-`pi` alias made sessions with missing or ambiguous source data look like
confirmed DeepSeek sessions. A model name alone can be shared across catalog providers, so
an icon must not imply a source that the session cannot establish.

## Decision

Reserve `pi` for a confirmed DeepSeek provider, including when that provider's model is
unknown. Use `codex` for GPT/ChatGPT models with a confirmed non-DeepSeek provider. Use
`claude-code` for missing, unresolved, or conflicting sources, unknown models without a
confirmed DeepSeek provider, and other known models. Resolve a missing provider only from a matching catalog default route or a
unique model-to-provider match; with no session selection, the catalog default may supply
both. Apply the same classifier to session rows and create replies, deriving the reply from
the applied DSH selection rather than the controller's requested `agentKind`.

The roster advertises all three Cindy aliases for the same DSH harness. These labels
never select or change the underlying model route. The current behavioral owner is
`.claw/truth/dsh-cindy-host-new-session-runtime.md`; implementation anchors are
`src/cindy-session-row.js` (`agentKindForModel`) and `src/cindy-channels.js`
(roster, catalog, create reply).

## Alternatives

- Keep mapping every DSH session to `pi`: rejected because an unknown source then
  falsely appears to be confirmed DeepSeek.
- Infer DeepSeek or Codex from an ambiguous model name or the controller's draft kind:
  rejected because neither proves the session's applied provider/model selection.
- Treat the icon alias as a request to reroute a model: rejected because routing belongs
  to DSH's explicit selection, not to Cindy's display vocabulary.

## Consequences

Older and ambiguous sessions can display Claude even when their model name looks
familiar; this is deliberate uncertainty rather than a change in execution. Catalog
availability affects whether an otherwise provider-less model can be classified, so
a provider-less selection with missing catalog data must degrade to Claude instead of Pi.
Regression checks must cover source ambiguity, the DeepSeek precedence over a GPT-looking model, non-DeepSeek GPT,
unknown models, and the create-reply/session-row agreement. Version 0.1.13 shipped this
presentation change; upgrading the installed Web profile and restarting were required
before that running instance reflected it.
