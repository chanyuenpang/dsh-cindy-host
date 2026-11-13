# Cindy tool-call display projection

<!-- state: current -->
## Current behavior

The Host projects DSH tool calls into Cindy transcript rows. Cindy mobile uses `toolName` as the collapsed generic tool-row label; `input.description` remains available in expanded details. In `src/cindy-message-row.js` (`cindyToolName`), only an exact `run_code` call with a nonempty string `description` receives the read-only display alias `run_code · <preview>`. The preview is a single line, strips control and bidirectional formatting characters, collapses whitespace, and is limited to 120 Unicode code points (119 plus ellipsis when truncated). Missing, invalid, or empty descriptions fall back to `run_code`.

This alias is presentation-only: the original tool input, executable DSH message, and tool-use identity remain unchanged. Other tool names retain their vocabulary, including the `todo_write` → `TodoWrite` mapping used to select Cindy’s plan card. Live event folding and history row projection share this projection, keeping call/result pairing based on the unchanged tool-use ID.

Evidence anchors: `src/cindy-message-row.js` (`cindyToolName`, projection); `src/dsh-message-fold.js` (live folding); `test/cindy-tool-title.test.js` (object/JSON inputs, sanitization, bounded preview, fallback, other tool names, live/history parity and result identity). The source plan records targeted tests 57/57 and complete suite 1207 passed, 8 skipped, 0 failed, plus diff check; those are the reported run outcomes, not a claim of deployment. The source explicitly leaves Host deployment and Cindy handset acceptance pending.

## Native image projection and retrieval

Canonical and legacy DSH tool results, plus assistant-native image blocks, are projected into Cindy's existing image URL fields without changing source text or tool identity. The Host derives a deterministic `xdt-image://dsh-attachment/v1/...` locator from the exact source session, message, block path, and attachment content hash; the resolver reconstructs the descriptor from the currently visible source message rather than trusting caller-supplied paths or arbitrary JSON `localPath`. It validates the descriptor, hash, MIME and size before serving an inline thumbnail or staged original. This is a Host projection/transport feature; the native DSH service remains the authority for attachment bytes.

The project file browser separately exposes a bounded 256px WebP thumbnail while preserving its existing original-file route. Thumbnail failures do not remove original-file access. The attachment and file-thumbnail paths apply their own size/concurrency limits; stale source or connection generations must not return or cache old results.

Evidence anchors: `src/host-attachment-reference.js` (restricted deterministic locator), `src/host-attachment-media.js` (descriptor resolution and bounded thumbnail), `src/host.js` (fetch routing), `src/cindy-channels.js` (media fetch channel), `src/host-file-thumbnail.js` and `src/host-file-browser.js` (project file thumbnails). The completed source plan reports final `node --test`: 1229 passed, 8 optional integration tests skipped, 0 failed; it also records native Host PNG/JPEG conversion and package dry-run checks. This is test evidence, not deployment or handset acceptance. Deployment and phone verification remain follow-ups; the Cindy Markdown file-reader enhancement remains outside this Host-only change.

## Operational boundary

Changing the Host projection does not update an already installed or running Host. Do not claim the phone displays this behavior until a deployed Host and handset are verified. No Cindy client or DSH execution-tool change is required for the described projection.
