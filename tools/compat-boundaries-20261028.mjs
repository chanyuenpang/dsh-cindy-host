/** Explicit unavailable features, not claims of client support or successful execution. */
export const UNSUPPORTED_INVOKES = new Map([
  ['agent-island:task-activity', 'No Cindy Agent Island snapshot producer is composed; DSH session activity uses its existing session projection.'],
  ['maker:list-plugin-engines', 'Cindy plugin engines have no registry in this Host. The mobile catalog falls back to an empty plugin-engine list on refusal.'],
  ['maker:refresh-plugin-engines', 'There is no Cindy plugin-engine registry to refresh; the mobile refresh tolerates refusal.'],
  ['maker:get-plugin-engine-usage', 'Cindy plugin-engine subscription usage has no corresponding owner in DSH; it is separate from native session usage.'],
  ['model-groups:get', 'This Host does not own Cindy model-group policy. The mobile catalog falls back to no model groups on refusal.'],
  ['model-groups:resolve', 'Cindy model-group resolution requires the controlled device policy store; native DSH model selection is separate.'],
  ['model-groups:commit', 'This Host produces no Cindy model-group decision receipt that it could commit.'],
  ['model-groups:bind-session', 'This Host does not store Cindy model-group bindings on DSH sessions.'],
  ['model-groups:route-note', 'This Host does not write Cindy model-group routing notes into DSH history.'],
  ['device-link:agent-net-switch:v1', 'No remote agent network/proxy switching adapter is exposed; native DSH network policy is not overridden.'],
  ['maker:settings:navigate', 'Remote Cindy settings navigation is not a DSH settings mutation or UI-navigation contract.'],
  ['maker:subscription-accounts', 'No Cindy subscription-account pool or credential-routing registry is exposed.'],
  ['maker:subscription-pool:quota', 'No provider subscription-pool quota contract is mapped; session usage and model catalogs are not account quota.'],
  ['maker:worker-roles:get', 'No Cindy worker-role registry is hosted; native subagent reads do not implement team role management.'],
  ['maker:worker-roles:apply', 'No Cindy worker-role mutation adapter is hosted.'],
  [
    "agent-island:completion-action",
    "No native agent-island completion action registry is owned by this adapter."
  ],
  [
    "ghosts:composer-list",
    "No Cindy Ghost composer resource registry is composed on this Host; plain sends remain separate."
  ],
  [
    "local-db:project-aliases:list",
    "Project aliases are a Cindy sidebar store, not a DSH session property; do not fabricate alias data."
  ],
  [
    "local-db:task-tags:execute",
    "No task-tag mutation store or execution service is provided by this adapter."
  ],
  [
    "maker:agent-task:stop",
    "Cindy agent-task handles are not DSH session IDs; session stop remains the separate supported input:stop."
  ],
  [
    "maker:background-task:output-tail",
    "No Cindy background-task handle/output store is exposed."
  ],
  [
    "maker:get-context-window-bounds",
    "No writable Cindy context-window budget subsystem is exposed; context usage reads remain independent."
  ],
  [
    "maker:set-context-window-budget",
    "No DSH context budget writer is wired; refusing must not claim a changed model limit."
  ],
  [
    "maker:images:retry",
    "This Host does not own Cindy generated-image delivery jobs to retry."
  ],
  [
    "maker:input:cancel-usage-limit-wait",
    "No automatic usage-limit wait state is advertised or stored by this Host."
  ],
  [
    "maker:mcp-apps:v1",
    "No embedded Cindy MCP-app lifecycle or UI channel is hosted."
  ],
  [
    "maker:provider-share:received-catalogs",
    "Model lists are derived from DSH modelCatalog, not a provider-share receipt store."
  ],
  [
    "maker:review:start",
    "No Cindy review snapshot/finding workflow is provided by this adapter."
  ],
  [
    "maker:session-background-activity",
    "No Cindy agent/background task activity registry is provided."
  ],
  [
    "maker:session-background-tasks:stop",
    "No Cindy background-task identifiers are accepted; ordinary DSH turn stop stays separate."
  ],
  [
    "maker:session:handoff",
    "No cross-session Cindy handoff/import pipeline is provided."
  ],
  [
    "maker:session:prewarm",
    "No Cindy prewarm service is composed; normal ensureAgent on supported sends remains intact."
  ],
  [
    "maker:side-chat:list:v1",
    "No Cindy side-chat thread store is hosted."
  ],
  [
    "maker:side-chat:v1",
    "No Cindy side-chat lifecycle or send service is hosted."
  ],
  [
    "maker:turn-change-set:apply",
    "No Cindy turn-change-set transaction or filesystem mutation contract is implemented."
  ]
]);
export const UNSENT_PUSHES = new Map([
  ['subscription-accounts:changed', 'No subscription-account pool is exposed or mutated, so no account-pool changed push is fabricated.'],
  [
    "local-db:sessions:list",
    "The Host answers list invokes and emits lifecycle/activity patches; it has no separate bulk-list push."
  ],
  [
    "local-db:task-tags:changed",
    "No task-tag mutation API is served, so no tag changes can be announced."
  ],
  // maker:history-work-patch is implemented by the native live delivery path;
  // its lease/base-revision safety is covered in host-native-sync.test.js.
  [
    "maker:orca:worker-changed",
    "No Cindy Orca worker registry is composed."
  ],
  [
    "local-db:project-aliases:changed",
    "No project-alias mutation store is exposed."
  ]
]);
