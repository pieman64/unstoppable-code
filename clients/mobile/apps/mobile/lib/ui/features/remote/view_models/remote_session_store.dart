import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';

import 'chat_transcript_store.dart';
import 'pr_observation_reducer.dart';
import 'remote_identity.dart';
import 'remote_shell_reducer.dart';
import 'snapshot_memo.dart';
import 'tab_list_baseline_tracker.dart';

/// Turn and unread flags that one chat's summary delivered for its worktree.
typedef RemoteChatActivitySignal = ({bool? isStreaming, bool? hasUnread});

/// Summary-delivered chat activity per worktree, by chat id.
typedef RemoteSummarySignals =
    Map<RemoteWorktreeKey, Map<String, RemoteChatActivitySignal>>;

/// The store as an HTTP snapshot read found it when the read started. A live
/// event that lands during the read outranks the read's older data.
typedef RemoteSnapshotReadBaseline = ({
  RemoteSessionSnapshot? snapshot,
  RemoteSummarySignals signals,
  int tabListMark,
});

/// A chat whose projected unread flag a reducer step delivered.
typedef RemoteUnreadProjection = ({RemoteChatKey chat, bool? unread});

/// Sorts worktrees into sidebar order. Injected because the collation is
/// locale-aware platform code.
typedef RemoteWorktreeOrder =
    List<RemoteWorktree> Function(Iterable<RemoteWorktree> worktrees);

/// The desktop's projected model catalog paired with whether it is
/// authoritative. Kept as one value so the two can only be derived together.
typedef _ProjectedCatalog = ({List<ModelOption> catalog, bool authoritative});

/// Why a reducer step asks for an overview read.
enum RemoteOverviewRefreshRequest {
  /// A live shell patch outranked an HTTP read that may still carry shell
  /// changes of its own.
  readRacedLiveShell,

  /// A delta asked for the overview it could not carry. Waits out the delta
  /// refresh interval.
  deltaRequested,

  /// An older server supplied no per-event cursor, so a batch may straddle
  /// the read cursor. Re-read rather than apply an ambiguous shell patch.
  uncursoredShellEvent,
}

/// What one reducer step asks other collaborators to do. The facade routes
/// these right after the step, so they apply in the same order as the
/// events that caused them.
final class RemoteSessionEffects {
  const RemoteSessionEffects({
    this.changed = false,
    this.readsPrunedAgainst,
    this.unreadProjections = const [],
    this.transcriptUpdates = const [],
    this.chatHydrated,
    this.foregroundHydrated,
    this.summariesIndexHydrated = false,
    this.resolvedWorktreeKeys = const {},
    this.resolvesPendingWorktrees = false,
    this.hydratedWorktreeTargets = const {},
    this.prProgress,
    this.worktreeSetupFailure,
    this.overviewRefresh,
  });

  static const none = RemoteSessionEffects();

  /// Whether the session state changed.
  final bool changed;

  /// A full snapshot replaced the session: read receipts for chats it no
  /// longer carries are stale.
  final RemoteSessionSnapshot? readsPrunedAgainst;

  /// Projected unread flags, in delivery order.
  final List<RemoteUnreadProjection> unreadProjections;

  final List<RemoteTranscriptUpdate> transcriptUpdates;

  /// A chat-targeted snapshot delivered this chat's transcript.
  final RemoteChatKey? chatHydrated;

  /// A chat-scope snapshot delivered this worktree's tabs and selected chat.
  final RemoteWorktreeKey? foregroundHydrated;

  /// The session-wide chat-summary index landed.
  final bool summariesIndexHydrated;

  /// Worktree snapshots signalling that the server cache is ready. The chat
  /// tabs stop loading once an overview re-read lands.
  final Set<RemoteWorktreeKey> resolvedWorktreeKeys;

  /// An untargeted worktree snapshot: every pending worktree resolves.
  final bool resolvesPendingWorktrees;

  /// Worktrees whose activity slices were projected.
  final Set<RemoteWorktreeKey> hydratedWorktreeTargets;

  /// Raw `pr_status` progress patches, keyed `'<workspace>:<worktree>'`.
  final Map<String, RemotePrProgressState>? prProgress;

  /// A deferred worktree create failed its background setup.
  final ({RemoteWorktreeKey worktree, String error})? worktreeSetupFailure;

  final RemoteOverviewRefreshRequest? overviewRefresh;
}

/// The paired desktop's session: the latest [snapshot] plus the local
/// overlays that live events add to it, and the derived lists the UI reads.
///
/// A pure reducer: each `apply*` step replaces [snapshot] (never mutating
/// it, since memoized reads key on its identity) and returns the effects it
/// has on hydration, transcripts, PR progress, and refresh scheduling
/// instead of reaching into them.
final class RemoteSessionStore {
  RemoteSessionStore({
    required this.orderWorktrees,
    required this.knownChatKeys,
    required this.isLocallyRead,
    required this.hasLocalReads,
  });

  final RemoteWorktreeOrder orderWorktrees;

  /// Chats this device holds rows for or is loading, so an incoming bare
  /// chat id can resolve to one of them.
  final Iterable<RemoteChatKey> Function() knownChatKeys;

  /// Whether a local read receipt covers the chat's latest output.
  final bool Function(RemoteChatScope scope, String chatId) isLocallyRead;

  /// Whether any local read receipt exists; skips the per-worktree scan.
  final bool Function() hasLocalReads;

  RemoteSessionSnapshot? _snapshot;

  /// The head event of the latest overview, whose `:chunk-N` continuations
  /// append shell entities.
  String? _overviewSnapshotEventId;

  /// The event cursor the current workspace/worktree shell is known to cover,
  /// from the latest adopted overview read. After a long background the event
  /// stream replays the backlog from an older cursor; shell events in pages at
  /// or below this cursor are already in the read, and applying them would
  /// walk the sidebar back through history before it caught up again. Null
  /// until a read reports its cursor.
  int? _shellCoveredThrough;

  /// The batch cursor of the latest event that changed the shell; null when
  /// it changed outside a cursored batch, so its age is unknown.
  int? _shellChangedAt;

  /// The cursor of the event batch being applied; null outside a batch.
  int? _batchCursor;

  /// The server row cursor of the current state event, when supplied.
  int? _shellEventCursor;

  // Only summary signals delivered after the latest worktree projection may
  // supplement it. Cached summaries survive overview refreshes for navigation,
  // but must not resurrect an old spinner/unread dot after a newer host row.
  // A partial chat update can add a signal, never clear the host aggregate:
  // another, unloaded sibling may still be running or unread.
  final RemoteSummarySignals _worktreeSummarySignals = {};

  final Map<RemoteChatKey, int> _composerProjectionSequences = {};
  int _composerProjectionSequence = 0;

  final _projectedCatalogMemo = SnapshotMemo<_ProjectedCatalog>();

  /// Arrival order of each chat's model-catalog projection, newest = highest.
  /// A local stand-in for the catalog generation the wire does not carry.
  ///
  /// Keyed by [_catalogArrivalKey] rather than `RemoteChatKey`, whose `scope`
  /// is non-nullable — a summary's scope is optional on the wire.
  final Map<String, int> _catalogArrival = {};

  /// Starts at 1 so any stamped projection outranks an unstamped one, which
  /// reads as 0.
  ///
  /// Both ingestion paths stamp. An incremental merge stamps each summary it
  /// carries. A full snapshot re-stamps every projected row it returned, in
  /// ascending order of their previous stamps — so the returned set as a whole
  /// outranks earlier arrivals (including rows preserved by
  /// [summariesMissingWholesale], which keep their older stamps and rank
  /// below) while relative recency inside the set survives.
  int _catalogArrivalCounter = 1;

  static String _catalogArrivalKey(RemoteChatSummary summary) =>
      '${summary.scope?.name ?? 'unscoped'}:${summary.chatId}';

  /// The most recent session snapshot; non-null once a fetch has succeeded.
  RemoteSessionSnapshot? get snapshot => _snapshot;

  final TabListBaselineTracker _tabList = TabListBaselineTracker();

  /// Orders summary additions. Capture it when requesting a tab list; pass it
  /// back as the response's baseline.
  int get tabListMark => _tabList.mark;

  /// Opens a portal event batch whose events end at [cursor]
  /// (`nextCursor`). Every event applied until [endEventBatch] belongs to it.
  void beginEventBatch(int cursor) {
    _batchCursor = cursor;
  }

  /// Closes the batch opened by [beginEventBatch].
  void endEventBatch() {
    _batchCursor = null;
    _shellEventCursor = null;
  }

  /// Whether this shell event is included in the adopted overview read. An
  /// uncursored event in a later batch is ambiguous and needs a fresh read.
  bool get _shellEventCovered {
    final covered = _shellCoveredThrough;
    if (covered == null) return false;
    final eventCursor = _shellEventCursor;
    if (eventCursor != null) return eventCursor <= covered;
    return _batchCursor != null;
  }

  /// Whether the adopted read covers this cursored event's chat summaries.
  /// Replaying them would restore tabs closed before the read; uncursored
  /// events keep their summaries.
  bool get _summaryEventCovered =>
      _shellEventCursor != null && _shellEventCovered;

  bool get _needsUncursoredShellRefresh {
    final batchCursor = _batchCursor;
    final covered = _shellCoveredThrough;
    return batchCursor != null &&
        _shellEventCursor == null &&
        covered != null &&
        batchCursor > covered;
  }

  void _recordShellChange() {
    _shellChangedAt = _shellEventCursor ?? _batchCursor;
  }

  /// Bumped for every batch of projected composer state.
  int get composerProjectionSequence => _composerProjectionSequence;

  /// The projection batch that last carried [chat]'s composer state.
  int? composerProjectionSequenceFor(RemoteChatKey chat) =>
      _composerProjectionSequences[chat];

  /// Captures what an HTTP snapshot read must not overwrite if a live event
  /// lands before it returns. Pass it to [applySnapshot].
  RemoteSnapshotReadBaseline captureReadBaseline() => (
    snapshot: _snapshot,
    signals: Map.of(_worktreeSummarySignals),
    tabListMark: _tabList.mark,
  );

  /// Workspaces in saved desktop sidebar order, independent of transport order.
  List<RemoteWorkspace> get workspaces {
    final sorted = List<RemoteWorkspace>.of(_snapshot?.workspaces ?? const []);
    sorted.sort((left, right) {
      // Older desktops may omit order. Put those entries last and use identity
      // to break ties so refreshes and renamed workspaces cannot shuffle rows.
      final byOrder = (left.order ?? double.infinity).compareTo(
        right.order ?? double.infinity,
      );
      return byOrder != 0 ? byOrder : left.localId.compareTo(right.localId);
    });
    return List.unmodifiable(sorted);
  }

  /// All worktrees across every workspace, in saved sidebar order.
  List<RemoteWorktree> get allWorktrees => orderWorktrees(
    (_snapshot?.worktrees ?? const <RemoteWorktree>[]).map(_readWorktree),
  );

  /// All standalone (cowork) chats across every workspace.
  List<RemoteStandaloneChat> get allStandaloneChats => List.unmodifiable(
    (_snapshot?.standaloneChats ?? const <RemoteStandaloneChat>[]).map(
      _readStandalone,
    ),
  );

  /// All cached chat summaries across every worktree.
  List<RemoteChatSummary> get allChatSummaries => List.unmodifiable(
    (_snapshot?.chatSummaries ?? const <RemoteChatSummary>[]).map(_readSummary),
  );

  /// Worktrees belonging to [workspaceLocalId], in saved sidebar order.
  List<RemoteWorktree> worktreesFor(String workspaceLocalId) => orderWorktrees(
    (_snapshot?.worktrees ?? const <RemoteWorktree>[])
        .where((w) => w.workspaceLocalId == workspaceLocalId)
        .map(_readWorktree),
  );

  /// Standalone chats associated with [workspaceLocalId], in snapshot order.
  List<RemoteStandaloneChat> standaloneChatsFor(String workspaceLocalId) =>
      _standaloneEntryRows(
        ((_snapshot?.standaloneChats ?? const <RemoteStandaloneChat>[]).map(
          _readStandalone,
        )).where((c) => c.projectLocalId == workspaceLocalId),
      );

  /// Latest standalone-chat projection for [chatId], if it is still present.
  RemoteStandaloneChat? standaloneChatById(String chatId) {
    for (final chat
        in (_snapshot?.standaloneChats ?? const <RemoteStandaloneChat>[]).map(
          _readStandalone,
        )) {
      if (chat.localId == chatId) return chat;
    }
    return null;
  }

  /// Locates the worktree that owns a hydrated chat-tab summary for
  /// [chatId]. Used to resolve a push payload's `clientChatId` to its
  /// worktree without relying on the payload's `worktreeId` — that field is
  /// the server's UUID (`Worktree.externalId`), not the client's
  /// [RemoteWorktree.localId], so it cannot be matched against this
  /// snapshot's worktrees directly (see `push_deep_link.dart`). Returns null
  /// until the owning worktree's chat tabs have hydrated.
  RemoteWorktree? worktreeForChatId(String chatId) {
    for (final summary
        in _snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      if (summary.chatId != chatId) continue;
      final worktreeLocalId = summary.worktreeLocalId;
      if (worktreeLocalId == null) continue;
      for (final worktree in _snapshot?.worktrees ?? const <RemoteWorktree>[]) {
        if (worktree.localId == worktreeLocalId) return worktree;
      }
    }
    return null;
  }

  /// Standalone chats whose project is not represented by a workspace row.
  List<RemoteStandaloneChat> get unmatchedStandaloneChats {
    final workspaceIds = workspaces
        .map((workspace) => workspace.localId)
        .toSet();
    return _standaloneEntryRows(
      ((_snapshot?.standaloneChats ?? const <RemoteStandaloneChat>[]).map(
        _readStandalone,
      )).where((chat) => !workspaceIds.contains(chat.projectLocalId)),
    );
  }

  List<RemoteStandaloneChat> _standaloneEntryRows(
    Iterable<RemoteStandaloneChat> chats,
  ) {
    final groups = <(String, String, bool), List<RemoteStandaloneChat>>{};
    for (final chat in chats) {
      if (chat.archived == true) continue;
      final entryId = chat.workEntryId;
      final hasEntry = entryId != null && entryId.isNotEmpty;
      final key = (
        chat.projectLocalId,
        hasEntry ? entryId : chat.localId,
        hasEntry,
      );
      (groups[key] ??= []).add(chat);
    }
    return List.unmodifiable(
      groups.values.map(
        (siblings) => siblings.first.withEntryActivity(
          active: siblings.any((chat) => chat.hasActiveChat == true),
          unread: siblings.any((chat) => chat.hasUnread == true),
        ),
      ),
    );
  }

  /// The worktree's chat tabs in display order.
  List<RemoteChatSummary> chatSummariesFor({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    final summaries = (_snapshot?.chatSummaries ?? const <RemoteChatSummary>[])
        .where(
          (s) =>
              s.workspaceLocalId == workspaceLocalId &&
              s.worktreeLocalId == worktreeLocalId,
        )
        .map(_readSummary)
        .toList();
    summaries.sort((a, b) {
      final orderA = a.order;
      final orderB = b.order;
      if (orderA != null && orderB != null) return orderA.compareTo(orderB);
      if (orderA != null) return -1;
      if (orderB != null) return 1;
      final createdA = a.createdAt ?? '';
      final createdB = b.createdAt ?? '';
      final byCreated = createdA.compareTo(createdB);
      return byCreated != 0 ? byCreated : a.chatId.compareTo(b.chatId);
    });
    return List.unmodifiable(summaries);
  }

  /// The snapshot's own summary row for [key]. Unlike the projected reads,
  /// it is never re-derived for local read state, so its identity changes
  /// only when that chat's row is merged or the snapshot is replaced.
  RemoteChatSummary? rawChatSummary(RemoteChatKey key) {
    for (final summary
        in _snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      if (summary.chatId == key.chatId &&
          (summary.scope ?? RemoteChatScope.worktree) == key.scope) {
        return summary;
      }
    }
    return null;
  }

  RemoteChatSummary _readSummary(RemoteChatSummary summary) =>
      isLocallyRead(summary.scope ?? RemoteChatScope.worktree, summary.chatId)
      ? summary.withUnread(false)
      : summary;

  RemoteStandaloneChat _readStandalone(RemoteStandaloneChat chat) =>
      isLocallyRead(RemoteChatScope.standalone, chat.localId)
      ? chat.withEntryActivity(
          active: chat.hasActiveChat == true,
          unread: false,
        )
      : chat;

  RemoteWorktree _readWorktree(RemoteWorktree worktree) {
    final signals = _worktreeSummarySignals[remoteWorktreeKeyOf(worktree)];
    if (signals != null) {
      worktree = worktree.withChatActivity(
        isStreaming:
            worktree.isStreaming == true ||
            signals.values.any((s) => s.isStreaming == true),
        hasUnread:
            worktree.hasUnread == true ||
            signals.values.any((s) => s.hasUnread == true),
      );
    }
    if (!hasLocalReads() || worktree.hasUnread != true) return worktree;
    final summaries =
        _snapshot?.chatSummaries
            .where(
              (s) =>
                  s.worktreeLocalId == worktree.localId &&
                  s.workspaceLocalId == worktree.workspaceLocalId &&
                  (s.scope == null || s.scope == RemoteChatScope.worktree),
            )
            .toList() ??
        const <RemoteChatSummary>[];
    // Only override a host aggregate when we have unread chat evidence, and
    // every unread sibling is covered by a receipt.
    final unread = summaries.where((s) => s.hasUnread == true).toList();
    return summaries.any(
              (s) => isLocallyRead(RemoteChatScope.worktree, s.chatId),
            ) &&
            unread.every(
              (s) => isLocallyRead(RemoteChatScope.worktree, s.chatId),
            )
        ? worktree.withUnread(false)
        : worktree;
  }

  /// The desktop's projected model catalog and whether it is authoritative,
  /// derived together in a SINGLE pass over the cached summaries.
  ///
  /// Deriving them separately was a real defect: [mergeChatSummaries] upserts
  /// summaries individually, so an incremental policy refresh can leave a
  /// stale, unfiltered summary alongside the newly filtered one. A "first
  /// non-empty catalog" read would then return the stale list while a
  /// "does any summary project?" read returned true — a pair that never
  /// existed on the wire, and one that keeps offering a model the policy just
  /// removed.
  ///
  /// The winner is the summary whose projection arrived MOST RECENTLY. That
  /// matters because content alone cannot decide it: an empty projection means
  /// both "the desktop is still starting up, before its model registry
  /// initializes" and "the policy blocked everything", and those want opposite
  /// winners. Preferring non-empty resurrects models an all-blocked policy just
  /// removed; preferring empty lets one startup-window summary permanently
  /// clear a legitimate pick. Recency answers both: the startup-window empty is
  /// superseded by the healthy catalogs that follow, and an all-blocked refresh
  /// supersedes the stale non-empty ones.
  ///
  /// The wire carries no catalog generation, so arrival order is recorded
  /// locally in [_catalogArrival] as a stand-in. A real generation/version
  /// field on the summary would be strictly better and is the follow-up.
  ///
  /// Memoized on snapshot identity: both public getters and the composer
  /// controls delegate here, so an uncached pass over every summary would run
  /// several times per frame.
  _ProjectedCatalog get _projectedCatalogState =>
      _projectedCatalogMemo.read(_snapshot, _deriveProjectedCatalog);

  _ProjectedCatalog _deriveProjectedCatalog(RemoteSessionSnapshot? snapshot) {
    List<ModelOption>? newest;
    var newestArrival = -1;
    var authoritative = false;
    for (final summary
        in snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      // A non-empty catalog implies the desktop projected the array —
      // `fromJson` derives the flag as `json['availableModels'] is List`, so
      // the two can never disagree on the wire. Deriving it here rather than
      // trusting the flag alone keeps this robust against a hand-built
      // summary that sets one without the other, which would otherwise empty
      // the catalog silently instead of failing loudly.
      if (!summary.hasProjectedModelCatalog) continue;
      authoritative = true;
      // Defensive: both ingestion paths stamp, so every projected summary
      // reachable here carries one. Treat any unstamped row as oldest.
      final arrival = _catalogArrival[_catalogArrivalKey(summary)] ?? 0;
      if (newest == null || arrival > newestArrival) {
        newest = summary.availableModels;
        newestArrival = arrival;
      }
    }
    return (
      catalog: newest ?? const <ModelOption>[],
      authoritative: authoritative,
    );
  }

  /// The desktop's projected model catalog, read from the hydrated chat
  /// summaries. Empty until at least one summary has hydrated; callers then
  /// leave selection to the desktop default.
  List<ModelOption> get projectedModelCatalog => _projectedCatalogState.catalog;

  /// Whether [projectedModelCatalog] is authoritative — i.e. at least one
  /// hydrated summary actually carried an `availableModels` array.
  ///
  /// An EMPTY catalog is ambiguous without this: the desktop omits the field
  /// entirely when no portal client is active, and a snapshot may not have
  /// hydrated yet, so "no models" and "we do not know yet" would otherwise be
  /// indistinguishable. Callers that drop a selection missing from the catalog
  /// must consult this before acting on emptiness.
  bool get projectedModelCatalogIsAuthoritative =>
      _projectedCatalogState.authoritative;

  /// Provider availability from the same projection as
  /// [projectedModelCatalog]; null until a summary carrying it hydrates.
  ProviderAvailability? get projectedProviderAvailability {
    for (final summary
        in _snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      final availability = summary.providerAvailability;
      if (availability != null) return availability;
    }
    return null;
  }

  /// Applies a snapshot read over HTTP. [baseline] is what
  /// [captureReadBaseline] returned when the read started; without one the
  /// read replaces the session outright.
  RemoteSessionEffects applySnapshot(
    RemoteSessionSnapshot snapshot, {
    RemoteSnapshotReadBaseline? baseline,
  }) {
    final previous = _snapshot;
    final snapshotAtRequest = baseline?.snapshot;
    final signalsAtRequest = baseline?.signals;
    final readCursor = snapshot.eventCursor;
    final changedAt = _shellChangedAt;
    // A change from a replayed page the read already covers is older than the
    // read, not a race with it.
    final changeCoveredByRead =
        readCursor != null && changedAt != null && changedAt <= readCursor;
    final shellChangedDuringRead =
        snapshotAtRequest != null &&
        previous != null &&
        !changeCoveredByRead &&
        (!identical(previous.worktrees, snapshotAtRequest.worktrees) ||
            !identical(previous.workspaces, snapshotAtRequest.workspaces) ||
            !identical(
              previous.standaloneChats,
              snapshotAtRequest.standaloneChats,
            ));
    // An HTTP read may have captured the server cache before a live event
    // arrived. Preserve that newer shell (including removals/chunks), and any
    // summary signals delivered during the read. A later read can reconcile.
    if (shellChangedDuringRead) {
      snapshot = snapshot.copyWith(
        workspaces: previous.workspaces,
        worktrees: previous.worktrees,
        standaloneChats: previous.standaloneChats,
      );
    } else {
      _overviewSnapshotEventId = null;
      if (readCursor != null && readCursor > (_shellCoveredThrough ?? -1)) {
        _shellCoveredThrough = readCursor;
      }
      _worktreeSummarySignals.removeWhere(
        (key, signals) =>
            signalsAtRequest == null ||
            identical(signalsAtRequest[key], signals),
      );
    }
    var next = snapshot;
    if (previous != null) {
      // Overview-scoped snapshot ingestion wipes every cached chat_summary
      // row server-side (the replacement set includes the type but overview
      // snapshots never carry the rows), so a state re-fetch can transiently
      // return a hydrated worktree with ZERO summaries. Preserve groups that
      // vanish wholesale — a desktop never legitimately reports a hydrated
      // worktree with no tabs (closing the last tab mints a fresh empty one),
      // so total loss means cache churn, not truth. Partial/updated sets stay
      // authoritative and replace as usual.
      final wholesale = summariesMissingWholesale(
        previous.chatSummaries,
        snapshot.chatSummaries,
      );
      // The read may predate a tab a live event added while it was in
      // flight; keep that tab rather than treat its absence as a close.
      final returnedKeys = {
        for (final s in snapshot.chatSummaries) (s.chatId, s.scope),
      };
      final readMark = baseline?.tabListMark;
      final preserved = [
        ...wholesale,
        if (readMark != null)
          for (final summary in previous.chatSummaries)
            if (!returnedKeys.contains((summary.chatId, summary.scope)) &&
                !wholesale.contains(summary) &&
                _tabList.addedAfter(summary, readMark))
              summary,
      ];
      // Re-fetches also inherit per-chat pendingQuestions when the incoming
      // summary omits the field (omission = preserve, `[]` = clear).
      final previousByKey = {
        for (final summary in previous.chatSummaries)
          (summary.chatId, summary.scope): summary,
      };
      final previousRows = {
        for (final row in previous.worktrees) remoteWorktreeKeyOf(row): row,
      };
      next = snapshot.copyWith(
        worktrees: [
          for (final row in snapshot.worktrees)
            row.inheritPrChecks(previousRows[remoteWorktreeKeyOf(row)]),
        ],
        chatSummaries: [
          for (final summary in snapshot.chatSummaries)
            // A tab removed after the read started stays removed.
            if (readMark == null ||
                !_tabList.removedAfter(
                  summary,
                  readMark,
                  readCursor: readCursor,
                ))
              summary.inheritPendingQuestions(
                previousByKey[(summary.chatId, summary.scope)],
              ),
          ...preserved,
        ],
      );
    }
    if (previous != null) {
      // Run rows that leave their chat links out keep the held ones
      // (omission = preserve, `[]` = clear).
      final runs = next.raw['pipelineRuns'];
      final kept = keepHeldPipelineRunChatTurns(
        runs,
        previous.raw['pipelineRuns'],
      );
      if (!identical(kept, runs)) {
        next = next.copyWith(raw: {...next.raw, 'pipelineRuns': kept});
      }
    }
    final unreadProjections = recordComposerProjections(
      summaries: snapshot.chatSummaries,
      standaloneChats: snapshot.standaloneChats,
    );
    // Re-stamp every summary the fetch returned so the whole returned set
    // outranks earlier arrivals. Without this, a summary preserved by
    // `summariesMissingWholesale` keeps the high stamp it earned from an
    // incremental merge while the fresh rows are unstamped, letting a stale
    // catalog outrank a newly policy-filtered (or authoritative-empty) one.
    //
    // Relative order WITHIN the returned set is preserved rather than
    // flattened to one shared value. A single shared stamp would make
    // `_projectedCatalogState`'s strict `>` fall back to list order, so a
    // snapshot carrying both an older unfiltered row and a newer filtered one
    // could re-select the stale catalog. Re-stamping in ascending order of the
    // previous stamp keeps the newer row newer. (One fetch is normally a
    // single coherent projection, so this only matters when the server's rows
    // disagree — but ordering by chance is not a property worth relying on.)
    final returned =
        [
          for (final summary in snapshot.chatSummaries)
            if (summary.modelCatalogProjected ||
                summary.availableModels.isNotEmpty)
              summary,
        ]..sort((a, b) {
          final aArrival = _catalogArrival[_catalogArrivalKey(a)] ?? 0;
          final bArrival = _catalogArrival[_catalogArrivalKey(b)] ?? 0;
          return aArrival.compareTo(bArrival);
        });
    for (final summary in returned) {
      _catalogArrival[_catalogArrivalKey(summary)] = _catalogArrivalCounter++;
    }
    _tabList.recordAdditions(
      previous?.chatSummaries ?? const [],
      next.chatSummaries,
    );
    _snapshot = next;
    return RemoteSessionEffects(
      changed: true,
      readsPrunedAgainst: next,
      unreadProjections: unreadProjections,
      transcriptUpdates: [
        if (snapshot.chatMessages.isNotEmpty)
          IncomingChatRowsUpdate(
            rows: snapshot.chatMessages,
            keySnapshot: next,
            authoritativeSnapshot: true,
          ),
      ],
      // A live patch outranked this read, but the read may also contain shell
      // changes that the patch did not carry. Reconcile once more.
      overviewRefresh: shellChangedDuringRead
          ? RemoteOverviewRefreshRequest.readRacedLiveShell
          : null,
    );
  }

  /// Drops the session snapshot after a pairing that never produced one.
  void clearSnapshot() {
    _snapshot = null;
    _tabList.clear();
    _overviewSnapshotEventId = null;
    _forgetShellCursors();
  }

  void _forgetShellCursors() {
    _shellCoveredThrough = null;
    _shellChangedAt = null;
    _shellEventCursor = null;
  }

  /// Applies a live `portal.chat.message` event. The row resolves to its
  /// chat when the transcript store merges it.
  RemoteSessionEffects applyChatMessage(RemoteChatMessageEvent event) =>
      RemoteSessionEffects(
        transcriptUpdates: [
          LiveChatMessageUpdate(
            chatId: event.chatId,
            scope: event.scope,
            message: event.message,
            keySnapshot: _snapshot,
          ),
        ],
      );

  /// Applies a `portal.state.snapshot` event. [tabListBaseline] is the
  /// [tabListMark] captured when this client requested the snapshot; tabs
  /// added after it survive a selected-chat replacement that omits them.
  RemoteSessionEffects applySnapshotEvent(
    RemoteStateSnapshotEvent event, {
    int? tabListBaseline,
  }) {
    _shellEventCursor = event.cursor;
    var changed = false;
    var summariesIndexHydrated = false;
    if (event.scope == 'worktree_chat_summaries') {
      // A new full index replaces summary-only signals, including chats that
      // were closed since the previous index. Continuation deltas append.
      changed = _worktreeSummarySignals.isNotEmpty;
      _worktreeSummarySignals.clear();
      summariesIndexHydrated = true;
    }
    final previous = _snapshot;
    if (event.scope == 'overview' &&
        event.workspaces != null &&
        event.worktrees != null) {
      _overviewSnapshotEventId = event.eventId;
      // A head the adopted read already includes stays the anchor for
      // continuation chunks past the read's cursor, but must not replace the
      // newer shell.
      if (!_shellEventCovered) {
        _recordShellChange();
        _worktreeSummarySignals.clear();
        // Overview heads replace workspace/worktree collections, including
        // removals. Apply them without fetching (which can trigger another
        // overview push), and leave targeted chat/activity hydration
        // untouched. Oversized snapshots append entities through correlated
        // delta chunks.
        final previousRows = {
          for (final row in previous?.worktrees ?? const <RemoteWorktree>[])
            remoteWorktreeKeyOf(row): row,
        };
        _snapshot =
            previous?.copyWith(
              workspaces: event.workspaces,
              worktrees: [
                for (final row in event.worktrees!)
                  row.inheritPrChecks(previousRows[remoteWorktreeKeyOf(row)]),
              ],
              standaloneChats: event.standaloneChats,
            ) ??
            RemoteSessionSnapshot(
              workspaces: event.workspaces!,
              worktrees: event.worktrees!,
              standaloneChats: event.standaloneChats ?? const [],
            );
        changed = true;
      }
    } else {
      changed = applyWorktreeRows(event.worktrees) || changed;
    }
    changed = applyPrStatuses(event.prStatuses) || changed;
    final targetChatId = event.targetChatId;
    final targetKey = targetChatId == null
        ? null
        : chatKeyForIncoming(targetChatId, event.targetChatScope);
    final RemoteTranscriptUpdate? transcriptUpdate;
    if (targetKey != null) {
      transcriptUpdate = AuthoritativeTranscriptUpdate(
        chat: targetKey,
        rows: [
          for (final message in event.chatMessages)
            if (chatKeyForIncoming(
                  message.chatId,
                  message.scope ?? event.targetChatScope,
                ) ==
                targetKey)
              message,
        ],
        truncated: event.chatMessagesTruncated,
      );
      changed = true;
    } else {
      // Generic snapshots can contain only cached incremental rows. Merge
      // those rows without declaring the transcript fully hydrated, so a
      // later chat-scoped request still fetches the authoritative history.
      transcriptUpdate = event.chatMessages.isEmpty
          ? null
          : IncomingChatRowsUpdate(
              rows: event.chatMessages,
              keySnapshot: _snapshot,
              fallbackScope: event.targetChatScope,
              preserveCacheProvenance: true,
            );
    }
    // Chat tabs render straight from the event — the follow-up state re-fetch
    // then reconciles, instead of gating the tab list (and the transcript
    // request that depends on knowing the active chat id) on it.
    // A replayed snapshot the read covers cannot restore a closed tab.
    final mergeSummaries = !_summaryEventCovered;
    var unreadProjections = const <RemoteUnreadProjection>[];
    if (mergeSummaries &&
        event.selectedChatOnly &&
        event.targetWorkspaceLocalId != null &&
        event.targetWorktreeLocalId != null) {
      unreadProjections = mergeChatSummaries(
        event.chatSummaries,
        replaceWorktree: remoteWorktreeKey(
          event.targetWorkspaceLocalId!,
          event.targetWorktreeLocalId!,
        ),
        replaceBaseline: tabListBaseline,
      );
      changed = true;
    } else if (mergeSummaries && event.chatSummaries.isNotEmpty) {
      unreadProjections = mergeChatSummaries(event.chatSummaries);
      changed = true;
    }

    RemoteWorktreeKey? foregroundHydrated;
    final resolvedWorktreeKeys = <RemoteWorktreeKey>{};
    final hydratedWorktreeTargets = <RemoteWorktreeKey>{};
    final workspaceLocalId = event.targetWorkspaceLocalId;
    final worktreeLocalId = event.targetWorktreeLocalId;
    if (workspaceLocalId != null && worktreeLocalId != null) {
      final key = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
      if (event.scope == 'chat') {
        foregroundHydrated = key;
        changed = true;
      } else {
        resolvedWorktreeKeys.add(key);
      }
      if (event.scope == 'worktree') hydratedWorktreeTargets.add(key);
    }
    return RemoteSessionEffects(
      changed: changed,
      unreadProjections: unreadProjections,
      transcriptUpdates: [?transcriptUpdate],
      chatHydrated: targetKey,
      foregroundHydrated: foregroundHydrated,
      summariesIndexHydrated: summariesIndexHydrated,
      resolvedWorktreeKeys: resolvedWorktreeKeys,
      // A worktree snapshot without a target echo resolves everything
      // pending rather than spinning forever. Unrelated scopes (overview
      // etc.) must NOT resolve worktree spinners — their snapshots routinely
      // land while a worktree hydration is still in flight.
      resolvesPendingWorktrees:
          event.scope == 'worktree' &&
          (workspaceLocalId == null || worktreeLocalId == null),
      hydratedWorktreeTargets: hydratedWorktreeTargets,
      prProgress: event.prProgress,
      overviewRefresh:
          _needsUncursoredShellRefresh &&
              (event.workspaces != null ||
                  event.worktrees != null ||
                  event.prStatuses.isNotEmpty)
          ? RemoteOverviewRefreshRequest.uncursoredShellEvent
          : null,
    );
  }

  /// Applies a `portal.state.delta` event. Removals apply first, then
  /// upserts, as the server applies them.
  RemoteSessionEffects applyDelta(RemoteStateDeltaEvent event) {
    _shellEventCursor = event.cursor;
    // Without a per-event cursor these rows wait for the overview read.
    final reduceShell = !event.requiresOverviewRefresh;
    final removed = reduceShell ? _removeShellRows(event.shell.removals) : null;
    var changed = removed?.changed ?? false;
    changed = applyOverviewContinuation(event) || changed;
    if (event.scope != 'overview') {
      changed = applyWorktreeRows(event.worktrees) || changed;
      if (event.workspaces case final rows? when reduceShell) {
        changed = _upsertShell((s) => upsertWorkspaces(s, rows)) || changed;
      }
    }
    var unreadProjections = const <RemoteUnreadProjection>[];
    // A replayed tab upsert the read covers is skipped like its removal.
    if (event.chatSummaries.isNotEmpty && !_summaryEventCovered) {
      unreadProjections = mergeChatSummaries(event.chatSummaries);
      changed = true;
    }
    final chats = event.shell.standaloneChats;
    if (reduceShell && _upsertShell((s) => upsertStandaloneChats(s, chats))) {
      changed = true;
      unreadProjections = [
        ...unreadProjections,
        ...recordComposerProjections(standaloneChats: chats),
      ];
    }
    final failure = event.worktreeSetupFailure;
    if (failure != null) changed = true;
    changed = applyPrStatuses(event.prStatuses) || changed;
    return RemoteSessionEffects(
      changed: changed,
      readsPrunedAgainst: (removed?.changed ?? false) ? _snapshot : null,
      unreadProjections: unreadProjections,
      prProgress: prProgressAfterRemovals(
        event.prProgress,
        removed?.prProgressRemoved ?? const {},
      ),
      worktreeSetupFailure: failure == null
          ? null
          : (
              worktree: remoteWorktreeKey(
                failure.workspaceLocalId,
                failure.worktreeLocalId,
              ),
              error: failure.error,
            ),
      overviewRefresh: event.requiresOverviewRefresh
          ? RemoteOverviewRefreshRequest.deltaRequested
          : _needsUncursoredShellRefresh &&
                (event.workspaces != null ||
                    event.worktrees != null ||
                    event.prStatuses.isNotEmpty)
          ? RemoteOverviewRefreshRequest.uncursoredShellEvent
          : null,
    );
  }

  /// Removes the shell rows [removals] match, unless the adopted read
  /// already covers this event. Null when nothing was removed.
  ({bool changed, Set<RemoteWorktreeKey> prProgressRemoved})? _removeShellRows(
    List<RemoteShellRemoval> removals,
  ) {
    final previous = _snapshot;
    if (previous == null || removals.isEmpty) return null;
    final result = removeShellRows(previous, removals);
    // Reads carry no PR progress, so a covered removal still clears it in
    // stream order, like the progress patches the replay applies.
    if (_shellEventCovered) {
      return result.prProgressRemoved.isEmpty
          ? null
          : (changed: false, prProgressRemoved: result.prProgressRemoved);
    }
    for (final summary in result.removedSummaries) {
      _tabList.recordRemoval(summary, cursor: _shellEventCursor);
      _forgetSummarySignal(summary);
    }
    final next = result.snapshot;
    if (!identical(next.workspaces, previous.workspaces) ||
        !identical(next.worktrees, previous.worktrees) ||
        !identical(next.standaloneChats, previous.standaloneChats)) {
      _recordShellChange();
    }
    _snapshot = next;
    final changed = !identical(next, previous);
    if (!changed && result.prProgressRemoved.isEmpty) return null;
    return (changed: changed, prProgressRemoved: result.prProgressRemoved);
  }

  /// Applies a shell upsert unless the adopted read already covers this
  /// event. Returns whether the snapshot changed.
  bool _upsertShell(
    RemoteSessionSnapshot Function(RemoteSessionSnapshot) upsert,
  ) {
    final previous = _snapshot;
    if (previous == null || _shellEventCovered) return false;
    final next = upsert(previous);
    if (identical(next, previous)) return false;
    _recordShellChange();
    _snapshot = next;
    return true;
  }

  /// Worktree envelopes carry complete host rows, including omitted false
  /// runtime flags. Apply them immediately rather than waiting for a /state
  /// read, which can be delayed behind other desktop work.
  bool applyWorktreeRows(
    List<RemoteWorktree>? rows, {
    bool reconcileChatActivity = true,
  }) {
    final previous = _snapshot;
    if (previous == null || rows == null || rows.isEmpty) return false;
    if (_shellEventCovered) return false;
    _recordShellChange();
    if (reconcileChatActivity) _clearWorktreeSummarySignals(rows);
    final previousRows = {
      for (final row in previous.worktrees) remoteWorktreeKeyOf(row): row,
    };
    _snapshot = previous.copyWith(
      worktrees: {
        ...previousRows,
        for (final row in rows)
          remoteWorktreeKeyOf(row): row.inheritRuntimePr(
            previousRows[remoteWorktreeKeyOf(row)],
          ),
      }.values.toList(),
    );
    return true;
  }

  /// Folds event-carried PR statuses (keyed `'<workspace>:<worktree>'`) into
  /// their worktree rows, keeping the rows' merge queue state.
  bool applyPrStatuses(
    Map<String, List<RemoteWorktreePr>> statuses, {
    RemotePrObservationSource source = RemotePrObservationSource.host,
  }) {
    if (statuses.isEmpty) return false;
    final byWorktree = {
      for (final entry in statuses.entries)
        ?remoteWorktreeKeyFromEvent(entry.key): entry.value,
    };
    if (!(_snapshot?.worktrees.any(
          (row) => byWorktree.containsKey(remoteWorktreeKeyOf(row)),
        ) ??
        false)) {
      return false;
    }
    return _upsertShell((previous) {
      var changed = false;
      final worktrees = previous.worktrees
          .map((row) {
            final prs = byWorktree[remoteWorktreeKeyOf(row)];
            if (prs == null) return row;
            final next = reducePrObservation(row, prs, source: source);
            if (!identical(next, row)) changed = true;
            return next;
          })
          .toList(growable: false);
      return changed ? previous.copyWith(worktrees: worktrees) : previous;
    });
  }

  /// Upserts shell entities from the latest overview's outbox continuation
  /// (event ids `'<headId>:chunk-N'`).
  bool applyOverviewContinuation(RemoteStateDeltaEvent event) {
    final headId = _overviewSnapshotEventId;
    final id = event.eventId;
    final previous = _snapshot;
    if (headId == null ||
        id == null ||
        previous == null ||
        event.scope != 'overview' ||
        !id.startsWith('$headId:chunk-') ||
        !RegExp(
          r'^[1-9][0-9]*$',
        ).hasMatch(id.substring('$headId:chunk-'.length)) ||
        event.workspaces == null ||
        event.worktrees == null ||
        _shellEventCovered) {
      return false;
    }
    _recordShellChange();
    _clearWorktreeSummarySignals(event.worktrees!);
    final previousRows = {
      for (final row in previous.worktrees) remoteWorktreeKeyOf(row): row,
    };
    _snapshot = previous.copyWith(
      workspaces: {
        for (final row in previous.workspaces) row.localId: row,
        for (final row in event.workspaces!) row.localId: row,
      }.values.toList(),
      worktrees: {
        ...previousRows,
        for (final row in event.worktrees!)
          remoteWorktreeKeyOf(row): row.inheritPrChecks(
            previousRows[remoteWorktreeKeyOf(row)],
          ),
      }.values.toList(),
    );
    return true;
  }

  /// Previously-known summaries whose whole group (worktree, or the
  /// standalone bucket) is absent from [incoming].
  static List<RemoteChatSummary> summariesMissingWholesale(
    List<RemoteChatSummary> previous,
    List<RemoteChatSummary> incoming,
  ) {
    if (previous.isEmpty) return const [];
    String groupOf(RemoteChatSummary s) =>
        s.worktreeLocalId ?? 'standalone-chats';
    final incomingGroups = incoming.map(groupOf).toSet();
    return previous
        .where((s) => !incomingGroups.contains(groupOf(s)))
        .toList(growable: false);
  }

  /// Upserts event-carried chat summaries into the current snapshot (by
  /// chat id + scope) so tabs appear without waiting for a state re-fetch.
  /// [replaceWorktree] also drops that worktree's summaries the event omits,
  /// except those added after [replaceBaseline] when one is given.
  List<RemoteUnreadProjection> mergeChatSummaries(
    List<RemoteChatSummary> summaries, {
    RemoteWorktreeKey? replaceWorktree,
    int? replaceBaseline,
  }) {
    final snapshot = _snapshot;
    if (snapshot == null) return const [];
    final unreadProjections = recordComposerProjections(summaries: summaries);
    if (replaceWorktree != null) {
      _worktreeSummarySignals.remove(replaceWorktree);
    }
    _recordWorktreeSummarySignals(summaries);
    final incomingIds = summaries.map((summary) => summary.chatId).toSet();
    final merged = [
      for (final summary in snapshot.chatSummaries)
        if (replaceWorktree == null ||
            summary.workspaceLocalId != replaceWorktree.workspaceLocalId ||
            summary.worktreeLocalId != replaceWorktree.worktreeLocalId ||
            incomingIds.contains(summary.chatId) ||
            (replaceBaseline != null &&
                _tabList.addedAfter(summary, replaceBaseline)))
          summary,
    ];
    for (final summary in summaries) {
      // Stamp arrival order for every summary that carried a catalog. The
      // wire has no catalog generation, and freshness CANNOT be inferred from
      // contents — an empty projection is both "desktop still starting up"
      // and "policy blocked everything", and those want opposite winners.
      // Recording when each projection arrived lets the newest one win, which
      // is correct for both. See [_projectedCatalogState].
      if (summary.modelCatalogProjected || summary.availableModels.isNotEmpty) {
        _catalogArrival[_catalogArrivalKey(summary)] = _catalogArrivalCounter++;
      }
      final index = merged.indexWhere(
        (s) => s.chatId == summary.chatId && s.scope == summary.scope,
      );
      if (index == -1) {
        merged.add(summary);
        _tabList.recordAddition(summary);
      } else {
        merged[index] = summary.inheritPendingQuestions(merged[index]);
      }
    }
    _snapshot = snapshot.copyWith(chatSummaries: merged);
    return unreadProjections;
  }

  /// Stamps the chats whose composer state these rows project, and returns
  /// their projected unread flags in order.
  List<RemoteUnreadProjection> recordComposerProjections({
    List<RemoteChatSummary> summaries = const [],
    List<RemoteStandaloneChat> standaloneChats = const [],
  }) {
    if (summaries.isEmpty && standaloneChats.isEmpty) return const [];
    final sequence = ++_composerProjectionSequence;
    final projections = <RemoteUnreadProjection>[];
    for (final summary in summaries) {
      final scope =
          summary.scope ??
          (summary.worktreeLocalId == null
              ? RemoteChatScope.standalone
              : RemoteChatScope.worktree);
      final chat = (scope: scope, chatId: summary.chatId);
      projections.add((chat: chat, unread: summary.hasUnread));
      _composerProjectionSequences[chat] = sequence;
    }
    for (final standalone in standaloneChats) {
      final chat = (
        scope: RemoteChatScope.standalone,
        chatId: standalone.localId,
      );
      projections.add((chat: chat, unread: standalone.hasUnread));
      _composerProjectionSequences[chat] = sequence;
    }
    return projections;
  }

  void _recordWorktreeSummarySignals(List<RemoteChatSummary> summaries) {
    for (final summary in summaries) {
      final workspace = summary.workspaceLocalId;
      final worktree = summary.worktreeLocalId;
      if (workspace == null ||
          worktree == null ||
          (summary.scope != null &&
              summary.scope != RemoteChatScope.worktree)) {
        continue;
      }
      final key = remoteWorktreeKey(workspace, worktree);
      final previous = _worktreeSummarySignals[key] ?? const {};
      final old = previous[summary.chatId];
      _worktreeSummarySignals[key] = {
        ...previous,
        summary.chatId: (
          isStreaming: summary.turnActive ?? old?.isStreaming,
          hasUnread: summary.hasUnread ?? old?.hasUnread,
        ),
      };
    }
  }

  /// Drops the activity a removed tab delivered for its worktree.
  void _forgetSummarySignal(RemoteChatSummary summary) {
    final workspace = summary.workspaceLocalId;
    final worktree = summary.worktreeLocalId;
    if (workspace == null || worktree == null) return;
    final key = remoteWorktreeKey(workspace, worktree);
    final signals = _worktreeSummarySignals[key];
    if (signals == null || !signals.containsKey(summary.chatId)) return;
    _worktreeSummarySignals[key] = {...signals}..remove(summary.chatId);
  }

  void _clearWorktreeSummarySignals(Iterable<RemoteWorktree> worktrees) {
    for (final worktree in worktrees) {
      _worktreeSummarySignals.remove(remoteWorktreeKeyOf(worktree));
    }
  }

  /// Resolves an incoming bare id only when its namespace is explicit or can
  /// be inferred uniquely. Ambiguous ids are intentionally ignored instead of
  /// contaminating both worktree and standalone transcripts.
  RemoteChatKey? chatKeyForIncoming(
    String chatId,
    RemoteChatScope? explicitScope,
  ) => chatKeyIn(_snapshot, chatId, explicitScope);

  /// [chatKeyForIncoming] against [snapshot] rather than the current one.
  RemoteChatKey? chatKeyIn(
    RemoteSessionSnapshot? snapshot,
    String chatId,
    RemoteChatScope? explicitScope,
  ) {
    if (chatId.isEmpty) return null;
    if (explicitScope != null) return (scope: explicitScope, chatId: chatId);

    final candidates = <RemoteChatKey>{};
    for (final summary
        in snapshot?.chatSummaries ?? const <RemoteChatSummary>[]) {
      if (summary.chatId == chatId && summary.scope != null) {
        candidates.add((scope: summary.scope!, chatId: chatId));
      }
    }
    for (final chat
        in snapshot?.standaloneChats ?? const <RemoteStandaloneChat>[]) {
      if (chat.localId == chatId) {
        candidates.add((scope: RemoteChatScope.standalone, chatId: chatId));
      }
    }
    for (final key in knownChatKeys()) {
      if (key.chatId == chatId) candidates.add(key);
    }
    return candidates.length == 1 ? candidates.single : null;
  }

  /// Discards the session. Arrival stamps and composer projections describe
  /// one desktop session's projections; carrying them across a reconnect
  /// would let a pre-disconnect catalog outrank a fresh one. (The catalog
  /// memo self-invalidates — it is keyed on [snapshot] identity.)
  void reset() {
    _snapshot = null;
    _tabList.clear();
    _overviewSnapshotEventId = null;
    _forgetShellCursors();
    _worktreeSummarySignals.clear();
    _catalogArrival.clear();
    _composerProjectionSequences.clear();
  }
}
