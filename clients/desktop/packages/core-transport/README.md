# @canopy/core-transport

Portable Node binding layer for the Canopy core daemon wire: the `u32`
length-prefix codec, binding-level frames (D3 nonce handshake, ADR 2 bulk
channels), the `CanopyFramedConnection` contract with a `node:stream` `Duplex`
implementation, and `createInMemoryFramedPair()`. JSON-RPC envelopes and
operation schemas live in `@canopy/protocol/canopy-core`; binding frames live
here because they are not catalog operations. `./types` is browser-safe.
Accepting listeners may admit each channel open before notification, and the
granted caps respect a per-channel bytes-in-flight budget; readers return credit as chunks are consumed so writers wait at the negotiated window.

`runCanopyTransportConformance` (`src/conformance/`) is the doc 05 transport
suite every binding runs; cases that need a lane's lease registry, endpoint,
or kernel are registered as pending with their owning ticket.
`runCanopyJournalConformance` runs its cursor resume, replay, and
`snapshot_required` cases against any `CanopyJournalConformanceTarget`.
