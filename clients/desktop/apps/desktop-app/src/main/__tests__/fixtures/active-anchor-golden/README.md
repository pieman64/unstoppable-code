# Active-anchor V2 sidecar golden

Generated against unchanged `apps/desktop-app/src/main/lib/chat-transcript-log.ts` at commit `339153ab43be3a6895909afc24ee7cbf0a3a30e1` (`git rev-parse HEAD`, once). The one-shot generator ran as `node --import tsx "$TMPDIR/active-anchor-golden.generate.mjs"` from the repository root. It initialized `ChatTranscriptLog` in a fresh `mkdtemp` directory under private `TMPDIR`, wrote the hand-crafted input sidecar there, read it with `activeMessages()`, then called `writeActive(chatId, acceptedRows)` and copied the resulting sidecar bytes to the output fixture. Message payloads were produced by the existing delegation transcript projector; the output fixture is the log's actual write, not hand-authored JSON. The generator fixed `Date` only around `writeActive` for byte-stable output.

- `active-sidecar.input.jsonl`: V2 header revision `0`; two V2 message records, each with an extra record-level anchor `{ version: 1, runId, after, tie }`.
- `active-sidecar.output.jsonl`: captured `writeActive` output at revision `1`; same two message payloads and IDs, with record-level anchors dropped.
- `append-active-tail.intent.json`: a bounded append-with-active-suffix WAL payload using the old known `active-replace` kind and the new-only `appendCommittedCount` extension. Its payload hash is the SHA-256 of the two JSONL rows, `ready-run` followed by the unanchored active parent tail. `activeTailCount` is deliberately absent.
- `legacy-empty-index.json`: a checksummed V3 empty transcript index from before the optional `hasOrdinaryActiveRows` descriptor field was introduced. Anchor-free readers continue to accept it and omit that optional property from their descriptor.
- `anchored-index-with-ordinary-flag.json` and `anchored-index-with-ordinary-active-rows.json`: checksummed anchored-sidecar index fixtures (`hasActiveSidecar: true`) with `hasOrdinaryActiveRows: false` and `true`, respectively. The flag is present only because anchors exist; the anchor-free legacy fixture has no flag.
- Fixed output clock: `2026-10-08T12:34:56.789Z`.

Rows: card `delegated-agent-anchor-golden` (`delegated_agent_call` for delegation `anchor-golden`, generation 1); child `delegated-agent-anchor-golden:child-answer` (assistant text “Anchored child result.”, parent block is the card). The card anchor follows `parent-tool-call-1`; the child anchor follows the card; both anchors use numeric `tie: 0` (a signed safe integer) for their gap.

Expected replay assertions for the fixture: `activeMessages(chatId)` accepts the input and returns those two rows in order; `writeActive(chatId, rows)` succeeds; subsequent `activeMessages(chatId)` still returns the same rows; output bytes have header revision `1`, the same message records, and no record-level `anchor` fields. The one-shot generator did not change production source or test files.

`chat-storage-transactions.baseline-339153a.ts.txt` is the byte-for-byte 766-line
`apps/desktop-app/src/main/lib/chat-storage-transactions.ts` from baseline
commit `339153ab43be3a6895909afc24ee7cbf0a3a30e1` (SHA-256
`f71268cecbd77aa6cccc33f39f4417b8497533fb7d0005ae42ba5cf97b3395fc`).
`chat-transcript-log.baseline-339153a.ts.txt` is the byte-for-byte
`apps/desktop-app/src/main/lib/chat-transcript-log.ts` from that same commit
(SHA-256
`ce2bc15a62b8fc2acdad03cece60a877e9e0ce1f5cea3dd811c79f3555a78905`). The
snapshots use `.ts.txt` suffixes so tooling treats them as immutable fixture
data, not source modules. The compatibility tests transpile and execute both
source snapshots, verify each source hash, and wire the frozen transaction
module to the frozen log module.
The test therefore runs old `isPreparedWrite`, `recover`, `validatePrepared`,
`apply`, old `ChatTranscriptLog.replaceActive`, and WAL settle code—not a
handwritten predicate or the current log implementation. The snapshots' other
imports are shared runtime dependencies.

The frozen recovery tests exercise both anchored and unanchored suffix WALs,
old index reads with and without `hasOrdinaryActiveRows`, and old recovery
after new transcript-append checkpoints. They assert the old settle clears the
metadata journal and pending payload directory and that every payload row is
present once in the combined old committed-plus-active view. At the prepared
boundary old code keeps the whole payload active; after prefix append it
filters the identical committed echo and retains the remaining rows. The
reordered anchored-suffix cases use the frozen old module for recovery and
inspection too. A further old transaction append settles the unanchored rows
the old build kept active, and an old `active-replace` effect clears an active
sidecar through the frozen transcript log.

The explicit-zero append test uses these same hash-pinned transaction and log
snapshots. A new `append` with `activeTailCount: 0` publishes `active-replace`
with `appendCommittedCount` equal to the payload count and no `activeTailCount`
or anchors. Its interleaved anchored payload differs from the original
sidecar's physical order. Frozen recovery keeps every payload row active in
payload order without committing it; a later frozen parent-settle append
commits every row once and clears the sidecar and pending journal payloads.

`sparse-index-validator.baseline-339153a.ts` separately pins the unchanged
`isSparseIndexWithChecksum` predicate and `indexChecksum` implementation from
the same source commit. Its test verifies both the anchor-free legacy index
(no key) and the anchored optional-flag index (key present, checksum covers
it) are accepted. The full frozen log-source test also invokes the actual old
reader on those index files, recording acceptance without weakening checksum
verification.
