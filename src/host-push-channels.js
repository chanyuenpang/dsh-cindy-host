/**
 * Every push channel this Host sends, and the code that sends it.
 *
 * This list lives in `src` rather than in a tool because two callers need the same
 * answer and had no way to share it: `tools/channel-audit.mjs` classifies the push
 * side of the wire (what the phone handles, what this Host sends, what it declines
 * and why), and `tools/acceptance.mjs` reports *coverage* — which of these channels a
 * run actually produced. A second copy would drift, and the drift would be invisible:
 * a channel added to the Host and forgotten here simply stops being audited.
 *
 * The value is the evidence for the claim, not a restatement of the code: each entry
 * names the function that emits the frame, so a reader can check the pairing.
 *
 * @module dsh-cindy-host/host-push-channels
 */

/** Push channel → the emitting path in this Host. */
export const HOST_PUSH_CHANNELS = new Map([
  ['maker:event', 'host.js announceTurnRunning/announceTurnIdle (turn boundaries)'],
  ['local-db:messages:created', 'host.js pushSessionMessage (live fold)'],
  ['maker:input:projection', 'host.js pushInputProjection (queue changes)'],
  ['maker:goal:status-changed', 'host.js pushGoalStatus + applyControlFrame (goal projection)'],
  ['maker:interaction-request', 'host.js askApproval/askUserQuestion'],
  ['maker:interaction-dismissed', 'host.js onDismissed (answered, timed out, withdrawn)'],
  ['local-db:sessions:created', 'session-publisher.publishLifecycle'],
  ['local-db:sessions:patched', 'session-publisher.publishLifecycle'],
  ['local-db:sessions:activity', 'session-publisher.publishActivity'],
]);

export default HOST_PUSH_CHANNELS;
