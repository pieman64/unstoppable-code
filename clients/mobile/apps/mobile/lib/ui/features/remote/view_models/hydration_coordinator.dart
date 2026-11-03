import 'dart:async';

import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart'
    show RemoteHookDescriptorEvent;
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'background_process_hydration.dart';
import 'chat_tail_freshness.dart';
import 'chat_transcript_store.dart' show RemoteCachedTailSource;
import 'hook_descriptor_patch.dart';
import 'owned_command_registry.dart';
import 'remote_identity.dart';
import 'worktree_activity_load_tracker.dart';
import 'watcher_slice_store.dart';

/// A pure update of one worktree's held activity slices, from a live event.
typedef WorktreeSlicePatch =
    Map<String, dynamic> Function(Map<String, dynamic> slices);

/// Minimum gap between hydration re-requests for the same worktree/chat when
/// an earlier request produced no data (failed submit, expired command, or a
/// missed event). Keeps hydration self-healing without hammering the relay.
const Duration kRemoteHydrationRetryWindow = Duration(seconds: 15);

/// Watchdog on an in-flight hydration: if the desktop's snapshot never lands,
/// chat loading fails. One automatic retry follows the retry window; only its
/// failure becomes a retryable error. The error stays until Retry, a live row
/// or snapshot for the chat, a recovered connection, or a reopening of the
/// chat a retry window after the failure (CAN-4427).
/// Chat watchdogs and retries stop while the app is in the background.
///
/// Sized to match the web portal's own hydration budget
/// (`PORTAL_STATE_HYDRATION_MAX_WAIT_MS = 60_000`): projecting a large real
/// workspace on the desktop has been observed to take 5–30s, so a shorter
/// watchdog gives up mid-flight and flashes the misleading "No chats yet" /
/// "No messages yet" empty state before valid data has had a chance to land.
const Duration kRemoteHydrationTimeout = Duration(seconds: 60);

/// Attempts per session at one worktree's chat-panel pipeline read before
/// it gives up until the next session.
const int _kPipelineRunReadAttempts = 3;

/// Background summary-index warming waits this long for foreground chat and
/// activity hydration to start first.
const Duration _kSummaryWarmDelay = Duration(milliseconds: 300);

/// Something the desktop projects into the server cache on request.
sealed class HydrationKey {
  const HydrationKey();
}

/// A worktree's subtree: chat tabs plus the activity and files slices.
final class WorktreeHydration extends HydrationKey {
  const WorktreeHydration(this.worktree);
  final RemoteWorktreeKey worktree;

  @override
  bool operator ==(Object other) =>
      other is WorktreeHydration && other.worktree == worktree;

  @override
  int get hashCode => Object.hash(WorktreeHydration, worktree);
}

/// One chat's transcript.
final class ChatTranscriptHydration extends HydrationKey {
  const ChatTranscriptHydration(this.chat);
  final RemoteChatKey chat;

  @override
  bool operator ==(Object other) =>
      other is ChatTranscriptHydration && other.chat == chat;

  @override
  int get hashCode => Object.hash(ChatTranscriptHydration, chat);
}

/// A worktree's chat opened before Mobile knows which chat is selected. The
/// desktop picks the chat and projects it with the worktree's tabs.
final class ForegroundChatHydration extends HydrationKey {
  const ForegroundChatHydration(this.worktree);
  final RemoteWorktreeKey worktree;

  @override
  bool operator ==(Object other) =>
      other is ForegroundChatHydration && other.worktree == worktree;

  @override
  int get hashCode => Object.hash(ForegroundChatHydration, worktree);
}

/// The session-wide chat-summary index behind tab discovery and search.
final class ChatSummariesIndexHydration extends HydrationKey {
  const ChatSummariesIndexHydration();

  @override
  bool operator ==(Object other) => other is ChatSummariesIndexHydration;

  @override
  int get hashCode => (ChatSummariesIndexHydration).hashCode;
}

/// Where the latest request for a [HydrationKey] stands.
enum HydrationPhase {
  idle,

  /// Requested; the desktop's snapshot has not landed yet.
  pending,

  /// A chat's first request failed; its automatic retry is still due, so
  /// the chat keeps loading without an error. A final failure in the
  /// background also waits here until the return.
  retryDue,

  /// The request failed or timed out; [_HydrationSlot.error] says why,
  /// unless the error was dismissed or the chat has since delivered live.
  failed,
}

/// Request state for one [HydrationKey]. A slot lives for the session, so the
/// retry window and the one automatic retry survive between requests.
final class _HydrationSlot {
  HydrationPhase phase = HydrationPhase.idle;

  /// Whether the desktop's snapshot landed this session. Separate from
  /// [phase] because a worktree re-projection is pending while the worktree
  /// stays hydrated.
  bool hydrated = false;

  /// The latest request. Replies to an older request are ignored.
  Object? token;

  /// Fails or releases a pending request whose snapshot never lands.
  Timer? watchdog;

  /// A pending chat request's watchdog action, kept so the watchdog can be
  /// stopped in the background and re-armed on return.
  void Function()? onTimeout;

  /// The automatic chat retry, or the delayed summary-index warm-up.
  Timer? retryTimer;

  /// The automatic chat retry, or a final failure held until the return,
  /// and the earliest time it may run, kept while the background or a lost
  /// connection holds it back.
  void Function()? retry;
  DateTime? retryAt;

  /// The shown failure. Cleared while the slot stays [HydrationPhase.failed]
  /// when it is dismissed or the chat delivers live, so ensure* still sends
  /// nothing until Retry, a reopening, or a recovered connection.
  String? error;

  /// When the load last failed; a reopening waits a retry window from then.
  DateTime? failedAt;
  DateTime? lastAttempt;

  /// Foreground discovery only: the chat this load opens, bound when a named
  /// chat waits for it or when it fails. A failure without one belongs to no
  /// chat, so it never moves with the desktop's active tab (CAN-4427).
  String? owner;

  /// Whether the one automatic retry after a failure has been used.
  bool autoRetried = false;
  bool forceSnapshot = false;

  /// The chat the latest chat request asked for.
  RemoteChatTarget? target;

  /// Summary index only: the request has not been answered yet.
  bool submitting = false;

  /// Transcript commands owned by this chat's requests, released when its
  /// hydration finishes so their late terminals are treated as foreign.
  final Set<String> commandIds = {};

  /// The worktree whose tab list the unresolved request reads, and the
  /// store's tab-list mark when its earliest attempt went out.
  RemoteWorktreeKey? tabListWorktree;
  int? tabListMark;

  /// Attempts that can still deliver a chat-scope snapshot. A watchdog does
  /// not remove one because the desktop may reply after the timeout.
  final List<_ChatSnapshotReply> tabListReplies = [];

  void cancelTimers() {
    watchdog?.cancel();
    watchdog = null;
    retryTimer?.cancel();
    retryTimer = null;
  }
}

final class _ChatSnapshotReply {
  _ChatSnapshotReply(this.transcriptMark);

  final int transcriptMark;
  String? commandId;
}

enum _PipelineRunReadPhase {
  /// May read on the next [HydrationCoordinator.ensurePipelineRuns].
  idle,
  reading,

  /// The server cache was cold; reads once more when the desktop's
  /// `pipelines` snapshot lands.
  awaitingSnapshot,

  /// Waits for its retry timer, or gave up for this session.
  failed,

  /// Holds a reply until the full activity read issued meanwhile settles.
  deferred,
  done,
}

/// One worktree's chat-panel pipeline read (CAN-3619).
final class _PipelineRunRead {
  _PipelineRunReadPhase phase = _PipelineRunReadPhase.idle;

  /// A `pipelines` snapshot landed while a first read was in flight or
  /// waiting to retry; the desktop may answer before the server's cold-cache
  /// reply arrives.
  bool snapshotLanded = false;
  int failures = 0;

  /// The read in flight. Replies to an expired or replaced read are ignored.
  Object? attempt;

  /// A reply held while [_PipelineRunReadPhase.deferred]: the activity-slice
  /// read generation when the read went out, the reply's settled slices, and
  /// how to apply the reply.
  ({int? since, Map<String, dynamic>? slices, void Function() apply})? deferred;

  /// The read's deadline, the wait for the `pipelines` snapshot or for a
  /// deferring activity read, or the retry after a failure.
  Timer? timer;

  void cancelTimer() {
    timer?.cancel();
    timer = null;
  }
}

String _remoteErrorMessage(Object error) => switch (error) {
  RemoteControlException(:final message) => message,
  _ => 'Unable to load this conversation. Please try again.',
};

/// [incoming] slices whose run rows keep [held]'s chat links where they
/// leave them out; see [keepHeldPipelineRunChatTurns].
Map<String, dynamic> _slicesKeepingChatTurns(
  Map<String, dynamic> incoming,
  Map<String, dynamic>? held,
) {
  final runs = incoming['pipelineRuns'];
  final kept = keepHeldPipelineRunChatTurns(runs, held?['pipelineRuns']);
  return identical(kept, runs) ? incoming : {...incoming, 'pipelineRuns': kept};
}

/// Asks the desktop to project worktrees, chat transcripts, and the chat
/// summary index on demand, and tracks each request until its snapshot
/// lands, fails, or times out.
///
/// Snapshots arrive on the event stream, so the facade reports them through
/// the `resolve*` methods. A request that produced no data may be repeated
/// after [retryWindow]; a chat that failed retries once automatically.
final class HydrationCoordinator {
  HydrationCoordinator({
    required this.repository,
    required this.commands,
    required this.notify,
    required this.isConnected,
    required this.isBackgrounded,
    required this.snapshot,
    required this.chatSummariesFor,
    required this.hasTranscript,
    required this.openPersistedTail,
    required this.acceptsCachedTail,
    required this.seedCachedTail,
    required this.seedCurrentTail,
    required this.onChatHydrationSettled,
    this.onForegroundHydrated,
    required this.tabListMark,
    required this.transcriptMark,
    this.retryWindow = kRemoteHydrationRetryWindow,
    this.timeout = kRemoteHydrationTimeout,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final void Function() notify;
  final bool Function() isConnected;
  final bool Function() isBackgrounded;
  final RemoteSessionSnapshot? Function() snapshot;

  /// The worktree's chat tabs in display order.
  final List<RemoteChatSummary> Function(RemoteWorktreeKey worktree)
  chatSummariesFor;

  /// Whether desktop-projected rows are cached for the chat.
  final bool Function(RemoteChatKey chat) hasTranscript;

  /// Reads the tail this device persisted, synchronously, without changing
  /// its foreground recency; empty when there is none.
  final List<RemoteChatMessage> Function(RemoteChatKey chat) openPersistedTail;
  final _openedPersistedTails = <RemoteChatKey>{};

  /// Whether a cached tail from the source may paint the chat now.
  final bool Function(RemoteChatKey chat, RemoteCachedTailSource source)
  acceptsCachedTail;

  /// Paints a cached tail of a chat while its transcript loads; returns
  /// whether it did. Live and authoritative rows are never overwritten.
  final bool Function(
    RemoteChatKey chat,
    List<RemoteChatMessage> rows,
    RemoteCachedTailSource source,
  )
  seedCachedTail;

  /// Installs a cursor-verified, contiguous server tail in desktop order.
  final bool Function(RemoteChatKey chat, List<RemoteChatMessage> rows)
  seedCurrentTail;

  /// Called when a hydration stops pending and no chat hydration remains, so
  /// deferred overview reads can run.
  final void Function() onChatHydrationSettled;
  final void Function()? onForegroundHydrated;
  final tailFreshness = ChatTailFreshness();
  bool _foregroundCompleted = false;
  bool _foregroundReady = false;
  bool _summaryWarmRequested = false;

  /// A completed foreground projection releases speculative work once per
  /// session. A cache hit counts only after its cursor has been verified.
  void foregroundRequestCompleted() {
    _foregroundReady = true;
    _releaseSpeculativeWork();
  }

  void _releaseSpeculativeWork() {
    if (!_foregroundReady) return;
    if (_disposed || !isConnected() || isBackgrounded() || _isForegroundBusy) {
      return;
    }
    if (!_foregroundCompleted) {
      _foregroundCompleted = true;
      onForegroundHydrated?.call();
    }
    if (_summaryWarmRequested) ensureChatSummariesIndex(background: true);
  }

  /// The session store's current tab-list mark.
  final int Function() tabListMark;

  /// The transcript store's session-wide live revision mark.
  final int Function() transcriptMark;

  /// See [kRemoteHydrationRetryWindow].
  final Duration retryWindow;

  /// See [kRemoteHydrationTimeout].
  final Duration timeout;

  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  final Map<HydrationKey, _HydrationSlot> _slots = {};

  /// A snapshot can arrive before the command submission response supplies
  /// its id. Keep a bounded set so that response can retire the right attempt.
  final Set<String> _earlyTabListSnapshots = {};
  final Map<String, int> _settledSnapshotMarks = {};

  /// Replaced on [reset], so a read started for a discarded session cannot
  /// write into the next one.
  Object _session = Object();
  bool _disposed = false;

  /// Worktree-scoped state slices from scoped `/state` reads, keyed by
  /// worktree id. The overview snapshot the app polls deliberately excludes
  /// these entity types server-side, so they are fetched separately and
  /// overlaid — and must survive overview refreshes replacing the snapshot.
  final Map<String, Map<String, dynamic>> _worktreeStateSlices = {};

  /// Watchers use the full identity while legacy activity remains keyed by id.
  final watcherSlices = WatcherSliceStore();
  late final backgroundProcesses = BackgroundProcessHydration(
    repository: repository,
    notify: notify,
  );

  void ensureBackgroundProcesses({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    if (!isConnected()) return;
    backgroundProcesses.ensure(
      remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
    );
  }

  /// The workspace whose read last wrote each worktree's slices. Worktree
  /// ids can repeat across workspaces, so hook events check it.
  final Map<String, String> _sliceWorkspaces = {};

  /// Per-worktree memo for [worktreeActivityFor], keyed on the identity of
  /// its inputs. The snapshot's raw state and each worktree's slices are
  /// replaced rather than mutated, so identical inputs derive the same
  /// activity and callers can compare it by identity.
  final Map<
    String,
    ({
      Map<String, dynamic> base,
      Map<String, dynamic>? slices,
      RemoteWorktreeActivity activity,
    })
  >
  _activityMemo = {};

  /// Monotonic per-worktree read generation: reads after successive
  /// projections can overlap, and only the LAST-issued read may
  /// write, or a slow earlier response would clobber a fresher one.
  final Map<String, int> _sliceReadGenerations = {};

  /// Per worktree, the latest activity-slice read generation that settled,
  /// and the latest one that wrote slices.
  final Map<String, int> _settledSliceReadGenerations = {};
  final Map<String, int> _writtenSliceReadGenerations = {};

  /// Slice patches from events that arrived while a worktree's latest
  /// activity read was in flight, with that read's generation. Its reply
  /// predates them, so they apply to it again.
  final Map<
    RemoteWorktreeKey,
    ({int generation, List<WorktreeSlicePatch> patches})
  >
  _pendingSlicePatches = {};

  /// Per worktree, the snapshot event id of its latest projection.
  final Map<RemoteWorktreeKey, String> _projectionEventIds = {};

  /// Activity-slice reads in flight. Summary-index warming yields to them.
  final Set<Object> _activityReads = {};

  /// Chat-panel pipeline reads this session, keyed by worktree id.
  final Map<String, _PipelineRunRead> _pipelineRunReads = {};

  /// Each worktree's changed-file load for the Files tab (CAN-3644).
  late final _changedFiles = WorktreeActivityLoadTracker(
    timeout: timeout,
    notify: notify,
    timer: _timer,
  );

  _HydrationSlot _slotFor(HydrationKey key) =>
      _slots.putIfAbsent(key, _HydrationSlot.new);

  bool _isPending(HydrationKey key) =>
      _slots[key]?.phase == HydrationPhase.pending;

  /// Pending, or waiting for its automatic retry.
  bool _isLoading(HydrationKey key) => switch (_slots[key]?.phase) {
    HydrationPhase.pending || HydrationPhase.retryDue => true,
    _ => false,
  };

  bool _isCurrent(HydrationKey key, _HydrationSlot slot, Object token) =>
      !_disposed &&
      identical(_slots[key], slot) &&
      identical(slot.token, token);

  /// CAN-3370: whether a chat transcript or foreground chat is still loading.
  /// The desktop answers state requests one at a time, so overview reads
  /// wait until this clears (the watchdog bounds the wait).
  bool get isChatHydrationPending => _slots.entries.any(
    (entry) =>
        (entry.key is ChatTranscriptHydration ||
            entry.key is ForegroundChatHydration) &&
        entry.value.phase == HydrationPhase.pending,
  );

  /// Chats whose transcript is loading, including between attempts.
  Iterable<RemoteChatKey> get pendingChatTranscripts => [
    for (final MapEntry(:key) in _slots.entries)
      if (key case ChatTranscriptHydration(:final chat) when _isLoading(key))
        chat,
  ];

  /// Worktrees whose full-state request is pending.
  Iterable<RemoteWorktreeKey> get pendingWorktrees => [
    for (final MapEntry(:key, :value) in _slots.entries)
      if (key case WorktreeHydration(
        :final worktree,
      ) when value.phase == HydrationPhase.pending)
        worktree,
  ];

  /// Foreground hydration that background summary warming yields to.
  bool get _isForegroundBusy =>
      _activityReads.isNotEmpty ||
      _slots.entries.any(
        (entry) =>
            entry.key is! ChatSummariesIndexHydration &&
            entry.value.phase == HydrationPhase.pending,
      );

  /// True when the paired desktop can hydrate the chat-search index
  /// (the batched `worktree_chat_summaries` snapshot scope).
  bool get canSearchChats =>
      isConnected() && repository.supportsWorktreeChatSummariesScope;

  bool get isChatSummariesLoading =>
      canSearchChats && _isPending(const ChatSummariesIndexHydration());

  String? get chatSummariesError => canSearchChats
      ? _slots[const ChatSummariesIndexHydration()]?.error
      : null;

  /// True while [ensureWorktreeState] or [ensureForegroundWorktreeChat] for
  /// this worktree is still waiting on the desktop's snapshot — i.e. an empty
  /// chat-tab list is "loading", not "no chats yet".
  bool isWorktreeChatsLoading({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    final worktree = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
    return _isPending(WorktreeHydration(worktree)) ||
        _isLoading(ForegroundChatHydration(worktree));
  }

  /// True while [ensureChatTranscript] for [target] is still waiting on the
  /// desktop's transcript snapshot, including between attempts, and no
  /// messages are cached locally.
  bool isChatTranscriptLoading(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat == null || hasTranscript(chat)) return false;
    final discovery = _discoveryFor(target);
    return _isLoading(ChatTranscriptHydration(chat)) ||
        (discovery != null && _isLoading(discovery));
  }

  /// User-presentable failure from the latest transcript hydration attempt.
  String? chatHydrationError(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat == null) return null;
    return _slots[ChatTranscriptHydration(chat)]?.error ??
        _slots[_discoveryFor(target)]?.error;
  }

  /// Clears a failed transcript hydration and immediately retries it.
  void retryChatTranscript(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat == null) return;
    _restart(ChatTranscriptHydration(chat));
    if (_discoveryFor(target) case final discovery?
        when _slots[discovery]?.phase == HydrationPhase.failed) {
      _restart(discovery);
    }
    ensureChatTranscript(target);
    notify();
  }

  /// Hides [target]'s failure until its load fails again.
  void dismissChatHydrationError(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat != null && clearChatHydrationError(chat)) notify();
  }

  /// Hides [chat]'s load failure without loading it: the user dismissed it,
  /// or the chat delivered live. Its load stays failed, so rebuilds send
  /// nothing; a later failure shows again. Returns whether an error cleared.
  bool clearChatHydrationError(RemoteChatKey chat) {
    var cleared = false;
    for (final MapEntry(:key, value: slot) in _slots.entries) {
      final owns = switch (key) {
        ChatTranscriptHydration(chat: final own) => own == chat,
        ForegroundChatHydration() =>
          chat.scope == RemoteChatScope.worktree && slot.owner == chat.chatId,
        _ => false,
      };
      if (!owns || slot.phase != HydrationPhase.failed || slot.error == null) {
        continue;
      }
      slot.error = null;
      cleared = true;
    }
    return cleared;
  }

  /// [target] came back on screen. Its failed load goes out once more when a
  /// retry window has passed since the failure. [ensureChatTranscript] never
  /// restarts a failed load, so rebuilds cannot start a retry cycle.
  void reopenChatTranscript(RemoteChatTarget target) {
    final chat = remoteChatKeyForTarget(target);
    if (chat == null || !isConnected()) return;
    final now = _clock();
    var restarted = false;
    for (final key in [ChatTranscriptHydration(chat), ?_discoveryFor(target)]) {
      final slot = _slots[key];
      final failedAt = slot?.failedAt;
      if (slot?.phase != HydrationPhase.failed ||
          (failedAt != null && now.difference(failedAt) < retryWindow)) {
        continue;
      }
      _restart(key);
      restarted = true;
    }
    if (!restarted) return;
    ensureChatTranscript(target);
    notify();
  }

  /// Event delivery or the desktop came back: failed chat loads are
  /// forgotten, so each chat loads again when it is next shown. A failed
  /// discovery in a worktree with no known chat goes out again now, because
  /// its screen has no chat to load.
  void restartFailedChatLoads() {
    var restarted = false;
    for (final MapEntry(:key, value: slot) in _slots.entries.toList()) {
      if ((key is ChatTranscriptHydration || key is ForegroundChatHydration) &&
          slot.phase == HydrationPhase.failed) {
        _restart(key);
        restarted = true;
        if (key case ForegroundChatHydration(
          :final worktree,
        ) when _selectedChatIn(worktree) == null) {
          _ensureForegroundWorktreeChat(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.worktreeLocalId,
          );
        }
      }
    }
    if (restarted) notify();
  }

  /// The foreground discovery still loading [target], or failed loading it:
  /// [target] is the chat it opens, and the chat has no load of its own.
  /// The chat waits for the discovery and takes over its automatic retry,
  /// so one load makes at most two automatic attempts. A discovery bound to a
  /// chat stays with it; an unbound one opens the selected chat until it
  /// fails.
  ForegroundChatHydration? _discoveryFor(RemoteChatTarget target) {
    if (target case RemoteWorktreeChatTarget(
      :final workspaceLocalId,
      :final worktreeLocalId,
      :final chatId?,
    )) {
      final own =
          _slots[ChatTranscriptHydration((
            scope: target.scope,
            chatId: chatId,
          ))];
      if (own != null && (own.hydrated || own.phase != HydrationPhase.idle)) {
        return null;
      }
      final worktree = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
      final key = ForegroundChatHydration(worktree);
      final discovery = _slots[key];
      if (discovery == null ||
          discovery.hydrated ||
          discovery.phase == HydrationPhase.idle) {
        return null;
      }
      final opens = switch (discovery.owner) {
        final owner? => owner,
        null when discovery.phase == HydrationPhase.failed => null,
        null => _selectedChatIn(worktree),
      };
      return opens == chatId ? key : null;
    }
    return null;
  }

  /// The chat foreground discovery opens: the active tab, else the first.
  String? _selectedChatIn(RemoteWorktreeKey worktree) {
    final summaries = chatSummariesFor(worktree);
    return summaries.where((s) => s.active == true).firstOrNull?.chatId ??
        summaries.firstOrNull?.chatId;
  }

  String? foregroundChatError(
    String workspaceLocalId,
    String worktreeLocalId,
  ) =>
      _slots[ForegroundChatHydration(
            remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
          )]
          ?.error;

  void retryForegroundChat(String workspaceLocalId, String worktreeLocalId) {
    _restart(
      ForegroundChatHydration(
        remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
      ),
    );
    ensureForegroundWorktreeChat(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
    notify();
  }

  /// Forgets the error and the retry window so the next request goes out.
  void _restart(HydrationKey key) {
    final slot = _slots[key];
    if (slot == null) return;
    // Earlier attempts can still reply after a manual retry.
    _finish(slot, preserveTabList: true);
    _clearError(slot);
    slot.lastAttempt = null;
    slot.forceSnapshot = true;
  }

  /// Opens chat independently from lazy activity. Existing hosts retain the
  /// full-worktree fallback; a known selection starts its transcript first.
  void ensureForegroundWorktreeChat({
    required String workspaceLocalId,
    required String worktreeLocalId,
    String? chatId,
  }) => _ensureForegroundWorktreeChat(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    chatId: chatId,
  );

  /// [isAutoRetry]: discovery's automatic retry, which a chat named since
  /// then takes over as its last attempt.
  void _ensureForegroundWorktreeChat({
    required String workspaceLocalId,
    required String worktreeLocalId,
    String? chatId,
    bool isAutoRetry = false,
  }) {
    if (!isConnected()) return;
    final worktree = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
    final key = ForegroundChatHydration(worktree);
    // A bound discovery's automatic retry goes to its own chat.
    final selected =
        chatId ??
        (isAutoRetry ? _slots[key]?.owner : null) ??
        _selectedChatIn(worktree);
    if (selected != null) {
      _ensureChatTranscript(
        RemoteWorktreeChatTarget(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          chatId: selected,
        ),
        isAutoRetry: isAutoRetry,
      );
    }
    if (!repository.supportsForegroundChat) {
      ensureWorktreeState(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
      );
      return;
    }
    if (selected != null) return;
    if (!_canRequest(key)) return;
    _slotFor(key).owner = null;
    _requestChat(
      key,
      RemoteWorktreeChatTarget(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
      ),
      retry: () => _ensureForegroundWorktreeChat(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        isAutoRetry: true,
      ),
    );
  }

  /// Asks the desktop to hydrate [worktreeLocalId]'s subtree (chat tabs,
  /// activity). Results arrive as state events. Skipped while a request is
  /// already in flight or a worktree-scoped snapshot already resolved this
  /// session; a request that never materialized a snapshot may re-fire once
  /// [retryWindow] elapses, so transient failures self-heal.
  ///
  /// [refresh] re-projects an already-hydrated worktree (still single-flight).
  /// The desktop never pushes changed files unsolicited, so the server cache
  /// keeps the roster from the last projection while overview diff totals
  /// move on; surfaces that show the roster must ask again.
  void ensureWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
    bool refresh = false,
  }) {
    if (!isConnected()) return;
    final key = WorktreeHydration(
      remoteWorktreeKey(workspaceLocalId, worktreeLocalId),
    );
    final existing = _slots[key];
    if (existing?.phase == HydrationPhase.pending) return;
    if (!refresh && existing?.hydrated == true) return;
    final slot = _slotFor(key);
    if (refresh) {
      slot.lastAttempt = _clock();
    } else if (!_recordAttempt(slot)) {
      return;
    }
    // No synchronous notify: ensure* is called from initState/build, and the
    // caller reads the pending state in the same pass.
    final token = Object();
    slot.token = token;
    slot.phase = HydrationPhase.pending;
    // Only this request's projection can confirm the changed files now.
    _changedFiles.requested(worktreeLocalId);
    _armWatchdog(slot, () {
      if (slot.phase != HydrationPhase.pending) return;
      slot.phase = HydrationPhase.idle;
      notify();
    });
    unawaited(() async {
      try {
        // The desktop projects the worktree subtree into the server cache.
        // Its snapshot event signals the landing, and the engine reads the
        // activity slices then; a read before it confirms nothing.
        await repository.requestWorktreeState(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
        );
      } catch (_) {
        if (!_isCurrent(key, slot, token)) return;
        // Clear the spinner; the retry window allows a fresh attempt.
        _clearPending(key);
        _changedFiles.requestFailed(worktreeLocalId);
        notify();
        // No snapshot will follow. With nothing held, the server cache is
        // better than empty Activity cards; it cannot settle the load.
        if (!_worktreeStateSlices.containsKey(worktreeLocalId)) {
          unawaited(
            refreshWorktreeActivity(
              workspaceLocalId: workspaceLocalId,
              worktreeLocalId: worktreeLocalId,
            ),
          );
        }
      }
    }());
  }

  /// Re-projects [worktreeLocalId]'s changed files; the read after the
  /// projection's snapshot brings them back. Runs on every opening of the
  /// Activity & files drawer (the desktop never pushes changed files
  /// unsolicited) and on the Files tab's Retry.
  void refreshChangedFiles({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    if (!isConnected()) return;
    final before = changedFilesStatus(worktreeLocalId);
    _loadChangedFiles(workspaceLocalId, worktreeLocalId);
    if (changedFilesStatus(worktreeLocalId) != before) notify();
  }

  /// Starts [worktreeLocalId]'s changed-file load unless this session
  /// already has one. The open drawer calls it on every build, so a
  /// replaced session loads again while the drawer stays open. No
  /// synchronous notify: the caller reads the status in the same pass.
  void ensureChangedFiles({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    if (!isConnected() ||
        _changedFiles.statusFor(worktreeLocalId) !=
            ChangedFilesLoadStatus.idle) {
      return;
    }
    _loadChangedFiles(workspaceLocalId, worktreeLocalId);
  }

  void _loadChangedFiles(String workspaceLocalId, String worktreeLocalId) {
    // A projection already in flight keeps its request; its landing, even
    // one that arrived before this load started, also answers this load.
    // Held slices stay on screen until the read after the landing.
    _changedFiles.begin(worktreeLocalId);
    ensureWorktreeState(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      refresh: true,
    );
  }

  /// Whether [worktreeLocalId]'s changed files are loading, loaded, or
  /// failed to load; idle until a load of this session starts. Without a
  /// connection, only an already loaded list stands, and nothing offers a
  /// retry: [refreshChangedFiles] cannot request until a reconnect.
  ChangedFilesLoadStatus changedFilesStatus(String worktreeLocalId) {
    final status = _changedFiles.statusFor(worktreeLocalId);
    if (!isConnected() && status.phase != ChangedFilesLoadPhase.loaded) {
      return ChangedFilesLoadStatus.offline;
    }
    return status;
  }

  /// Worktree-scope snapshots signalled that the desktop projected
  /// [worktrees] into the server cache; reads issued from now on are
  /// authoritative for their changed files.
  void markWorktreesProjected(Iterable<RemoteWorktreeKey> worktrees) {
    for (final worktree in worktrees) {
      final id = worktree.worktreeLocalId;
      _changedFiles.projected(id, _sliceReadGenerations[id] ?? 0);
    }
  }

  /// Asks the desktop to project one chat's transcript. Results arrive as a
  /// chat-scoped snapshot event carrying the messages. Same in-flight /
  /// already-hydrated / retry-window rules as [ensureWorktreeState].
  ///
  /// A tail this device persisted paints at once, before the request goes
  /// out, so a chat reopened after a cold start shows it on its first frame.
  /// The server's cached tail and then the snapshot replace it.
  void ensureChatTranscript(RemoteChatTarget target) =>
      _ensureChatTranscript(target);

  void _ensureChatTranscript(
    RemoteChatTarget target, {
    bool isAutoRetry = false,
  }) {
    if (!isConnected()) return;
    final chat = remoteChatKeyForTarget(target);
    if (chat == null) return;
    final persisted = _openedPersistedTails.add(chat)
        ? openPersistedTail(chat)
        : const <RemoteChatMessage>[];
    if (_discoveryFor(target) case final discovery?) {
      // Discovery owns the request, but the named chat can paint immediately.
      // The first chat that waits for it owns its failure.
      _slots[discovery]!.owner ??= chat.chatId;
      seedCachedTail(chat, persisted, RemoteCachedTailSource.device);
      return;
    }
    final key = ChatTranscriptHydration(chat);
    if (!_canRequest(key)) return;
    // Seeding does not notify: the caller reads it in the same build pass.
    seedCachedTail(chat, persisted, RemoteCachedTailSource.device);
    // Discovery's automatic retry leaves no further automatic attempt.
    if (isAutoRetry) _slotFor(key).autoRetried = true;
    _requestChat(key, target, retry: () => ensureChatTranscript(target));
  }

  /// Whether a chat request for [key] may go out now; records the attempt.
  bool _canRequest(HydrationKey key) {
    final existing = _slots[key];
    if (existing != null &&
        (existing.phase != HydrationPhase.idle || existing.hydrated)) {
      return false;
    }
    return _recordAttempt(_slotFor(key));
  }

  void _requestChat(
    HydrationKey key,
    RemoteChatTarget target, {
    required void Function() retry,
  }) {
    final slot = _slotFor(key);
    final token = Object();
    final tabListReply = _ChatSnapshotReply(transcriptMark());
    slot.tabListReplies.add(tabListReply);
    slot.token = token;
    slot.phase = HydrationPhase.pending;
    slot.target = target;
    if (target case RemoteWorktreeChatTarget(
      :final workspaceLocalId,
      :final worktreeLocalId,
    )) {
      // Retries keep the first mark: a slow earlier reply may still land.
      slot.tabListWorktree = remoteWorktreeKey(
        workspaceLocalId,
        worktreeLocalId,
      );
      slot.tabListMark ??= tabListMark();
    }
    bool isCurrent() =>
        _isCurrent(key, slot, token) && slot.phase == HydrationPhase.pending;
    void fail(String message, {bool mayReply = false}) {
      if (!mayReply) {
        _forgetTabListReply(slot, tabListReply);
      }
      if (!isCurrent()) return;
      slot.onTimeout = null;
      _clearPending(key);
      final isFinal = slot.autoRetried;
      if (isFinal && !isBackgrounded()) {
        _showFailure(key, slot, message);
        notify();
        return;
      }
      // The first failure stays quiet while the one automatic retry is due,
      // and a final failure in the background until the return.
      slot.phase = HydrationPhase.retryDue;
      slot.retryAt = isFinal ? _clock() : _clock().add(retryWindow);
      slot.retry = () {
        if (!_isCurrent(key, slot, token)) return;
        // Without a connection the retry stays due, unused, for the next
        // return.
        if (!isFinal && !isConnected()) return;
        slot.retry = null;
        slot.retryAt = null;
        slot.autoRetried = true;
        if (isFinal) {
          _showFailure(key, slot, message);
          return;
        }
        slot.phase = HydrationPhase.idle;
        slot.lastAttempt = null;
        retry();
      };
      _scheduleRetry(slot);
      notify();
    }

    // The desktop may still reply after a timeout, so keep its tab-list
    // reply open.
    void onTimeout() => fail(
      'The conversation took too long to load. Try again.',
      mayReply: true,
    );
    slot.onTimeout = onTimeout;
    // A request sent from the background is timed from the return.
    if (!isBackgrounded()) _armWatchdog(slot, onTimeout);
    final chat = remoteChatKeyForTarget(target);
    final verifyTail =
        chat != null &&
        !slot.autoRetried &&
        !slot.forceSnapshot &&
        tailFreshness.requiredCursor(chat, snapshot()?.eventCursor) != null;
    if (chat != null && !verifyTail) {
      unawaited(_readCachedTail(target, chat, isCurrent));
    }
    unawaited(() async {
      try {
        if (chat != null && verifyTail) {
          final current = await _readCachedTail(target, chat, isCurrent);
          if (!isCurrent()) return;
          if (current) {
            _forgetTabListReply(slot, tabListReply);
            resolveChatTranscript(chat);
            notify();
            return;
          }
        }
        if (!isCurrent()) return;
        final commandId = await repository.requestChatTranscript(target);
        if (_disposed || !identical(_slots[key], slot)) return;
        if (!slot.tabListReplies.contains(tabListReply)) return;
        if (commandId != null && commandId.isNotEmpty) {
          tabListReply.commandId = commandId;
          if (_earlyTabListSnapshots.remove(commandId)) {
            _forgetTabListReply(slot, tabListReply);
            return;
          }
        }
        if (commandId == null || commandId.isEmpty) return;
        slot.commandIds.add(commandId);
        // Completion is observed through the transcript snapshot instead.
        commands.register(commandId, recordOutcome: false, onFailed: fail);
      } catch (error) {
        fail(_remoteErrorMessage(error));
      }
    }());
  }

  /// Paints a cached tail and verifies that its projection covers the
  /// overview and every observed event for this chat. An unproven tail
  /// remains provisional while the desktop snapshot reconciles it.
  Future<bool> _readCachedTail(
    RemoteChatTarget target,
    RemoteChatKey chat,
    bool Function() isCurrent,
  ) async {
    const source = RemoteCachedTailSource.server;
    if (!isCurrent() || isBackgrounded() || !acceptsCachedTail(chat, source)) {
      return false;
    }
    try {
      final tail = await repository.fetchCachedChatTail(target);
      if (!isCurrent()) return false;
      final messages = [
        for (final message in tail.messages)
          if (message.chatId == target.chatId && message.scope == target.scope)
            message,
      ];
      final proven =
          messages.length == tail.messages.length &&
          tail.covers(
            tailFreshness.requiredCursor(chat, snapshot()?.eventCursor),
          );
      final ordered = proven ? tail.orderedMessages : null;
      final seeded = ordered != null
          ? seedCurrentTail(chat, ordered)
          : seedCachedTail(chat, messages, source);
      if (seeded) notify();
      final current = proven && seeded;
      if (current) {
        if (tail.eventCursor case final cursor?) {
          tailFreshness.verify(chat, cursor);
        }
      }
      return current;
    } catch (_) {
      return false;
    }
  }

  /// A legacy live event could replay older content over a verified cache.
  /// Reconcile through the normal desktop snapshot path once.
  void reconcileUnsequencedTail(RemoteChatKey chat) {
    final key = ChatTranscriptHydration(chat);
    final slot = _slots[key];
    final target = slot?.target;
    if (slot == null ||
        target == null ||
        slot.phase == HydrationPhase.pending) {
      return;
    }
    slot.hydrated = false;
    _restart(key);
    ensureChatTranscript(target);
  }

  /// Records a hydration attempt, returning false while the retry window
  /// from the previous attempt is still open.
  bool _recordAttempt(_HydrationSlot slot) {
    final now = _clock();
    final last = slot.lastAttempt;
    if (last != null && now.difference(last) < retryWindow) return false;
    slot.lastAttempt = now;
    return true;
  }

  /// A load's final failure. A discovery that no chat waited for binds to
  /// the chat selected now, if any.
  void _showFailure(HydrationKey key, _HydrationSlot slot, String message) {
    slot.phase = HydrationPhase.failed;
    slot.error = message;
    slot.failedAt = _clock();
    if (key case ForegroundChatHydration(:final worktree)) {
      slot.owner ??= _selectedChatIn(worktree);
    }
  }

  void _armWatchdog(_HydrationSlot slot, void Function() onTimeout) {
    slot.watchdog?.cancel();
    slot.watchdog = _timer(timeout, () {
      slot.watchdog = null;
      onTimeout();
    });
  }

  /// Arms [slot]'s automatic chat retry for its due time, or for the
  /// return if the app is in the background.
  void _scheduleRetry(_HydrationSlot slot) {
    final retry = slot.retry;
    final retryAt = slot.retryAt;
    if (retry == null || retryAt == null || isBackgrounded()) return;
    slot.retryTimer?.cancel();
    final delay = retryAt.difference(_clock());
    slot.retryTimer = _timer(delay.isNegative ? Duration.zero : delay, () {
      slot.retryTimer = null;
      if (_disposed || isBackgrounded() || !identical(slot.retry, retry)) {
        return;
      }
      retry();
      notify();
    });
  }

  /// Stops chat watchdogs and automatic retries while the app is in the
  /// background, where the desktop's replies cannot arrive. Requests stay
  /// pending, so a reply that lands on return still resolves them.
  void pauseChatLoads() {
    for (final slot in _slots.values) {
      if (slot.onTimeout != null) {
        slot.watchdog?.cancel();
        slot.watchdog = null;
      }
      if (slot.retry != null) {
        slot.retryTimer?.cancel();
        slot.retryTimer = null;
      }
    }
  }

  /// Gives each chat request [pauseChatLoads] stopped a fresh full timeout,
  /// and sends each held retry once its delay since the failure has passed.
  void resumeChatLoads() {
    _releaseSpeculativeWork();
    for (final slot in _slots.values) {
      if (slot.onTimeout case final onTimeout? when slot.watchdog == null) {
        _armWatchdog(slot, onTimeout);
      }
      if (slot.retryTimer == null) _scheduleRetry(slot);
    }
  }

  void _clearPending(HydrationKey key) {
    final slot = _slots[key];
    if (slot != null) {
      if (slot.phase == HydrationPhase.pending) {
        slot.phase = HydrationPhase.idle;
      }
      slot.watchdog?.cancel();
      slot.watchdog = null;
    }
    if (!isChatHydrationPending) onChatHydrationSettled();
    _releaseSpeculativeWork();
  }

  void _clearError(_HydrationSlot slot) {
    slot.error = null;
    if (slot.phase case HydrationPhase.failed || HydrationPhase.retryDue) {
      slot.phase = HydrationPhase.idle;
    }
  }

  /// Ends the chat's current request: later replies and the automatic retry
  /// are dropped, and its transcript commands become foreign.
  void _finish(_HydrationSlot slot, {bool preserveTabList = false}) {
    slot.token = null;
    slot.owner = null;
    if (!preserveTabList) {
      slot.tabListWorktree = null;
      slot.tabListMark = null;
      slot.tabListReplies.clear();
    }
    slot.autoRetried = false;
    slot.onTimeout = null;
    slot.retry = null;
    slot.retryAt = null;
    slot.retryTimer?.cancel();
    slot.retryTimer = null;
    for (final commandId in slot.commandIds) {
      if (!slot.tabListReplies.any((reply) => reply.commandId == commandId)) {
        commands.release(commandId);
      }
    }
    slot.commandIds.clear();
  }

  void _forgetTabListReply(_HydrationSlot slot, _ChatSnapshotReply reply) {
    if (!slot.tabListReplies.remove(reply)) return;
    if (reply.commandId case final commandId?) {
      slot.commandIds.remove(commandId);
      commands.release(commandId);
      _rememberSettledTabListCommand(commandId, reply.transcriptMark);
    }
    if (slot.tabListReplies.isEmpty) {
      slot.tabListWorktree = null;
      slot.tabListMark = null;
    }
  }

  void _resolveTabListReply(_HydrationSlot slot, String? commandId) {
    if (commandId == null) {
      if (slot.tabListReplies.isNotEmpty) {
        _forgetTabListReply(slot, slot.tabListReplies.first);
      }
      return;
    }
    if (_settledSnapshotMarks.containsKey(commandId)) return;
    for (final owner in _slots.values) {
      for (final reply in owner.tabListReplies) {
        if (reply.commandId != commandId) continue;
        _forgetTabListReply(owner, reply);
        return;
      }
    }
    _earlyTabListSnapshots.add(commandId);
    if (_earlyTabListSnapshots.length > 32) {
      _earlyTabListSnapshots.remove(_earlyTabListSnapshots.first);
    }
  }

  void _rememberSettledTabListCommand(String commandId, int mark) {
    _settledSnapshotMarks[commandId] = mark;
    if (_settledSnapshotMarks.length > 32) {
      _settledSnapshotMarks.remove(_settledSnapshotMarks.keys.first);
    }
  }

  /// The baseline for a chat-scope snapshot replacing [worktree]'s tabs: the
  /// earliest tab-list mark among its unresolved requests. Null when this
  /// client has none, so an unsolicited snapshot replaces the tabs outright.
  int? tabListBaselineFor(RemoteWorktreeKey worktree) {
    int? baseline;
    for (final slot in _slots.values) {
      final mark = slot.tabListMark;
      if (mark == null || slot.tabListWorktree != worktree) continue;
      if (baseline == null || mark < baseline) baseline = mark;
    }
    return baseline;
  }

  /// The live-row baseline of the request that produced a chat snapshot.
  /// Retries retain their own marks, including after another attempt settles.
  /// Before an HTTP reply supplies its command id, use the earliest possible
  /// matching request. Unsolicited snapshots keep replacement semantics.
  int? transcriptBaselineFor(
    RemoteChatKey chat, {
    RemoteWorktreeKey? worktree,
    String? commandId,
  }) {
    final settled = _settledSnapshotMarks[commandId];
    if (settled != null) return settled;
    int? baseline;
    for (final entry in _slots.entries) {
      final matches = switch (entry.key) {
        ChatTranscriptHydration(chat: final requested) => requested == chat,
        ForegroundChatHydration(worktree: final requested) =>
          requested == worktree,
        _ => false,
      };
      if (!matches) continue;
      for (final reply in entry.value.tabListReplies) {
        if (commandId != null && reply.commandId == commandId) {
          return reply.transcriptMark;
        }
        if (commandId != null && reply.commandId != null) continue;
        if (baseline == null || reply.transcriptMark < baseline) {
          baseline = reply.transcriptMark;
        }
      }
    }
    return baseline;
  }

  /// A chat-targeted snapshot delivered [chat]'s transcript.
  void resolveChatTranscript(RemoteChatKey chat, {String? commandId}) {
    final key = ChatTranscriptHydration(chat);
    final slot = _slotFor(key)..hydrated = true;
    _resolveTabListReply(slot, commandId);
    _finish(slot, preserveTabList: slot.tabListReplies.isNotEmpty);
    _clearError(slot);
    _clearPending(key);
    foregroundRequestCompleted();
  }

  /// A chat-scope snapshot delivered [worktree]'s tabs and selected chat,
  /// [chat] when it names one. A snapshot of another chat leaves a
  /// discovery failure bound to its own chat (CAN-4427).
  void resolveForegroundChat(
    RemoteWorktreeKey worktree, {
    RemoteChatKey? chat,
    String? commandId,
  }) {
    _clearPending(WorktreeHydration(worktree));
    final key = ForegroundChatHydration(worktree);
    final slot = _slotFor(key);
    _resolveTabListReply(slot, commandId);
    if (slot.phase == HydrationPhase.failed &&
        slot.owner != null &&
        chat != null &&
        chat.chatId != slot.owner) {
      return;
    }
    _finish(slot, preserveTabList: slot.tabListReplies.isNotEmpty);
    _clearError(slot);
    _clearPending(key);
    slot.hydrated = true;
    foregroundRequestCompleted();
  }

  /// Whether the worktree snapshot event [eventId] repeats [worktree]'s
  /// latest projection: a repeated delivery, whose read already went out.
  /// Records a new projection otherwise.
  bool repeatsProjection(RemoteWorktreeKey worktree, String? eventId) {
    if (eventId == null) return false;
    if (_projectionEventIds[worktree] == eventId) return true;
    _projectionEventIds[worktree] = eventId;
    return false;
  }

  /// Whether [worktree] shows a chat-tab placeholder that only an overview
  /// read can fill: its first hydration has not landed and no tab is known.
  /// A worktree snapshot normally carries the tabs.
  bool needsTabListRead(RemoteWorktreeKey worktree) =>
      _slots[WorktreeHydration(worktree)]?.hydrated != true &&
      chatSummariesFor(worktree).isEmpty;

  /// The reads after worktree snapshots landed: [resolved] stop loading,
  /// and [hydrated] had their activity projected.
  void resolveWorktrees(
    Set<RemoteWorktreeKey> resolved,
    Set<RemoteWorktreeKey> hydrated,
  ) {
    for (final worktree in resolved) {
      _clearPending(WorktreeHydration(worktree));
    }
    for (final worktree in hydrated) {
      _slotFor(WorktreeHydration(worktree)).hydrated = true;
    }
  }

  /// The summary-index snapshot landed.
  bool resolveChatSummariesIndex() {
    final slot = _slotFor(const ChatSummariesIndexHydration())..hydrated = true;
    final changed = slot.phase != HydrationPhase.idle || slot.error != null;
    slot.retryTimer?.cancel();
    slot.retryTimer = null;
    slot.watchdog?.cancel();
    slot.watchdog = null;
    slot.onTimeout = null;
    slot.phase = HydrationPhase.idle;
    slot.error = null;
    slot.token = null;
    slot.submitting = false;
    return changed;
  }

  /// The activity + files slices for [worktreeLocalId], for the
  /// activity/files sidebar: the scoped-read slices overlaid on the base
  /// snapshot. Empty until [refreshWorktreeActivity] has fetched them.
  RemoteWorktreeActivity worktreeActivityFor(String worktreeLocalId) {
    final base = snapshot()?.raw ?? const <String, dynamic>{};
    final slices = _worktreeStateSlices[worktreeLocalId];
    final memo = _activityMemo[worktreeLocalId];
    if (memo != null &&
        identical(memo.base, base) &&
        identical(memo.slices, slices)) {
      return memo.activity;
    }
    final activity = RemoteWorktreeActivity.fromState(
      worktreeLocalId: worktreeLocalId,
      state: slices == null
          ? base
          : {...base, ..._slicesKeepingChatTurns(slices, base)},
    );
    _activityMemo[worktreeLocalId] = (
      base: base,
      slices: slices,
      activity: activity,
    );
    return activity;
  }

  /// Re-reads the worktree-scoped state slices for the activity sidebar.
  /// Nothing pushes changed files incrementally on the wire, so the engine
  /// runs this after each worktree projection lands. A failure keeps the
  /// previous (possibly empty) data; [changedFilesStatus] reports it when
  /// the read followed the projection the Files tab waits for.
  Future<void> refreshWorktreeActivity({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    if (!isConnected()) return;
    final session = _session;
    final worktree = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
    final watcherRead = watcherSlices.beginRead(worktree);
    final processRead = backgroundProcesses.beginRead(worktree);
    final generation = (_sliceReadGenerations[worktreeLocalId] ?? 0) + 1;
    _sliceReadGenerations[worktreeLocalId] = generation;
    final read = Object();
    _activityReads.add(read);
    try {
      final result = await repository.fetchWorktreeStateSlices(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
      );
      if (!identical(session, _session) || !isConnected()) return;
      final processChanged =
          !result.refreshing &&
          backgroundProcesses.settleRead(worktree, processRead, result.slices);
      final watcherChanged =
          (!result.refreshing &&
              watcherSlices.settleRead(worktree, watcherRead, result.slices)) ||
          processChanged;
      // A newer read of the legacy activity slot wins there. Watchers have
      // their own full-identity read ordering, so both workspaces can settle.
      if (_sliceReadGenerations[worktreeLocalId] != generation) {
        if (watcherChanged) notify();
        return;
      }
      // A cold or mid-refresh server cache is not authoritative: keep the
      // previously-fetched slices instead of dropping them for a blank.
      if (result.refreshing) return;
      // A successful settled read is authoritative even when empty — a
      // worktree whose changes were all committed must stop showing stale
      // files. Only failed/refreshing reads preserve the previous slices,
      // and a read issued before the pending load's projection landed keeps
      // the changed files already held: that cache confirms nothing.
      // Run rows that leave their chat links out keep the held ones.
      // Events that arrived during the read apply to its reply.
      final held = _worktreeStateSlices[worktreeLocalId];
      var slices = _slicesKeepingChatTurns(result.slices, held);
      if (held != null &&
          held.containsKey('changedFiles') &&
          _changedFiles.predatesProjection(worktreeLocalId, generation)) {
        slices = {...slices, 'changedFiles': held['changedFiles']};
      }
      final pending =
          _pendingSlicePatches[remoteWorktreeKey(
            workspaceLocalId,
            worktreeLocalId,
          )];
      if (pending?.generation == generation) {
        for (final patch in pending!.patches) {
          slices = patch(slices);
        }
      }
      _worktreeStateSlices[worktreeLocalId] = slices;
      _sliceWorkspaces[worktreeLocalId] = workspaceLocalId;
      _writtenSliceReadGenerations[worktreeLocalId] = generation;
      _changedFiles.readSettled(worktreeLocalId, generation);
      notify();
    } on Object {
      // Keep whatever the sidebar already has.
      if (identical(session, _session) &&
          _sliceReadGenerations[worktreeLocalId] == generation &&
          _changedFiles.readFailed(worktreeLocalId, generation)) {
        notify();
      }
    } finally {
      watcherSlices.finishRead(worktree, watcherRead);
      backgroundProcesses.finishRead(worktree, processRead);
      _activityReads.remove(read);
      _releaseSpeculativeWork();
      if (identical(session, _session) &&
          _sliceReadGenerations[worktreeLocalId] == generation) {
        _settledSliceReadGenerations[worktreeLocalId] = generation;
        _pendingSlicePatches.removeWhere(
          (worktree, _) => worktree.worktreeLocalId == worktreeLocalId,
        );
        if (_pipelineRunReads[worktreeLocalId] case final pipelineRead?) {
          _resumePipelineRunRead(pipelineRead, worktreeLocalId);
        }
      }
    }
  }

  /// Applies the desktop's hook descriptor upsert or removal to the held
  /// activity slices of its worktree. See [applySlicePatch].
  bool applyHookDescriptor(RemoteHookDescriptorEvent event) => applySlicePatch(
    remoteWorktreeKey(event.workspaceLocalId, event.worktreeLocalId),
    (slices) => withHookDescriptor(slices, event),
  );

  /// Applies a live event's [patch] to the held activity slices of
  /// [worktree], when that workspace's read wrote them. A read in flight
  /// gets the patch too: its reply predates it. Returns whether the shown
  /// slices changed.
  bool applySlicePatch(RemoteWorktreeKey worktree, WorktreeSlicePatch patch) {
    final processChanged = backgroundProcesses.applySlicePatch(worktree, patch);
    final watcherChanged =
        watcherSlices.applySlicePatch(worktree, patch) || processChanged;
    final worktreeLocalId = worktree.worktreeLocalId;
    final generation = _sliceReadGenerations[worktreeLocalId];
    if (generation != null &&
        _settledSliceReadGenerations[worktreeLocalId] != generation) {
      final pending = _pendingSlicePatches[worktree];
      _pendingSlicePatches[worktree] = (
        generation: generation,
        patches: [
          if (pending?.generation == generation) ...pending!.patches,
          patch,
        ],
      );
    }
    final held = _worktreeStateSlices[worktreeLocalId];
    if (held == null ||
        _sliceWorkspaces[worktreeLocalId] != worktree.workspaceLocalId) {
      return watcherChanged;
    }
    final next = patch(held);
    if (identical(next, held)) return watcherChanged;
    _worktreeStateSlices[worktreeLocalId] = next;
    return true;
  }

  /// Reads [worktreeLocalId]'s pipeline runs once per session, so a worktree
  /// chat shows the runs linked to its turns before Activity & files opens.
  /// Uses the narrow `pipelines` scope: a cold server cache asks the desktop
  /// for that worktree's pipelines only, never the full worktree (CAN-3101).
  /// Skipped once the activity slices are held, and while disconnected, so
  /// callers repeat it as the session changes. A failed read retries after
  /// [retryWindow], up to three attempts per session.
  void ensurePipelineRuns({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    if (!isConnected() || _worktreeStateSlices.containsKey(worktreeLocalId)) {
      return;
    }
    final read = _pipelineRunReads.putIfAbsent(
      worktreeLocalId,
      _PipelineRunRead.new,
    );
    if (read.phase != _PipelineRunReadPhase.idle) return;
    _readPipelineRuns(
      read,
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      first: true,
    );
  }

  /// The desktop answered a `pipelines` request for [worktreeLocalId]: reads
  /// once more when [ensurePipelineRuns] found the cache cold, including when
  /// the snapshot overtook that reply.
  void resolvePipelineRuns({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    final read = _pipelineRunReads[worktreeLocalId];
    if (read == null) return;
    switch (read.phase) {
      case _PipelineRunReadPhase.reading ||
          _PipelineRunReadPhase.failed ||
          _PipelineRunReadPhase.deferred:
        read.snapshotLanded = true;
      case _PipelineRunReadPhase.awaitingSnapshot:
        read.cancelTimer();
        _readPipelineRuns(
          read,
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          first: false,
        );
      case _PipelineRunReadPhase.idle || _PipelineRunReadPhase.done:
        return;
    }
  }

  void _readPipelineRuns(
    _PipelineRunRead read, {
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool first,
  }) {
    final session = _session;
    final generation = _sliceReadGenerations[worktreeLocalId];
    final attempt = Object();
    read.cancelTimer();
    read
      ..phase = _PipelineRunReadPhase.reading
      ..attempt = attempt;
    // A follow-up read answers the snapshot that triggered it; a first read
    // keeps one that landed while an earlier attempt was outstanding.
    if (!first) read.snapshotLanded = false;
    bool isCurrent() =>
        identical(session, _session) &&
        identical(_pipelineRunReads[worktreeLocalId], read) &&
        identical(read.attempt, attempt);
    void retry() {
      read.attempt = null;
      _failPipelineRunRead(
        read,
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
      );
    }

    // The request itself has no deadline, so an accepted request that is
    // never answered would hold this single-flight read for the session.
    read.timer = _timer(timeout, () {
      read.timer = null;
      if (isCurrent()) retry();
    });
    unawaited(() async {
      final ({Map<String, dynamic> slices, bool refreshing}) result;
      try {
        result = await repository.fetchWorktreePipelineSlices(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
        );
      } on Object {
        if (isCurrent()) {
          read.cancelTimer();
          retry();
        }
        return;
      }
      if (!isCurrent()) return;
      read
        ..cancelTimer()
        ..attempt = null;
      if (!isConnected()) {
        // Reconnecting to this session reads again.
        read.phase = _PipelineRunReadPhase.idle;
        return;
      }
      _settlePipelineRunRead(
        read,
        worktreeLocalId: worktreeLocalId,
        since: generation,
        slices: result.refreshing ? null : result.slices,
        apply: () => _applyPipelineRunRead(
          read,
          result,
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          first: first,
          retry: retry,
        ),
      );
    }());
  }

  /// A full activity read issued after the [since] generation carries the
  /// pipelines too, so [read]'s reply waits for it: once it writes, its rows
  /// win, keeping the chat links of [slices] where they leave theirs out; if
  /// it fails, is dropped, or outlasts [timeout], [apply] runs.
  void _settlePipelineRunRead(
    _PipelineRunRead read, {
    required String worktreeLocalId,
    required int? since,
    required Map<String, dynamic>? slices,
    required void Function() apply,
  }) {
    final latest = _sliceReadGenerations[worktreeLocalId];
    if (latest == since) {
      apply();
      return;
    }
    read
      ..phase = _PipelineRunReadPhase.deferred
      ..deferred = (since: since, slices: slices, apply: apply);
    if (_settledSliceReadGenerations[worktreeLocalId] == latest) {
      _resumePipelineRunRead(read, worktreeLocalId);
      return;
    }
    read.timer = _timer(timeout, () {
      read.timer = null;
      _resumePipelineRunRead(read, worktreeLocalId);
    });
  }

  /// Settles [read]'s held reply; see [_settlePipelineRunRead].
  void _resumePipelineRunRead(_PipelineRunRead read, String worktreeLocalId) {
    final deferred = read.deferred;
    if (deferred == null) return;
    read
      ..cancelTimer()
      ..deferred = null;
    if (!isConnected()) {
      // Reconnecting to this session reads again.
      read.phase = _PipelineRunReadPhase.idle;
    } else if ((_writtenSliceReadGenerations[worktreeLocalId] ?? 0) >
        (deferred.since ?? 0)) {
      read
        ..phase = _PipelineRunReadPhase.done
        ..snapshotLanded = false;
      final held = _worktreeStateSlices[worktreeLocalId];
      if (held == null) return;
      final kept = _slicesKeepingChatTurns(held, deferred.slices);
      if (identical(kept, held)) return;
      _worktreeStateSlices[worktreeLocalId] = kept;
      notify();
    } else {
      deferred.apply();
    }
  }

  void _applyPipelineRunRead(
    _PipelineRunRead read,
    ({Map<String, dynamic> slices, bool refreshing}) result, {
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool first,
    required void Function() retry,
  }) {
    if (result.refreshing) {
      if (!first) {
        retry();
      } else if (read.snapshotLanded) {
        _readPipelineRuns(
          read,
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          first: false,
        );
      } else {
        read
          ..phase = _PipelineRunReadPhase.awaitingSnapshot
          ..timer = _timer(timeout, () {
            read.timer = null;
            if (read.phase == _PipelineRunReadPhase.awaitingSnapshot) {
              retry();
            }
          });
      }
      return;
    }
    read
      ..phase = _PipelineRunReadPhase.done
      ..snapshotLanded = false;
    final held = _worktreeStateSlices[worktreeLocalId];
    _worktreeStateSlices[worktreeLocalId] = {
      ...?held,
      if (result.slices['pipelines'] case final Object pipelines)
        'pipelines': pipelines,
      // Run rows that leave their chat links out keep the held ones.
      if (result.slices['pipelineRuns'] case final Object runs)
        'pipelineRuns': keepHeldPipelineRunChatTurns(
          runs,
          held?['pipelineRuns'],
        ),
    };
    notify();
  }

  void _failPipelineRunRead(
    _PipelineRunRead read, {
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    read
      ..phase = _PipelineRunReadPhase.failed
      ..failures += 1;
    if (read.failures >= _kPipelineRunReadAttempts) return;
    read.timer = _timer(retryWindow, () {
      read
        ..timer = null
        ..phase = _PipelineRunReadPhase.idle;
      ensurePipelineRuns(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
      );
    });
  }

  /// Hydrates tab discovery and search with one session-wide summary batch.
  /// Background warming yields to foreground chat/activity hydration before
  /// submission; an already submitted host request cannot be preempted.
  /// Older hosts keep the normal full-worktree request on navigation.
  void ensureChatSummariesIndex({bool background = false}) {
    if (_disposed || !canSearchChats) return;
    const key = ChatSummariesIndexHydration();
    final existing = _slots[key];
    if (existing != null) {
      if (existing.hydrated ||
          existing.submitting ||
          existing.phase == HydrationPhase.pending) {
        return;
      }
      final lastAttempt = existing.lastAttempt;
      // Build-driven warming must not turn a visible failure into a retry loop.
      if (background && existing.error != null) return;
      if (lastAttempt != null &&
          _clock().difference(lastAttempt) < retryWindow) {
        return;
      }
    }
    final slot = _slotFor(key);
    if (background) {
      _summaryWarmRequested = true;
      if (!_foregroundCompleted) return;
      slot.retryTimer ??= _timer(_kSummaryWarmDelay, () {
        slot.retryTimer = null;
        if (_disposed || !canSearchChats) return;
        if (_isForegroundBusy) {
          ensureChatSummariesIndex(background: true);
          return;
        }
        ensureChatSummariesIndex();
      });
      return;
    }
    _summaryWarmRequested = false;
    slot.retryTimer?.cancel();
    slot.retryTimer = null;
    slot.watchdog?.cancel();
    slot.watchdog = null;
    slot.onTimeout = null;
    final token = Object();
    slot.token = token;
    slot.phase = HydrationPhase.pending;
    slot.error = null;
    slot.submitting = true;
    notify();
    unawaited(() async {
      try {
        await repository.requestWorktreeChatSummariesState();
        if (!_isCurrent(key, slot, token) || slot.hydrated) return;
        void onTimeout() {
          if (!_isCurrent(key, slot, token) || slot.hydrated) return;
          _failChatSummaries(slot);
        }

        slot.onTimeout = onTimeout;
        if (!isBackgrounded()) _armWatchdog(slot, onTimeout);
      } catch (_) {
        if (!_isCurrent(key, slot, token) || slot.hydrated) return;
        _failChatSummaries(slot);
      } finally {
        if (_isCurrent(key, slot, token)) {
          slot.submitting = false;
          if (!slot.hydrated) slot.lastAttempt = _clock();
        }
      }
    }());
  }

  void _failChatSummaries(_HydrationSlot slot) {
    slot.watchdog?.cancel();
    slot.watchdog = null;
    slot.onTimeout = null;
    slot.phase = HydrationPhase.failed;
    slot.error = "Couldn't load chats from your desktop.";
    notify();
  }

  /// A user-requested reload bypasses the cache and retry delay, while an
  /// in-flight request stays single-flight. Cached rows remain visible.
  void retryChatSummariesIndex() {
    if (_disposed || !canSearchChats) return;
    final slot = _slotFor(const ChatSummariesIndexHydration());
    if (slot.submitting || slot.phase == HydrationPhase.pending) return;
    slot.hydrated = false;
    slot.lastAttempt = null;
    ensureChatSummariesIndex();
  }

  /// Forgets every request and loaded slice, as [reset] does, then sends
  /// again each load still waiting on the desktop: a fresh resume skipped
  /// the events its reply may have arrived in. Loads that already landed
  /// run again when a view asks for them.
  void reloadAfterSkippedEvents() {
    final waiting = [
      for (final MapEntry(:key, value: slot) in _slots.entries)
        if (_isLoading(key) || slot.submitting) (key: key, target: slot.target),
    ];
    reset();
    for (final (:key, :target) in waiting) {
      switch (key) {
        case ChatTranscriptHydration():
          if (target != null) ensureChatTranscript(target);
        case ForegroundChatHydration(:final worktree):
          ensureForegroundWorktreeChat(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.worktreeLocalId,
          );
        case WorktreeHydration(:final worktree):
          ensureWorktreeState(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.worktreeLocalId,
          );
        case ChatSummariesIndexHydration():
          ensureChatSummariesIndex();
      }
    }
  }

  /// Forgets every request of the discarded session and cancels its timers.
  /// Replies still in flight are dropped when they land.
  void reset() {
    _openedPersistedTails.clear();
    tailFreshness.reset();
    _foregroundCompleted = false;
    _foregroundReady = false;
    _summaryWarmRequested = false;
    for (final slot in _slots.values) {
      slot.cancelTimers();
    }
    _slots.clear();
    _earlyTabListSnapshots.clear();
    _settledSnapshotMarks.clear();
    _session = Object();
    _activityReads.clear();
    _worktreeStateSlices.clear();
    watcherSlices.reset();
    backgroundProcesses.reset();
    _activityMemo.clear();
    _sliceReadGenerations.clear();
    _settledSliceReadGenerations.clear();
    _writtenSliceReadGenerations.clear();
    _sliceWorkspaces.clear();
    _pendingSlicePatches.clear();
    _projectionEventIds.clear();
    for (final read in _pipelineRunReads.values) {
      read.cancelTimer();
    }
    _pipelineRunReads.clear();
    _changedFiles.reset();
  }

  void dispose() {
    _disposed = true;
    reset();
  }
}
