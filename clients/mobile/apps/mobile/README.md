# mobile

A new Flutter project.

## Getting Started

This project is a starting point for a Flutter application.

A few resources to get you started if this is your first Flutter project:

- [Learn Flutter](https://docs.flutter.dev/get-started/learn-flutter)
- [Write your first Flutter app](https://docs.flutter.dev/get-started/codelab)
- [Flutter learning resources](https://docs.flutter.dev/reference/learning-resources)

For help getting started with Flutter development, view the
[online documentation](https://docs.flutter.dev/), which offers tutorials,
samples, guidance on mobile development, and a full API reference.

## Android keyboard inset regression

`ImeInsetsRecovery` requests fresh Android insets after an IME animation ends,
including cancellation during background/resume. It runs on the content parent
so Flutter retains its own animation listeners and normal keyboard avoidance.
This works around [Flutter #191156](https://github.com/flutter/flutter/issues/191156).
Re-evaluate the workaround when the upstream engine fix reaches our pinned SDK.

The native integration test uses the real Remote UI and Gboard with local fake
data (14 projects), checks zero keyboard inset and restored list bounds after
each return, and verifies that the last project is reachable. Run on an explicit
Android emulator with the `android` CLI on PATH:

```sh
KEYBOARD_TEST_ADB=/path/to/Android/sdk/platform-tools/adb \
KEYBOARD_TEST_DEVICE=emulator-5568 \
flutter drive --driver=test_driver/keyboard_recovery.dart \
  --target=integration_test/remote_keyboard_recovery_test.dart \
  --dart-define=INTERRUPT_KEYBOARD=true -d emulator-5568
```

The driver launches Home during keyboard opening and resumes the same Activity
20 times with varied timing. It records actual lifecycle and inset events under
`build/keyboard-lifecycle-<device>.json`, and captures native screenshots and IME
state on failure. It uses and removes an `adb reverse` bridge on port 18765;
run one instance at a time. Test gesture and three-button navigation separately.
Omit `INTERRUPT_KEYBOARD` for six normal keyboard dismissal/navigation cycles,
including checks that the composer stays above the keyboard. Add
`--dart-define=CAPTURE_KEYBOARD_RECOVERY=true` to save successful screenshots
under `build/keyboard-recovery/`.

## Shared chat stack

`lib/ui/features/chat/` and `lib/data/models/chat_message.dart` hold the
transport-neutral chat UI: the transcript feed (`ChatFeed`), composer
(`ChatInput`, `ComposerToolbar`), tool-call rows, the ask-user
`PendingQuestionCard`, and the pure turn-grouping, turn-timer, tool-display,
thinking-level, and voice-dictation logic. Remote Control
(`lib/ui/features/remote/`) and cloud chats (`lib/ui/features/cloud/`) both
build on it. The two surfaces never depend on each other; `RemoteChatMessage`
extends the neutral `ChatMessage` to carry its desktop scope.
`test/architecture/chat_boundary_test.dart` fails the build if any of those
import rules break. Design notes:
`docs/planning/2026-09-20-mobile-cloud-chats/design.md`. The authoritative
maintainer reference for the cloud surface (routes, SSE stripping rule,
sourceKey join, outbox and cursor-epoch invariants, availability gate, and
what is out of scope) is `docs/mobile-cloud-chats.md`.

Drafts and unsent sends: `lib/data/models/chat_drafts.dart` (`DraftTarget`,
`UnsentRecord`, `ChatDraftStore`), `lib/data/services/chat_draft_store.dart`
(account file store), and
`lib/ui/features/chat/view_models/composer_draft_binding.dart`. Design:
`docs/planning/2026-10-03-can-3556-mobile-drafts-and-unsent-sends/design.md`.

### Markdown images

`MessageMarkdown` parses `![alt](src)` and `![alt](src "title")` into
`MessageImage` spans in paragraphs and table cells. Chat leaves `imageResolver`
unset, so images render inert alt text without network or desktop reads. Images
with empty alt text show `Image` instead.

A caller that can read images supplies `imageResolver`, a
`Future<Uint8List> Function(String source)`. The caller owns source validation,
authorization and transport. It can throw `MessageImageFailure.notFound`,
`.unsupported` or `.unavailable` for a short reason; other exceptions show a
generic failure without exposing their contents. Invalid image bytes show the
unsupported state. The widget reuses each read across rebuilds and discards
results from replaced resolvers or sources. While resolving and decoding, it
reserves a 160×80 logical pixel box. The first 200ms are blank, followed by a
pulsing skeleton; reduced motion keeps it still. Changing the source or resolver
restarts the delay. Loaded content uses its decoded dimensions.

Loaded images fit the content column with their aspect ratio preserved. Table
images use thumbnails capped at 96 logical pixels. `onImageTap(source, bytes)`
lets a caller open a viewer with the already loaded bytes. The renderer itself
does not read files; the worktree file viewer below supplies both callbacks. The parser retains its
32-column and 512-cell table limits.

### Worktree file viewer (CAN-5130)

`RemoteFileScreen` opens one root-scoped worktree file from a
`RemoteFileRequest`. The header shows the file name and its folders. Markdown
(`md`, `markdown`, `mdx`) opens in Formatted mode with a Source switch; other
text opens in Source only. Both modes stay mounted, so switching does not read
again or reload images.

Formatted mode passes `RemoteFileViewModel.readImage` to `MessageMarkdown`.
Sources resolve against the report's folder with
`resolveRemoteFileImagePath`. Root escapes, absolute and UNC paths, `file:`,
http(s) and other schemes, and malformed escapes are rejected before any read.
The desktop still enforces containment. Accepted images are read only through
`readAsset`, with the same project, worktree and root. A tap opens the loaded
bytes in `RemoteImageScreen`, an `InteractiveViewer` with pinch zoom and pan.

Read images stay in memory only, least recently used first, under a 20 MiB
encoded-byte budget per screen. Pending reads are shared and failures are not
cached. A session change clears the file and images, closes an open image, and
discards late results. Closing the screen or a session change also evicts the
screen's decoded images from Flutter's image cache; other cached images stay.
A desktop without `chat_assets_v1` keeps text and alt text and shows an update
notice. Entry points from file lists and links are
separate work; the device test reaches the viewer from a test-only launcher.

```sh
cd apps/mobile
flutter test test/ui/features/remote/view_models/remote_file_image_path_test.dart \
  test/ui/features/remote/view_models/remote_file_view_model_test.dart \
  test/ui/features/remote/remote_file_screen_test.dart \
  test/ui/features/remote/remote_image_screen_test.dart
flutter drive --driver=test_driver/integration_test.dart \
  --target=integration_test/can_5130_file_viewer_device_test.dart \
  --dart-define=CAN5130_THEME=dark -d <device-id>
```

## Remote chat controllers (CAN-3429)

`RemoteChatScreen` renders state; it does not reconcile it during `build`.
Pure Dart controllers in `lib/ui/features/remote/view_models/` own the
optimistic state, and `RemoteClientEngine` wires them to its command
registry, session generation, and chat-id minting:

- `RemoteChatTabsController` owns provisional tab creates and closes, the
  selection, and the latched chat resolution. Create and close outcomes
  arrive through the handlers each submission registers.
- `LastViewedChatTabs` keeps, in memory only, the chat tab last shown in
  each worktree (CAN-3940). A worktree opened without an exact chat starts
  on that tab; the tabs controller falls back when it is gone. A new tab
  is remembered once the desktop lists it, even after the screen closed, so
  a failed create is never remembered. A new session generation (pairing,
  disconnect, ended session) forgets it.
- `ComposerOverridesController` holds one record per composer field. A
  value stays until the desktop rejects it, or until it completes and a
  newer projection of its chat arrives.
- `PrStateTracker.pollPrState` gives each chat view its own one-minute PR
  poll. The view reports visibility and foreground state as one input.
- Actions settle from the desktop's events, not from follow-up reads
  (CAN-4875). Activity & files reads the worktree once its snapshot lands.
  A read receipt stops retrying at its command's completion. A later unread
  for the same output can predate the read, because completions overtake
  older summaries and state reads lag. If the read's own summary does not
  confirm it within 3 seconds, one fresh desktop projection decides. When
  the desktop declines a read (`applied: false`: already read, older output,
  or a running turn), a fresh projection reconciles it. While the chat stays
  unread, each later decline asks again. Another client's read can confirm
  the receipt before the phone's own read answers, also while its submit is
  in flight. Then a later unread can predate the phone's read, and a fresh
  projection decides. An unread that arrives before the read's answer, also
  before its submit returns, can be a later desktop unread that a state read
  covers or that follows the read's completion. If the chat still projects
  unread when the read
  applies, the same 3-second wait and fresh projection decide. A worktree chat
  uses a chat `portal.state.request`; a standalone chat uses the overview
  request and its state read. Hook toggles apply the `portal.hook.event`
  upserts.
- `ProjectCloneCoordinator` reads a clone's command status only when its
  completion is 30 seconds overdue, and once on each return.
- `PendingChatAttachmentStore` marks retry drafts restorable from command
  outcomes. A chat view takes each batch once with `takeRestorable`.
- `WorktreeCreateCoordinator` submits immediately and follows pushed Git-ready
  and failure updates. A recovery round runs only after 30 foreground seconds
  without them, then every 30 seconds, and never in the background (CAN-4875).
  A round recovers a missing worktree ID from the command-status endpoint,
  or refreshes the overview once the ID is known. It never identifies a
  create by comparing worktree lists or sends the first message into another
  client's worktree. An outcome with a known command or
  worktree ID stays pending across retries to prevent duplicate creates. After
  the original waiter times out, pull-to-refresh reads command status again
  so a missed completion event cannot strand an accepted create. If
  both IDs were lost, the reconciliation deadline releases the attempt and
  asks the user to check the desktop before trying again, since the original
  request may have created a task.

`ChatSendCoordinator` mints chat ids (`chat-m…`, `cc-…`) next to message
ids (`msg-mobile-…`). For tab creates and closes and composer setting
commands, it does not claim a command whose submit response arrives after
the session was replaced, so their outcomes cannot change or notify the
replacement session. Message sends keep their existing delivery and
recovery behavior and are not covered by this guard. The screen
calls `_syncWithViewModel` from its view-model listener to apply
projection bookkeeping and the bound chat's side effects.

```sh
cd apps/mobile
flutter test test/ui/features/remote/view_models/remote_chat_tabs_controller_test.dart \
  test/ui/features/remote/view_models/composer_overrides_controller_test.dart \
  test/ui/features/remote/remote_chat_screen_test.dart \
  test/ui/features/remote/remote_chat_composer_test.dart \
  test/architecture
```

## Remote Control compatibility

Mobile keeps the existing desktop and web-server support range. Optional
capabilities continue to select the available hydration behavior; missing
`foreground_worktree_chat` or `worktree_chat_summaries_scope` does not require
an update. Uncursored-event reconciliation and paced SSE/long-poll recovery
remain. The [CAN-4878 audit](../../docs/planning/2026-10-29-can-4878/compatibility-audit.md)
records the per-path decisions and the evidence needed before setting a release
cutoff. The cleanup removes local Dart aliases and an unused feedback loader.

## Remote Control request budgets (CAN-4872)

`test/request_budget/` counts the HTTP requests and event-stream connections
that the Remote Control client sends across user flows. Each flow fails
when a count goes above its pinned budget. The tests have the `request-budget`
tag. CI excludes that tag, so run them locally before and after a network
change:

```sh
cd apps/mobile
flutter test --tags request-budget
```

Each flow drives the real `HttpRemoteControlRepository`, view model and
screens at phone width. A synthetic Portal server and desktop in
`test/support/remote_request_budget_harness.dart` answer the requests. The
recording client in `test/support/portal_request_recorder.dart` records each
request before the server answers it. Fake time runs the one-, two- and
five-minute waits.

CAN-4877 covers a current server tail, a missing or stale tail, and cold-connect
request ordering. A nonempty server tail can settle chat hydration when its
projection cursor covers the overview and every observed event for that chat,
and `chatTailCoverage` proves the exact cached message set was seeded by a
completed targeted desktop snapshot. Mobile installs its ordered message IDs
instead of sorting mutable revision timestamps. Absent or mismatched coverage
keeps reconciliation, including on older servers and live-only partial caches.
Missing cursors, stale responses and raced live rows keep the desktop snapshot
fallback. A verified tail ignores older transcript replay for its chat. Legacy
live events without row cursors resume snapshot reconciliation when their order
cannot be proven. Chat reads never advance the session's event-stream cursor.
Advisor prefetch and background summary warming wait for a foreground chat or
overview projection to finish. A usable HTTP overview also releases the gate,
so a fresh connect or restore does not depend on another overview push.
Opening Advisor or chat search still loads it
on demand. State responses of at least 64 KiB decode and map in an isolate.

These request counts are deterministic regression evidence. They do not measure
profile-mode device latency or transferred bytes. Measure tap-to-latest-message
time and received bytes on the same physical device and paired desktop before
and after a performance change.

The counts use these keys:

- `requests`: every request, including failed and refused requests.
- `event streams`: event-stream connection attempts (SSE and long-poll). It
  does not count TCP or TLS sockets.
- `METHOD endpoint`: the route below the browser Portal path, without the
  session id, for example `GET state` or `POST commands`.
- `METHOD endpoint detail`: the state read's `scope`, or the command's
  `type` with its payload `scope` or PR `action`.

A key that a budget does not name has a limit of zero. Each window prints its
counts and requests on a `REQUEST_BUDGET` line. A failure lists each count
above its limit as `window: key: count > limit`.

The fixture models these server and desktop behaviors:

- One paired desktop with one workspace, one worktree with an open PR, and
  one chat. It announces `foreground_worktree_chat`, `chat_mark_read` and
  `pr_worktree_actions`; every other capability is off.
- SSE stays open, with a `: keepalive` every 10 seconds. While the desktop is
  inactive, each SSE connection gets one inactive batch and ends. After the
  desktop wakes, the next connection gets one batch that reports it active.
- A long-poll answers at once with new events or while the desktop is
  inactive, and otherwise holds for 25 seconds.
- A test can fail the next event-stream connections with 503, as during a
  network change.
- A test can add a working standalone chat. Its `standalone_chat` row
  arrives in a cursored delta every 5 seconds (CAN-4874).
- The server waits for `portal.state.request` and `portal.chat.send` results.
  The desktop runs other commands 100 ms after the acknowledgement.
- The overview state read returns the chat summary the desktop last
  projected, as the server's cache does. A test can lose a read's summary,
  send an older unread summary after the read's completion, send another
  client's read and an older unread before the read's completion, delay a
  read's completion by 2 seconds, or let another client read the chat
  without a summary (CAN-4875).
- The worktree has one hook. A hook pause or resume sends the desktop's
  `portal.hook.event` descriptor upsert before its completion (CAN-4875).
- A worktree create answers with its command id only. The desktop then sends
  the new worktree's delta and the completion with its id.
- A project clone sends the workspace delta and the completion. A test can
  lose both; `GET .../commands/:id` then reports the clone completed.
- Each action is followed by a fixed 5-second settle window.

`remote_control_connection_reuse_test.dart`, in the same tag, counts real
TLS connections. A loopback HTTPS server with keep-alive records the client
port of each request; one port is one TCP and TLS handshake. Session,
overview and chat-cache reads share one connection, and so do consecutive
long-polls. Each window prints a `CONNECTION_REUSE` line. The test needs
`openssl` to make a throwaway certificate, which only that run's clients
accept.

When a change removes a request, lower the budget in the same change. Do not
raise a budget to make a change pass; explain any increase in the pull
request. Post the counts from before and after the change in its issue.

## Remote Control on-device caches (CAN-4879)

`RemoteFileDiffCache` retains at most 32 diffs and 512 KiB of encoded JSON,
including the session envelope. Each insertion encodes its row once and saves
its UTF-8 size. LRU eviction and expiry subtract those sizes. Reads update
memory only; writes collect for 500 ms, with an explicit flush on background
and view-model disposal. Cold restoration decodes and validates JSON in a
separate isolate. Pairing changes fence late reads and discard deferred writes.

Every diff hit revalidates, including a hit restored from disk. Current
projection revisions identify changed-file metadata rather than patch contents;
a same-size edit can keep both its revision and line counts. Skipping requests
requires a content-bound identity, tracked in
[CAN-5472](https://linear.app/unstoppable-domains/issue/CAN-5472).
Older hosts without revisions keep memory-only entries. The 15-minute expiry
still applies.

Transcript hydration reads each chat's persisted tail once per pairing without
changing its recency. `ShownChatReopener` records actual foreground activations,
including switching tabs or returning from a covered route. Activation waits
for connection readiness so a screen mounted before automatic restoration can
persist subsequent live revisions without another navigation. Notifications to
mounted, hidden screens do not advance recency or rewrite idle tails. Live
transcript changes retain the existing write delay and partial-tail protection.

Run the cache and request-count regressions from this directory:

```sh
flutter test test/ui/features/remote/remote_file_diff_cache_test.dart \
  test/ui/features/remote/remote_file_diff_screen_test.dart \
  test/ui/features/remote/remote_transcript_cache_idle_test.dart \
  test/data/repositories/remote_transcript_cache_test.dart \
  test/data/repositories/remote_transcript_cache_interleaving_test.dart
flutter test --tags request-budget test/request_budget/remote_control_request_budget_test.dart
```

The [five-diff profile harness](integration_test/can_4879_diff_cache_profile_test.dart)
uses synthetic patches and real SharedPreferences writes. It records the Dart
timeline, frame timings, write count and encoded bytes. Run identical before
and after builds on the same device:

```sh
flutter drive --profile --no-dds --no-pub \
  --driver=test_driver/integration_test.dart \
  --target=integration_test/can_4879_diff_cache_profile_test.dart -d <device-id>
```

Save `build/integration_response_data.json` after each run. Emulator results
compare the workload; they do not establish physical-device frame performance.

## Remote Control reconnect pacing (CAN-4873)

`PortalEventStream` (`lib/data/services/portal_event_stream.dart`) paces its
reconnects with `PortalReconnectBackoff`:

- A failed connection, or a batch that reports the desktop inactive or
  ended, waits 4, 8, 16, 32 and then 60 seconds. Each wait takes 80-100% of
  its step. At most five reconnects fit in two minutes of desktop sleep.
- A healthy active batch, a long-lived stream with keepalives, or a fresh
  subscription after foreground resets the wait to the first step.
- A session read that reports the held desktop active ends the current wait
  at once. Without that read, the client reaches a desktop that wakes within
  one 60-second step, plus the connection time.
- Connect errors, timeouts, 5xx and empty streams stay on SSE. Only a
  stream-route 404 or an oversized frame moves the client to long-poll. It
  polls at least once and probes SSE again after its own 4- to 60-second
  step. Polls continue between probes, so delivery does not wait for them.

`PortalReadClient` (`lib/data/services/portal_read_client.dart`) keeps one
connection pool for session, overview and chat-cache reads. A read that
passes its deadline is aborted on its own socket, and its retries do not
reach the network. An abort cannot reach a
connection that is still in its TCP connect or TLS handshake, so the pool
also cancels each connection attempt after 10 seconds. A TLS handshake
that stalls after TCP connects keeps its socket until the server or the OS
closes it, because `dart:io` cannot cancel a handshake. If that handshake
completes later, the pool closes the socket at once. The repository
retires the pool when events pause: on background, session teardown and
session replacement. Retirement fails the reads in flight at once and
rejects their late results. A discarded event cursor keeps the pool, so
reads in flight finish.
Each SSE connection keeps its own client, so cancelling aborts it.
Consecutive long-polls share one client.

## Remote Control composer inventory (CAN-3925)

`RemoteComposerCommands` (`lib/data/repositories/remote_composer_commands.dart`)
reads the `invocable_inventory` session capability. With it, an existing
worktree chat, or a standalone chat that the desktop projects, uses
`portal.editor.list_invocables`. Rows keep the desktop order and groups:
Commands, Skills and commands, then Available to enable. A row that needs
resolution calls `portal.editor.resolve_invocable` before insertion, and the
composer inserts the text that the desktop returns. A failed resolve shows the
shared enable error and keeps the draft. `lib/data/models/remote_invocables.dart`
validates both answers at the data boundary.

Standalone chats also get the Plugins row. Its count and switches come from
the projected `pluginSelectionsDetail` of the standalone chat. An absent
projection is unknown, so the sheet does not load or save it. A toggle sends
`portal.standalone_chat.set_plugin_selections` and holds as a pending choice
until the desktop settles it, like a worktree chat.

Without the capability, worktree chats keep `portal.editor.list_slash_commands`
and standalone chats keep built-in actions only, with no Plugins row.

```sh
cd apps/mobile
flutter test test/data/models/remote_invocables_test.dart \
  test/data/repositories/remote_composer_commands_test.dart \
  test/ui/features/remote/view_models/remote_composer_command_source_test.dart \
  test/ui/features/remote/view_models/remote_composer_plugins_source_test.dart \
  test/ui/features/remote/remote_chat_composer_test.dart
flutter test integration_test/can_3925_composer_inventory_device_test.dart -d <device-id>
```

## Worktree collation

Remote worktree tie-breakers use ICU4X through pinned `icu_kit` 0.2.0 with the
system locale, tertiary strength, and significant punctuation, matching desktop's
default `localeCompare` semantics. Saved numeric order still takes precedence.
Devices with different system locales can have different locale-specific ordering,
just as two desktop clients can. The collator is cached and rebuilt when the
locale changes.

The package bundles native collation code/data. For platforms with a matching
prebuilt library, its build hook downloads the pinned asset from the package's
GitHub release and verifies its checksum.

iOS builds require Rust 1.86 or later (`rustup` and `cargo` on PATH).
Check the compiler selected by `cargo`, especially if Homebrew Rust and rustup
are both installed. A newer rustup toolchain does not replace an older
Homebrew `cargo` earlier on PATH.
Flutter requests dynamic native libraries, while the package publishes static
iOS archives, so the hook builds the dynamic library from its bundled ICU4X
source. This includes Apple Silicon simulators. Install Rust using
[the official rustup instructions](https://rustup.rs/); the hook installs the
matching target and caches the result. First builds need network access and take
longer than subsequent builds. Flutter unit/widget tests on macOS use the
prebuilt native library and do not require Rust.

The CocoaPods post-install hook raises older plugin deployment targets to
Runner's existing iOS 15 minimum. Xcode 27 rejects older simulator targets.
It preserves plugins that require newer iOS versions. Run
`ruby ios/test/podfile_test.rb` with the Ruby environment used by CocoaPods
after changing this hook; run `flutter pub get` first to generate its Flutter
configuration.

## Foldable displays

The navigator uses `FoldSafeArea` to keep routes, sheets and controls out of
an active fold. iOS 27.1 builds obtain division regions through
`FoldRegionsPlugin`; the app uses the leading or upper pane while partially
folded and the full window when opened. This preserves the existing route
and draft. The adapter supplies geometry only when Flutter's engine does
not already report a fold. Older SDKs compile without the new UIKit calls.

Run `flutter test test/ui/core/layout test/architecture` for the layout and
bridge contract checks. The native verification record and remaining
physical-device checks are in
[iPhone Duo readiness](../../docs/planning/2026-10-23-iphone-duo/README.md).

## Cloud transcript mapping

CAN-3141 adds the protocol-v1 boundary in
`lib/data/models/cloud_wire_frame.dart` and the pure
`CloudTranscriptMapper` in `lib/ui/features/cloud/view_models/`.
Pass decoded SSE JSON to `parseCloudWireFrame(event, data)`, then call
`mapper.apply(frame, eventId: frameId)` with the block's own SSE id.
The parser always returns a classified frame, including `ignored` and
`unparseable`. Keep one mapper per chat; `messages` exposes shared
`ChatMessage` rows, while `apply` returns replacement rows keyed by message id.
`terminalDisposition` reports whether a finish was accepted or stale.

`hydrate(bootstrap)` atomically replaces the transcript using the same tool
fold as live frames. Live assistant ids use `cloud:`; hydrated ids use Core's
canonical id (plus a step suffix for split rows). Never reconcile assistant
rows across these namespaces by text or source key. Ordered content blocks
preserve text/tool ordering. Legacy flattened rows fall back to tools followed
by text; Core does not persist artifact timing across content kinds, so reload
attaches artifacts to the final step.

`CloudTranscriptMessage` adds cloud identity and model/usage/cost metadata
without changing shared chat models. Turn accounting is present only on the
terminal sub-message. Missing cost remains pending, and decimal strings stay
strings. `pendingQuestions` exposes shared `AskUserQuestionState` values;
results and later user rows clear them. The session layer can call
`clearPendingQuestions()` after an answer is accepted. Answer delivery and
secret redaction belong to the structured API/session work, not this mapper.

Focused coverage (ported from the web wire/mapper suites):

```sh
flutter test test/data/models/cloud_wire_frame_test.dart \
  test/ui/features/cloud/view_models/cloud_transcript_mapper_test.dart \
  test/architecture/chat_boundary_test.dart
```

## Cloud chat session (CAN-3142)

`CloudChatViewModel` owns the selected protocol-v1 session, an in-memory FIFO
outbox, stream subscription, and retry timers. `cloud_chat_session.dart` holds
immutable state, pure bootstrap/acceptance/frame reducers, ordered effects,
cursor comparison and replay filtering, and runtime invariant checks. The
existing repository and transcript mapper remain the wire boundaries.

The application supplies the model through `CloudChatScope` above the root
navigator using `ChangeNotifierProvider.value`, so pushed routes can read it.
The scope clears the model on account/organization changes and disposes it on
API-environment changes. Open with the chat's external id and its
`coreAgentSessionId` as `cursorEpoch`; never invent an epoch from a local clock.
`open` selects one chat; `close` discards its local state without cancelling
Core. This slice does not persist the outbox across process termination.

Send with a stable `clientRequestId` and `CloudSendPayload`. Retryable failures
reuse the same key and payload with `replayHint`; definitive failures remain
available through `failedSends` and `retrySend`. Terminal-session failures call
the repository's `fork` / `mode: continue` operation before bootstrapping the
new epoch and replaying the queue. `continueChat` also supports an explicit
Continue action without a queued send. A failed continuation requires manual
retry, preventing a repeated fork loop.

The model observes app lifecycle itself: background detaches, foreground
resumes from the last cursor or bootstraps stale/unknown state. Tests can inject
the clock, retry/staleness/request durations and `openStream`, and disable the
lifecycle observer. Transcript completion is never a substitute for a keyed
Core terminal event. An unbound or unkeyed terminal forces bootstrap.

```sh
cd apps/mobile
flutter test test/ui/features/cloud
```

## Cloud chat screens (CAN-3143)

`CloudChatsScreen` (the interim `HomeTab.cloud` root) lists cloud workspaces
and their chats from `CloudChatsViewModel`, which owns the workspaces probe,
create/rename/archive, and the model catalog projected onto the shared
`ModelOption` shape. Availability is inferred from that probe: `null` until it
answers, `false` on a 404, and `visibleHomeTabs` in `authenticated_shell.dart`
drops the tab only on `false`, so a transient failure never hides a working
feature. Both models live in `CloudChatScope` above the root navigator, share
one repository (`buildCloudChatModels` in `main.dart`), and reset together on
account or organization changes.

`CloudChatScreen` composes `ChatFeed`, `ChatInput`, `ComposerToolbar`, and
`PendingQuestionCard` from the shared stack over the ambient
`CloudChatViewModel`. It binds the session post-frame on mount and does not
close it on pop, so a turn left running keeps streaming and the list shows it
as working. Composer facts: the model is persisted through `setChatModel`;
thinking level and Fast mode are screen-local and ride each send payload;
`planMode` is null. Ask-user answers go out as the next user turn
(`formatAskUserAnswers`) because cloud has no structured answer route; a
question flagged `secret` is never sent from mobile and shows a notice
pointing at the web app instead. A terminal session keeps the composer; the
next message continues the session in place before sending. Definitive send
failures (402 credits, 403 model policy) show the server's sentence in a pinned
banner with Retry. Every client-minted id
(`clientRequestId`, created chat `externalId`) comes from `randomUuidV4`, as
the routes reject non-UUIDs.

```sh
cd apps/mobile
flutter test test/ui/features/cloud test/ui/features/home test/architecture
```
