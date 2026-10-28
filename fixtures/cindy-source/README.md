# Pinned Cindy regression fixtures

Source: https://github.com/makecindy/cindy/tree/1dba6f01eee35d5b2ead174f00c7524079c81383

These five unmodified TypeScript modules are test fixtures from Cindy, licensed under Apache-2.0 (see LICENSE in this directory). They are not part of the npm package and are not modified or compiled into the installed client. Tests perform type erasure/import relocation and provide storage, transport, React notification and unrelated I/O ports. The queue parsing and authority-epoch functions remain the upstream implementation. This preserves an offline, pinned regression for the busy ACK/push race.

The production Host remains MIT-licensed; these third-party test files retain their upstream Apache-2.0 license.
