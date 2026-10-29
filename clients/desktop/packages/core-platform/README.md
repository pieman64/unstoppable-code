# @canopy/core-platform

Selects the ADR 25 `PlatformServices` implementation for a host. Its host-adapter
contract is type-only in `@canopy/core-runtime`
(`src/platform/platform-services.ts`). This package is the only place
`process.platform` is read for it (`check-platform-boundary`).

Endpoint addresses, data roots and startup claims are trusted host-adapter
inputs. They stay at this in-process boundary; portable operation DTOs do not
carry them.

- `createPlatformServices(platform, endpoints, host)` composes services for
  `darwin`, `win32`, or `linux` with an injected endpoint provider. It fails
  closed with `PlatformServicesError`: `unsupported_platform` for any other
  platform, and `endpoint_semantics_mismatch` when the provider does not match
  the host policy (`filesystem-socket` on darwin and linux,
  `first-instance-pipe` on win32).
- `hostPlatformServices(endpoints, host)` does the same for the running host.

The optional trusted `host.windowsProcessPath` selects only the standalone x64
Windows process observer. Missing paths yield unverifiable live inspection;
composition does not discover paths or spawn probes. POSIX ignores this input.

Darwin, Windows, and Linux are supported composition targets.
`createPlatformEndpointServices(os, options)` provides the endpoints (C5b,
CAN-3932): POSIX sockets bind under a temporary name and are published by hard
link, so the bind result's `identity` receipt names the node at the path. A
refused probe unlinks only through `unlinkStale`, under a host-validated
startup claim and an identity re-check. Windows first-instance pipes are
created by the native addon in `native/windows-pipe` (CAN-3931): every pipe
instance carries an owner-only DACL from creation, the descriptor is
re-verified before accepting, and binds fail closed without the addon. Node's
own pipe server is never used on Windows because its default DACL grants
Everyone read access. Build it with `pnpm run build:windows-pipe-security`
(Windows only); `pnpm run test:windows-pipe-security` runs the native
cross-user suite and shared secured-pipe kits. Hosted qualification requires
**10 transport + 2 lease + 8 channel + N01–N08**, exact file/ancestry/title,
complete per-case teardown and reviewed source/inventory/addon digests;
unrelated passes cannot fill [inventory](../../scripts/lib/windows-pipe-inventory.json) gaps.
Late ownership permanently invalidates passing case and aggregate receipts.
Failed rewrites remove stale evidence and fail Jest—even after its final hook,
failed deletion, or caught I/O errors. Hosted `always()` cleanup still runs.
Portable hook tests do not establish native callback/authentication teardown.
T07–T11 are named reference-journal exclusions; T16 is the reference
protocol-major mismatch exclusion because production closure differs. The seven
pending declarations are named inventory-only exclusions, not qualifying skips.
The existing POSIX control-plane tests reuse extracted clock and consumers.

Shared-case limits: T02 checks framed IDs/payloads, not request promises; T14
cannot prove another channel's progress while blocked; L02 does not compare
registrations; C01 fabricates a foreign ID; C07 does not prove connection-wide
revocation; T15 wrong-root proves client challenge rejection only.

Normal runs require three prober journals, security observations and verified cleanup.
CAN-4598 remains incomplete without authorized Windows execution evidence;
cleanup rehearsals remain distinct from normal qualification. Packaged Windows
serving applicability is separately unqualified (CAN-3996).

## Scope

C2a (CAN-3763) supplies endpoint scaffolding; C2b (CAN-3851) adds permission
checks and directory syncing. C2b2 (CAN-3865) adds path resolution and regular-file
rename, including its source-state and retry regression coverage.
C2c (CAN-3852) adds child environment, launch options, tree signals and PID inspection.
C5b (CAN-3932) adds the endpoints; `bindCanopyDaemonEndpoint` in
`@canopy/core-runtime/node` coordinates them with the stale-owner proof.
Descriptor publication is CAN-3934.

The Jest contract in `src/__tests__/` checks per-OS selection, mismatched
providers, and preservation of the injected endpoint interface. Real-socket
suites cover the probe, bind, unlink, bounded streams, and stale-owner
recovery; pipe behavior is tested with a fake verifier.

## Secure files

`secureFiles.permissions` checks regular files or directories. Only `private`
permits use. POSIX restriction verifies owner and identity through a no-follow
handle, then sets 0600/0700. Darwin also clears extended ACLs through that
handle and verifies a native ACL/identity receipt; unavailable native checks
return `unverifiable`. Windows verifies current-user ownership and the
DACL without repairing it. SYSTEM and Administrators are permitted privileged
trustees. Unsupported ACL forms, unavailable identity and read failures fail
closed. Elevated files owned by Administrators are refused.

`secureFiles.rename` requires singly-linked regular sources and supports
replacement or atomic no-replace publication by hard link, with bounded Windows
lock retries that recheck source identity and shape. Existing targets
are preserved; unavailable hard links fail closed. `sourceState` distinguishes
removal, a retained original, a changed or absent source, and an unreadable
identity. It is an observation, not authorization to unlink the source pathname
later. Callers must supply private parent directories; identity checks narrow
races without eliminating them.

POSIX `secureFiles.syncDirectory` flushes and propagates errors, preserving a
flush failure if closing also fails. Windows returns `unsupported` without
flushing.

## Paths

`paths.appDataDir` uses injected home/environment inputs and host path rules,
including Linux XDG defaults. Windows rejects device namespaces and invalid leaf
names. Its runtime candidate has unverified permissions and is not an endpoint.
`runtimeDirectory` derives only `<explicit canonical data root>/runtime`;
branded root discovery stays with the existing host adapter. No storage, caller
or writer migrates here.

Contract tests use real files on the running host, per-host path tables and
injected Windows receipts. Native Windows ACL execution is gated to Windows;
macOS tests do not establish Windows verification. Cross-OS runtime evidence
remains required at the CAN-3729 join.

## Child supervision

`supervision.childProcessOptions` creates POSIX group leaders and hides Windows
consoles. Windows `owned` children join libuv's parent-exit job; `independent`
children detach. The launcher owns stdio and `unref()`. `childEnvironment` selects
home, temp and application-directory inputs through an allowlist and builds PATH
from explicit absolute directories plus system directories. Inherited PATH,
credentials, loaders and locale are omitted; invalid paths or conflicting
Windows key casing fail closed.

`killProcessTree` requires an owned, unreaped child (a group leader on POSIX).
It sends group TERM/KILL without bare-PID fallback, or forced `taskkill /t /f`.
`signaled` confirms delivery; `absent` observes only the root PID. Windows
traversal cannot recover already-orphaned descendants.

`inspectProcess` reports a versioned start identity, absence or unverifiable
observation: Linux boot ID/proc ticks in the same PID/time namespace, macOS
C-locale UTC `ps` time at one-second precision, or Windows native creation time.
Windows uses the trusted, source-built x64 `canopy-process-identity.exe`, not
PowerShell/CIM. `OpenProcess` uses limited-query and synchronize rights; zero-time
waits on the same handle bracket `GetProcessTimes`. The handle has one close owner.
Integer FILETIME normalization preserves `win32:v1:<pid>:<UTC yyyyMMddHHmmssffffff>`
with microsecond truncation, including rejection of default timestamps. This is
an incarnation snapshot, not authentication, signal authority or continuing liveness.
Legacy microsecond precision cannot guarantee uniqueness across clock discontinuities.

Commands and each Linux proc read retain cancellation and a four-second deadline.
Windows allows four outstanding observer children per host, shared across fresh
inspectors, with no queue and 64 KiB per-stream output limits. Aborted/timed-out
waiters retain admission until child close. Only a successful explicit no-process
receipt plus independent ESRCH confirms absence after initial presence; query,
access, wait, exit and malformed-output failures stay unverifiable. Windows PIDs
are restricted to 2..2147483647, matching Node's independent presence probe.
Missing/wrong helpers fail closed and composition never eagerly launches one.
The same helper's fixed `--token-user` mode backs `windowsPrincipalObserver`.
It shares that admission and returns the pinned canonical decimal SID, or
fails with `principal_unavailable`. Its receipt contract is in
[bundled runtime maintenance](../../docs/bundled-runtime-maintenance.md#windows-process-identity-helper).
Nothing calls it yet: Windows principal derivation still refuses and serving
remains unqualified (CAN-4576).
The historical windows-2022 failure and measured ARM VM PowerShell timeouts are
separate evidence; neither proves the other's cause. Native candidate qualification
must use cold local VM observations; Windows Server qualification remains outstanding.
Existing callers and the other five supervision methods remain unmigrated.

The historical CAN-4576 [test-only backend gate](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md)
rejects job membership/accounting alone as complete descendant evidence: permitted
breakaway can leave a live process outside an empty job. Its native handle-oracle
fixture targets control, contained, silent/explicit-breakaway and nested-job
launches without kill-on-close containment. On the local Windows 11 ARM64 VM it
compiled, then exited 3 with `unsupported_context` on the first childless control
before measured-root creation; Node/task exited 1. No pair or escape scenario ran.
Archived artifacts and verified pre-root cleanup do not prove descendant absence;
the empty diagnostic job-probe scan is not lineage evidence.
The gate's published-contract assessment keeps file-backed process ETW unselected:
stop and recorded-event consumption are documented; complete provider emission and
incarnation-bound ownership attribution remain unestablished. Actual-creator fields
are one possible solution, not mandatory if an audited equivalent binds ownership.
Offline replay could retrospectively prove quiescence at the recording cutoff if
complete history, all owned exits and discharged broker requests are established;
an online consumer is not mandatory. Neither composition is qualified. Classic V2
schema does not qualify an uninspected modern provider. Kernel callbacks offer
process-object/creator and callback-removal primitives but require an excluded
driver route; debugging lacks an accepted non-masking argument. No ETW privilege
failure was observed. Broker-request quiescence and harness bootstrap/post-trace
closure remain separate obligations. No examined option is a complete authorized
backend yet; this is not platform-wide infeasibility. Authority/serving remain
deferred, and no split PR is accepted yet. No production behavior changes.

CAN-4657 (E2) supersedes that paragraph's current-direction claims, preserving
its feasibility record. `src/supervision/windows-closure.ts` is an owned-run-only
contextual witness over Windows Git host/runner, identity and ACL edges: spawn
failures, discarded probes, refused helpers and rejected helper tails stay unsafe.
Only the same live instance accepts its frozen report; late work can revoke
eligibility. Wrapper close is not recursive descendant proof. The gate's
self-contained [current status](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md#current-delivery-status-can-4657--e2)
owns the separate I1 next step, where finite source-compositional proof is
admissible and no universal ledger is required. No daemon wiring, authority/serving
cutover or production launch/termination policy change is included.

CAN-4671 (I1) consumes the witness in the daemon. The barrel exports only
`createWindowsClosureWitness`, `captureWindowsClosureContext` and the
`WindowsClosureReport` type; `observeWindowsClosure` stays internal. On win32 a
Git `check-ignore` run marks its edge unsafe, since it may leave an fsmonitor
daemon; argv, environment, kill and timing are unchanged.

CAN-4672 (E3) adds a manual native [survivor-negative fixture](../../scripts/fixtures/windows-fsmonitor-oracle/README.md)
for that witness. With the persistent-monitor obligation explicitly reserved, a
real repository fsmonitor bound to a retained process handle is live at the
frozen nonpass, then exits 0 through that same handle. That nonpass carries the
`check-ignore` unsafe mark above and keeps the reserved edge pending. It is
test-only and outside CI, and neither discovers the obligation nor qualifies
daemon lifetime or serving ([status](../../docs/planning/2026-10-21-can-4576-backend-gate/README.md#survivor-negative-challenge-can-4672--e3)).

## Git reads (private)

`src/git-read/` (CAN-4331, U1 of CAN-4303) runs a fixed command set with
desktop's arguments, environments, per-stream limits and kill signals: `git
--version`, the macOS bare-init smoke, `git check-ignore -z --stdin`,
`xcode-select --print-path`, the macOS and Linux login-shell PATH probes,
`getent passwd <uid>` and `where.exe git`. The package index exports none
of it; its only caller is the [Git read host](#git-read-host).

Each request takes an explicit `cwd`, a caller-supplied environment (ambient
`process.env` is never read) and a monotonic deadline. A command name without
a directory (`where.exe`, a Git or `SHELL` such as `git`) is looked up only in
the absolute directories of that environment's PATH, and the absolute path
found is what is spawned. Neither the `cwd` nor the host's PATH is searched,
although spawn's own lookup would use both: Windows tries the `cwd` first, an
empty or `.` POSIX entry names it, and a missing PATH falls back to the host's
(Windows) or `/usr/bin:/bin` (POSIX). On Windows the candidates are libuv's:
the name as given when it has an extension (a first dot followed by any
character, so `a.b.` but not `git.`), then `.com`, then `.exe`, with no second
dot after a trailing one (`git.com` for `git.`). A
relative path with a directory part (`./git`, `sub\git.exe`) is rejected with
`invalid_request`, and a name the PATH lacks with `command_not_found`, both
before any process starts. The lookup counts against the request's deadline
and abort. On Windows, the PATH searched is the case variant Node keeps: the
first in sort order. Owned children are stopped from a timer or `setImmediate` turn, after an
`exitCode`/`signalCode` check in that turn, by `killProcessTree`. Work stops a
cleanup reserve before the deadline. After the root exits, held pipes drain
for a bounded window and are then destroyed. Group members left after a normal
exit are not killed. A stdin failure stops the root and settles first, as
desktop's EPIPE does; on Windows the write fails with EOF instead. The first
failure or abort decides the result. If the root's exit is unconfirmed when the
reserve ends, the request rejects with `cleanup_unconfirmed`, carrying the kill
failure or that first cause.

On Windows, `taskkill` runs asynchronously, so the port's PID-reuse window
remains, and settlement waits for it within the cleanup reserve (2 s by
default). When the reserve ends first, the request still settles then, with
`cleanup_unconfirmed` while the root's exit is unconfirmed. The kill call is
not cancelled: it gets no abort signal, runs on within the port's 4 s
`execFile` bound, and is not awaited. Its late result cannot change the settled
request: `onKillCleanup` reports `cleanup_unconfirmed` for each kill still
running at settlement and `failed` if it then fails. A failure before
settlement belongs to the request instead. A request or host abort does not stop it. The host process exiting
can, through libuv's kill-on-close job; that is not observed for `taskkill`.
No signal is passed because
`execFile` given an already-aborted one still starts `taskkill.exe` and then
terminates it, leaving the tree; the native suite records this. It also shows
a call made after the reserve, and a Node stand-in still running then that
calls the real `taskkill` later, each ending the tree. A real `taskkill` still
running when the reserve ends is not observed directly. `taskkill` uses the
child environment's SystemRoot. When the host exits, libuv's kill-on-close job
ends only the owned child. The job allows silent breakaway, so the child's descendants survive
unless the child puts them in a job of its own, as a libuv child does. An owned
`cmd.exe`'s child survives. So do the `conhost.exe`, `sh.exe` and `sleep.exe`
below an owned Git for Windows `git.exe` running a shell alias; the suite
asserts only `sh.exe`.

Windows child environment: libuv v1.51 (`src/win/process.c`, bundled with
Node 24) copies HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE,
SYSTEMROOT, TEMP, USERDOMAIN, USERNAME, USERPROFILE and WINDIR from the host
into a child whose environment lacks the key, matched case-insensitively. No
other host variable reaches the child, and a key with an empty value is kept.
The runner therefore passes only the case variant of each key that Node keeps
(the first in sort order) and adds each of these keys the request omits with
an empty value, so the child receives nothing from the host. A request whose
child would get a PATH with no absolute directory, or a SystemRoot that is
missing, empty or not a drive path (`C:\…`), is rejected with
`invalid_request` before any process starts: a Node child with an empty
SYSTEMROOT fails to start, and `taskkill` could not be located. `taskkill`
itself receives only that SystemRoot, so libuv fills its other listed keys
from the host; they reach `taskkill`, never the git-read tree.

The macOS bare-init smoke's scratch directory (desktop parity) is created and
removed under the same deadline and abort: creation must finish by the
reserve, and removal waits at most the reserve, never past the deadline. After
an abort, one reserve covers both stopping git and removal. The request keeps
its first result: a failed removal, or one still pending at its bound
(`cleanup_unconfirmed`), never replaces it and is reported separately through
`onScratchCleanupFailure`. A directory created after the request settled is
removed when it appears. `checkIgnoredPathsWith` keeps desktop's 5,000-path chunks,
decoding, results and first-failure ordering, with one executable and a
`requestDeadlineMs` (30 s) deadline. `checkIgnoredPathsSelected` keeps the same
rules under the caller's deadline and signal, and awaits
`executableForChunk(chunk, signal, deadlineAt)` before each chunk. With any
paths, an invalid `cwd` or environment rejects `invalid_request` before the
first selection, and an aborted request makes no further selection. The runner
waits for it until the cleanup reserve or an abort, then aborts its signal; a
selection failure counts as that chunk's failure. `whenIdle(signal)` resolves
`idle` once no request is in flight and no owned root, continuing kill, or
scratch creation or removal remains, and `pending` if `signal` aborts first.
An abandoned PATH lookup or selection does not count: the lookup only reads,
and the selection is the caller's work. The fsmonitor hook runs inside
the owned group. Where Git has the builtin fsmonitor daemon (macOS, Windows,
and Git 2.55 on ubuntu-latest), it detaches and outlives the request; a Git
built without it (Debian's 2.39) reports it unsupported.

The runner and check-ignore suites run on POSIX hosts.
`git-read-windows.test.ts` asserts the Windows behavior above, and
`git-read-host-probes.test.ts` runs each host's real probes. Both run only on
their own OS, which for Windows means the PlatformServices job. The Windows
suite separates a kill call made after the reserve ended from a kill helper
still running then. The helper is a Node stand-in that calls the real
`taskkill` only after the reserve. Each Node fixture holds a named-pipe
connection to the suite that closes only when its process ends. Native
processes a case leaves running (an owned `cmd.exe` or `git.exe`, what they
started, the fsmonitor daemon) are identified by their .NET start time. After
each test, the suite ends what remains and confirms it gone; a survivor fails
that test. A survivor of the final sweep, or a temp directory it cannot
remove, fails the suite. After that sweep, the suite records, without
asserting, any other process created during it that still runs under a
fixture's process name or in its directory. Untracked processes it does not
wait for, such as Node fixtures' console hosts, are covered only by that
record. The Linux login-shell probe is
compared with the same shell run directly, because a host's system profile can
replace HOME so that the supplied profile is never read. In CI, the suites write their observations to
`.cache/platform-contracts/git-read-*.json`, which the job uploads. Each
observation carries its full test name, as in the job's `jest-results.json`.

## Git read host

`createGitReadHost({ os, environment, probeDirectory, onCleanupReport })`
(CAN-4395, U2b of CAN-4303) is the trusted, read-only Git selection and
`check-ignore` host behind the `GitIgnoreHostPort` that
`createReadOnlyDirectoryInputs` consumes. It reproduces desktop's
`detectGitExecutableInternal` and `getResolvedGitExecutableForSpawn` over the
private runner. It never installs Git, writes or clears a preference, or
publishes an environment variable, and it exposes no generic command API.
The packaged daemon composes it behind directory reads (CAN-4304), with its
environment snapshot taken after the claim marker is consumed and the
canonical data root as `probeDirectory`. It prewarms the host on start and
stops it in shutdown phase 5.

- **Construction** copies the daemon's own startup environment once, dropping
  undefined values, and does no I/O. It never throws. An unusable snapshot or
  probe directory fails each request with `invalid_request`.
- **Each request** returns an empty set for no paths, without a saved read or
  spawn. A pre-aborted or aborted request rejects with its signal's reason. One
  30 s deadline covers selection and every 5,000-path chunk. Before each chunk
  the host reads the saved value and selects. `check-ignore` then runs in the
  request root with the snapshot environment.
- **Errors** are `GitIgnoreHostError` codes with fixed text: runner codes pass
  through, except `command_not_found` and spawn errors, which become
  `git_unavailable`. `lastFailure()` keeps the last code until a request
  succeeds.
- **Selection** on macOS and Windows tries the trimmed saved value, then the
  snapshot `CANOPY_GIT_EXECUTABLE`, then discovery. macOS discovery uses
  `getMacGitCandidates`, skipping shims. Windows runs `where.exe git`, then
  `getWindowsGitCandidates`, deduplicated case-insensitively. Windows accepts
  only host-absolute paths. Linux x64 keeps an explicit choice (the saved value,
  else the snapshot override) and reports it when broken, never replacing it.
  Without one, it revalidates its discovery cache, awaits the login-PATH
  refresh and tries `getLinuxGitCandidates`. A request with a saved choice
  drops that cache when it becomes the latest (below), whichever detection then
  serves it, as desktop's saving or clearing one does. Other Linux spawns the
  override or `git` through the snapshot PATH, unvalidated. A validated
  selection keeps desktop's spawn fast path. ENOENT or ENOTDIR there reselects;
  any other lookup error is `selection_rejected`.
- **Shared work**: detection is single-flight per trimmed saved value and its
  `stat` identity, with its own 30 s deadline under the host's lifetime. The
  deadline and a stop end each of its filesystem lookups, probes and any
  login-PATH refresh it awaits; a stalled lookup is abandoned. A request waits
  for it only within its own deadline and never cancels it, so a cold first
  listing can fail with `deadline_exceeded` while the next one uses the result.
  A failed explicit value is remembered, not cleared, for 5 minutes while its
  `stat` identity (`dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`) is unchanged; the
  next detection re-checks a changed one. A selection is keyed by the saved
  value and its identity only, so a fallback discovered over a failed snapshot
  override stays selected until detection re-runs: at the TTL, when the fallback
  fails the spawn fast path, or when the saved value or its identity changes.
  A detection records (an explicit value's rejection or its clearing, a Linux
  discovery-cache update, its selection) only while it serves the latest
  request, started or joined, and has not ended; afterwards it records nothing.
  What it recorded while current is a real observation, so it stays after a
  later supersession. Requests are ordered by when they read the saved value.
  Once its `stat` identity is known, a request becomes the latest unless a
  newer read already has. It then supersedes a pending detection for another
  key, even when the fast path keeps its selection.
- **Probes** run in `probeDirectory`. On macOS they add `SHELL` (the snapshot's,
  else the account's absolute shell, else `/bin/zsh`) and the account's `USER`
  and `LOGNAME`, omitted when `os.userInfo()` throws. The macOS login PATH is
  stale-while-revalidate with a 5-minute TTL. Each refresh has its own 30 s
  deadline from its start. Linux x64 detection awaits it only within its own
  deadline. The Linux refresh chooses the shell from the snapshot `SHELL`, then
  `getent`, then `/bin/bash`. The macOS bare-init scratch goes under the
  snapshot `TMPDIR`, else `/tmp`.
- **`prewarm()`** starts the login-PATH refresh on macOS and Linux x64. It has
  no preference source, so it does not select.
- **`stop(signal)`** aborts in-flight work and waits for detection and the
  runner, including a Windows `taskkill` still running after settlement. A
  filesystem lookup that detection abandoned is not waited for. It
  returns `cleanup_unconfirmed` if `signal` aborts first. Later calls reject
  with `stopped`. `onCleanupReport` receives the runner's kill and scratch
  removal reports.

The architecture, a `SelectionIo` seam (`stat`, `realpath`, `access`), the clock
and the runner are private seams for tests (`createGitReadHostWith`). The
shared selection table
(`packages/protocol/src/git-executable/__tests__/selection-scenarios.json`)
replays through desktop's module mocks and through this host. Each daemon
difference must be one of the named deliberate divergences in
`git-read-host-fakes.ts`. `git-read-host-process.test.ts` covers real
processes, real repositories, the composed no-write inventory and Windows
`taskkill` after settlement. `git-read-feasibility.test.ts` (G1) records
production selection under the daemon child environment, with and without
account facts, against the runner's full environment.
