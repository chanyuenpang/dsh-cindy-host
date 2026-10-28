# DSH Cindy Host

A Host-side adapter connecting current Cindy clients to DeepSeek Harness.

## Requirements and installation

Version 0.1.27 targets the verified **DSH 0.2.1-rc.3** service contracts, with **Node.js >=22.16**. Its DSH peer versions are pinned to this carrier to prevent an installer from mixing a newer prerelease SDK into the running host. The verified Desktop runtime includes Node.js 24.21. Install through the Desktop DSH plugin manager. CLI-managed profiles can use:

```sh
dsh plugin --profile <profile> add dsh-cindy-host@0.1.28
```

Reload the Host plugin after installation. A full DSH restart is separate. Keep existing Cindy sign-in, device identity and settings; do not run two Host processes with the same identity.

## 0.1.28: busy enqueue confirmation

A real DSH pending inbox occurrence remains in pendingQueue (or steeringQueueClientIds) in enqueue replies, pushes and polling until it is actually claimed or committed. Handing input to DSH is not delivery to the user turn. This fixes 0.1.27 empty follow-up projections overwriting the busy-queue acknowledgment on Android and desktop. Regression tests execute the current Android parser and stale-ACK authority handling, not just the durable outbox state machine.

## Current durable input delivery

- Implements input-delivery v1, not a legacy history-only fallback. Complete text and attachment bytes are held in a private, FULL-synchronous SQLite ledger **before enqueue acknowledgment**.
- Provides per-clientId pending/accepted/removed/unknown receipts and real chronological around/around-client-id history. Accepted means a real user event was flushed and verified through public persistent storage, not an empty inbox or an in-memory event.
- Serializes delivery and mutation, persists cancellation fences and clear boundaries, and keeps edited payloads recoverable. Existing editable Host names and the plain-text desktop queue fix remain.
- Lost acknowledgments and same-process reloads cannot blindly replay an uncertain admission. A verified dead-process recovery may rebuild missing input; cold inbox wake-up requires verified ownership and preserved FIFO. Mixed/uncertain recovery remains pending with diagnostics rather than fabricating success or duplicate input.
- The latest upstream mobile outbox implementation is exercised against Host RPC and SQLite, including same-session FIFO, ACK loss, cancellation, and its mandatory history-cache gate. This is not a claim of live handset acceptance.

The ledger lives under the active DSH profile state directory. Pending payloads and attachments are retained until persistent user-history verification or sealed cancellation; terminal identity fences do not expire silently. Do not delete state to repair an uncertain send. Back up that state before rollback: older Host releases cannot replay this ledger.

All changes are Host-only: no Cindy or DSH core patch is required. The handshake compatibility stamp is separate from the actual plugin version and explicit v1 capability. Unsupported optional features are refused; this is not a promise of all native Cindy features or exactly-once external tool effects.

## Previous release and rollback

0.1.26 added editable, locally persistent Host names and desktop-safe plain-text queue content. Reinstalling 0.1.26 is possible, but pause input first and preserve the 0.1.27 ledger: downgrading disables durable-input recovery until 0.1.27 is restored.
