# Core runtime

`@canopy/core-runtime` provides the typed in-process dispatcher and portable
kernel primitives. It depends on the protocol package and Node built-ins;
host services and transport bindings belong in their adapters.

## Storage write policy

`@canopy/core-runtime/storage` exposes the manifest-backed writer policy and
`namespace_backup` record shape without loading the kernel. The ownership census
generates guarded rows for `required_before_flip`, `daemon`, and `offline`
namespaces. Writers supply an explicit principal; daemon rows accept only
`daemon`, legacy/interface-local rows accept their listed writers, and offline
rows refuse ordinary writes pending maintenance-lock authority.

The Node atomic writer checks its optional `storage: { namespace, writer }`
context before creating a sibling file. W5 caller adoption and the static import
boundary are separate legs; untagged existing writes retain their current path.
No ownership row changes here. Backup helpers validate metadata and require a
trusted host predicate proving the data-root-relative path is outside checkouts;
they perform no copy, digest verification, restore, or ownership transfer.

## W5 commit log

`@canopy/core-runtime/node/w5/commit-log` holds the W5 commit log (CAN-3805):
the SQLite library, its applier, the worker message contract and request
handler, and `ensureW5DataRoot`. It is never re-exported from `/node`, so
`node:sqlite` stays out of hosts that only import the barrel. The host supplies
a `W5DurabilityPort` (durable file writes and folder syncs); the package reads
no platform. `/worker-contract`, `/errors`, `/fingerprint` and
`/reservation-diagnostics` load without the database. The desktop composes the
worker and supplies atomic-file durability through
`@canopy/desktop-shared/node/w5-commit-log`.

## Event journal

`createEventJournal<E>({ epoch, maxEntries })` retains at most `maxEntries`
entries (default 1024). Each append receives an epoch-qualified, increasing
sequence. Cursor objects are copied on reads; event payloads remain owned by
the publisher and must not be mutated after publication.

`resume(cursor)` returns entries after a retained cursor. An omitted or null
cursor returns only the latest entry, for last-status replay. Foreign epochs,
evicted history, and future cursors return `snapshot_required`; an adapter
maps that result to its protocol error and refresh resource.

`subscribe(cursor, listener)` replays before live delivery, including entries
appended reentrantly by another listener. Its unsubscribe function removes the
listener. A throwing listener is removed without interrupting its peers.

## Operation manifest

`createOperationRegistry({ profile, definitions, owners })` validates explicit
ownership of every query, instruction, and stream definition. It rejects
duplicate names or claims, missing owners, unknown operations, and excluded
planes. The returned manifest and entries are frozen. Handler validation and
call admission remain the dispatcher's responsibility.

## Shutdown runner

`createShutdownSequence({ phases, now })` runs ascending phase IDs from 1–7.
Every phase has a finite, nonnegative deadline and receives an abort signal.
Failure or timeout is recorded before proceeding to the next phase. Repeated
`run(reason)` calls return the same promise and report the first reason.

Deadlines bound the wait for asynchronous hooks; hooks must cooperate with
abort to release their resources. The runner cannot interrupt synchronous
JavaScript or terminate a process tree itself. Host adapters supply those
actions and map the migration plan's shutdown steps to the phase hooks.

## Service container

`createServiceContainer({ profile, services, onChange })` validates plane
placement, unique names, dependencies, cycles, and required services depending
on optional ones. Startup follows stable dependency order, runs each service's
migrations before its start hook, and becomes ready only after startup settles
with passing health checks. Required failures reject startup and leave degraded
health; optional failures warn and block their dependents.

`health()` publishes changed snapshots through `onChange`. Startup is
idempotent. `markStopping()` aborts startup and publishes stopping health;
`stopPhase(3..7, signal)` invokes attempted services' cleanup in reverse order,
including after an expired deadline. Signals bound waits for asynchronous hooks;
hooks must cooperate with abort to release resources. Sequential startup has no
per-service deadline. The host assigns phase meanings and integrates cleanup
with the shutdown runner.

## Dispatcher lifecycle and journal cursors

`drainInstructions()` idempotently refuses new instructions while admitted work,
queries, and streams continue until `shutdown()`. It never reopens a closed
runtime.

A stream sink's `emitAt(cursor, item)` preserves canonical source cursors. The
first cursor establishes the stream's source epoch; later cursors must retain
that epoch and increase their sequence. Cursors are copied and validated;
mixing `emit` allocation with `emitAt` ends the stream with a handler error.

## Runtime composition

`createCanopyRuntime` composes the journal, manifest, container, and shutdown
runner around a host-built dispatcher. It adds the canonical
`core.runtime.health.get` query and `core.runtime.events` stream, owned by
`core.runtime`, and rejects host definitions that reuse those names. A
worker-only profile cannot host them, so it fails at construction. The host
supplies a stable `runtimeId`, `hostId`, and `authorityId`; the daemon epoch
is new per runtime and qualifies every runtime event cursor. Events stream
journal cursors through `sink.emitAt`. A missing cursor replays the latest
status. A foreign, expired, or future cursor ends the stream as
`core.runtime.snapshotRequired`, retryable after refreshing
`core.runtime.health.get`.

`createDispatcher(input)` receives the merged definitions and the runtime's
handlers; the host merges those into its concrete handler maps. The runtime
captures the dispatcher's `drainInstructions` and `shutdown` at creation, so a
host may wrap `shutdown` to call `runtime.shutdown(reason)`. Shutdown phases:
1 refuse new instructions; 2 publish `stopping`; 3 end event streams, close
the dispatcher, then always run service phase 3 hooks; 4 schedulers;
5 processes; 6 flush; 7 databases and physical transports.

Desktop composes this runtime while retaining the Phase 0A compatibility
adapters. Its tests run the reusable journal conformance cases against
`core.runtime.events` through a test-only framed bridge. No production physical
transport, endpoint, or handshake serves these operations yet.

`createRuntimeProfileGraph` requires `workerCaller` and `workerBinding` when
bundled `core+worker` modules install worker queries. The host supplies a
`WorkerBindingPair` with JSON-RPC send/receive endpoints, serialization,
bounded buffers, close signals, and any physical handshake. The graph runs the
worker dispatcher behind the server endpoint and proxies queries through the
client endpoint. Both interface and owning-core grants are checked. Unsupported
worker instructions and streams fail at graph construction; no direct-call
fallback exists. Query cancellation abandons the local wait and consumes the
late reply; deadlines and connection closure also bound worker execution.
The binding caps unanswered queries, undrained request sends, and concurrent
reply sends at 128 each. At most 128 replies wait for a send slot; closing
the binding releases those waiters. Host close must settle pending sends and
receives as well as aborting its connection signal.

The portable package imports no transport implementation. Its tests inject a
strict serializing adapter. C7 (CAN-3768) owns composing the real L0 framed
pair and running framed conformance in the daemon host. Desktop's existing
composition retains its direct worker handlers in Phase 1.
