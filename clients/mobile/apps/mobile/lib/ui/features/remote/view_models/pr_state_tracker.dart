import 'dart:async';

import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;

import 'remote_control_state.dart';
import 'remote_session_store.dart';

/// Freshness threshold on open, and the cadence for legacy or busy hosts.
const Duration kRemotePrRefreshInterval = Duration(minutes: 1);

typedef _PrLocalState = ({
  String branch,
  int? insertions,
  int? deletions,
  bool working,
});

typedef _PrRepoProjection = ({
  List<RemotePrRepo> actions,
  List<RemoteWorktreePr> statuses,
  List<RemotePrRepo> repos,
});

/// Session-local PR projections and ordering guards for overlapping refreshes.
final class PrStateTracker {
  PrStateTracker({
    required this.repository,
    required this.store,
    required this.notify,
    required this.isConnected,
    required this.sessionGeneration,
    required this.submit,
    required this.awaitCommandResult,
    RemoteTimerFactory? timer,
    DateTime Function()? clock,
  }) : _timer = timer ?? Timer.new,
       _clock = clock ?? DateTime.now;
  final RemoteControlRepository repository;
  final RemoteSessionStore store;
  final DateTime Function() _clock;
  final void Function() notify;
  final bool Function() isConnected;
  final int Function() sessionGeneration;
  final Future<String> Function(Future<String> Function()) submit;
  final Future<Map<String, dynamic>> Function(RemotePortalCommandResult)
  awaitCommandResult;
  final RemoteTimerFactory _timer;
  final Set<PrStatePoll> _polls = {};

  /// Live PR creation/merge progress per worktree, insertion-ordered so
  /// overflow trims the oldest. Pushed by `pr`-scope deltas and by snapshot
  /// hydration (for a client connecting mid-operation); runtime-only, never
  /// persisted.
  final Map<RemoteWorktreeKey, RemotePrProgressState> _prProgress = {};

  /// Latest live-progress update observed for each worktree. Refresh requests
  /// capture this revision before awaiting the host so an older settled result
  /// cannot erase progress that arrived while the request was in flight.
  final Map<RemoteWorktreeKey, int> _prProgressRevisions = {};
  int _nextPrProgressRevision = 0;

  /// Latest refresh request started for each worktree. Both automatic chat
  /// refreshes and drawer refreshes pass through [runPrAction], so this guards
  /// their shared cache from out-of-order completion.
  final Map<RemoteWorktreeKey, int> _prRefreshRequestRevisions = {};
  int _nextPrRefreshRequestRevision = 0;

  // Action metadata lives here; PR observations remain canonical in store rows.
  final Map<RemoteWorktreeKey, List<RemotePrRepo>> _prActions = {};
  final Map<RemoteWorktreeKey, _PrRepoProjection> _prRepoProjections = {};
  // Last status observed by the action reader or a live session update.
  final Map<RemoteWorktreeKey, List<RemoteWorktreePr>> _observedStatuses = {};
  final Map<RemoteWorktreeKey, _PrLocalState> _observedLocalState = {};
  final Map<RemoteWorktreeKey, DateTime> _refreshedAt = {};
  final Map<RemoteWorktreeKey, bool> _cachedPrBusy = {};

  static const int _kMaxPrProgress = 16;
  static const int _kMaxPrProgressRevisions = 64;

  /// The live PR progress feeds for a worktree, or null when none is in flight.
  RemotePrProgressState? prProgressFor(
    String workspaceLocalId,
    String worktreeLocalId,
  ) => _prProgress[remoteWorktreeKey(workspaceLocalId, worktreeLocalId)];

  List<RemotePrRepo>? cachedPrReposFor(
    String workspaceLocalId,
    String worktreeLocalId,
  ) {
    final key = remoteWorktreeKey(workspaceLocalId, worktreeLocalId);
    final actions = _prActions[key];
    if (actions == null) return null;
    final statuses = _worktree(key)?.prStatuses ?? const <RemoteWorktreePr>[];
    final previous = _prRepoProjections[key];
    if (previous != null &&
        identical(previous.actions, actions) &&
        identical(previous.statuses, statuses)) {
      return previous.repos;
    }
    final repos = [
      for (final repo in actions)
        repo.withPr(
          statuses.where((pr) => pr.repoId == repo.repoId).firstOrNull ??
              (actions.length == 1 && statuses.length == 1
                  ? statuses.single
                  : null),
        ),
    ];
    _prRepoProjections[key] = (
      actions: actions,
      statuses: statuses,
      repos: repos,
    );
    return repos;
  }

  RemoteWorktree? _worktree(RemoteWorktreeKey key) => store.snapshot?.worktrees
      .where((row) => remoteWorktreeKeyOf(row) == key)
      .firstOrNull;

  bool _needsRefresh(RemoteWorktree worktree) {
    final key = remoteWorktreeKeyOf(worktree);
    final actions = _prActions[key];
    final current = _worktree(key) ?? worktree;
    final statuses = current.prStatuses;
    final local = _observedLocalState[key];
    if (local != null &&
        _localEligibilityChanged(local, _localState(current))) {
      return true;
    }
    final observed = _observedStatuses[key];
    if (observed != null && !_samePrReadiness(observed, statuses)) return true;
    if (actions != null &&
        actions.length == 1 &&
        actions.single.headBranch != null &&
        actions.single.headBranch != current.branch) {
      return true;
    }
    final refreshed = _refreshedAt[key];
    if (refreshed == null) return true;
    if (statuses.isEmpty &&
        actions != null &&
        actions.isNotEmpty &&
        actions.every(
          (repo) =>
              repo.published == false && repo.headBranch == current.branch,
        )) {
      return false;
    }
    return _clock().difference(refreshed) >= kRemotePrRefreshInterval;
  }

  bool cachedPrBusyFor(String workspaceLocalId, String worktreeLocalId) =>
      _cachedPrBusy[remoteWorktreeKey(workspaceLocalId, worktreeLocalId)] ??
      false;

  /// A poll for one chat view of [worktree]. Each view owns its poll, so a
  /// hidden view never stops another visible view's refreshes. The view
  /// reports visibility as a plain input and disposes the poll when it goes.
  PrStatePoll pollPrState(RemoteWorktree worktree) {
    final poll = PrStatePoll._(this, worktree);
    _polls.add(poll);
    return poll;
  }

  /// A recovered stream may have missed status or action progress while offline.
  void onDeliveryRecovered() {
    if (!repository.supportsPrStatusPush) return;
    final refreshed = <RemoteWorktreeKey>{};
    for (final poll in _polls.toList()) {
      if (poll._visible && refreshed.add(remoteWorktreeKeyOf(poll.worktree))) {
        poll._missingReadRetries = 0;
        if (poll._inFlight) {
          _refreshedAt.remove(remoteWorktreeKeyOf(poll.worktree));
          _markPrRefreshRequested(remoteWorktreeKeyOf(poll.worktree));
        }
        unawaited(poll._refresh(queueIfBusy: true));
      }
    }
  }

  void reloadAfterSkippedEvents() {
    reset();
    onDeliveryRecovered();
  }

  /// PR readiness and settled local work invalidate host action eligibility.
  /// Unrelated shell updates and repeated observations schedule no read.
  void onSessionChanged() {
    if (!repository.supportsPrStatusPush) return;
    final views = <RemoteWorktreeKey, PrStatePoll>{};
    for (final poll in _polls.toList()) {
      final key = remoteWorktreeKeyOf(poll.worktree);
      if (poll._visible || !views.containsKey(key)) views[key] = poll;
    }
    for (final entry in views.entries) {
      final key = entry.key;
      final poll = entry.value;
      final current = _worktree(key);
      if (current == null) continue;
      final local = _localState(current);
      final previousLocal = _observedLocalState[key];
      _observedLocalState[key] = local;
      final localChanged =
          previousLocal != null &&
          _localEligibilityChanged(previousLocal, local);
      final statuses = current.prStatuses;
      final previous = _observedStatuses[key];
      _observedStatuses[key] = statuses;
      final readinessChanged =
          previous != null && !_samePrReadiness(previous, statuses);
      if (!localChanged && !readinessChanged) continue;
      _refreshedAt.remove(key);
      // Keep opening metadata usable during edits; reconcile when work settles.
      if (readinessChanged || !current.isWorking) {
        _markPrRefreshRequested(key);
        if (poll._visible) {
          unawaited(poll._refresh(queueIfBusy: true));
        }
      }
    }
  }

  /// Refreshes and remembers the PR state for a visible worktree chat.
  Future<void> refreshPrState(RemoteWorktree worktree) async {
    if (!isConnected()) return;
    try {
      // The repository rejects PR actions the desktop does not support.
      await runPrAction(worktree, RemotePrAction.refresh);
    } on Object {
      // Keep the last successful display data while eligibility remains stale.
    }
  }

  /// Waits for the desktop result, including terminal events that race the HTTP acknowledgement.
  Future<Map<String, dynamic>> runPrAction(
    RemoteWorktree worktree,
    RemotePrAction action, {
    String? repoId,
    RemotePrActionIdentity? identity,
    bool confirmUnresolvedComments = false,
  }) async {
    final refreshKey = action == RemotePrAction.refresh
        ? remoteWorktreeKeyOf(worktree)
        : null;
    final refreshSessionGeneration = action == RemotePrAction.refresh
        ? sessionGeneration()
        : null;
    final refreshStatuses = refreshKey == null
        ? null
        : _worktree(refreshKey)?.prStatuses;
    final refreshProgressRevision = refreshKey == null
        ? null
        : (_prProgressRevisions[refreshKey] ?? 0);
    final refreshRequestRevision = refreshKey == null
        ? null
        : _markPrRefreshRequested(refreshKey);

    if (refreshKey != null) {
      _observedStatuses[refreshKey] = refreshStatuses ?? const [];
      final current = _worktree(refreshKey);
      if (current != null) {
        _observedLocalState[refreshKey] = _localState(current);
      }
    }

    Map<String, dynamic> complete(Map<String, dynamic> result) {
      if (action == RemotePrAction.refresh) {
        if (sessionGeneration() != refreshSessionGeneration || !isConnected()) {
          return remotePrActionDiscardedResult;
        }
        final key = refreshKey!;
        if (_prRefreshRequestRevisions[key] != refreshRequestRevision) {
          return remotePrActionDiscardedResult;
        }
        if ((_prProgressRevisions[key] ?? 0) != refreshProgressRevision) {
          _refreshedAt.remove(key);
          if (repository.supportsPrStatusPush) {
            for (final poll in _polls) {
              if (poll._visible && remoteWorktreeKeyOf(poll.worktree) == key) {
                unawaited(poll._refresh(queueIfBusy: true));
                break;
              }
            }
          }
          return remotePrActionDiscardedResult;
        }
        final statusChanged = !sameRemotePrStatuses(
          _worktree(key)?.prStatuses,
          refreshStatuses,
        );
        final repos = (result['repos'] as List? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(RemotePrRepo.fromJson)
            .toList(growable: false);
        if (!statusChanged) {
          store.applyPrStatuses({
            '${worktree.workspaceLocalId}:${worktree.localId}': [
              for (final repo in repos)
                if (repo.createBlockedReason == 'pr_status_unavailable')
                  RemoteWorktreePr(
                    repoId: repos.length == 1 && refreshStatuses?.length == 1
                        ? refreshStatuses!.single.repoId
                        : repo.repoId,
                    state: '',
                    lookupAvailable: false,
                  )
                else
                  ?repo.pr,
            ],
          }, source: RemotePrObservationSource.actionRead);
        }
        _prActions[key] = [for (final repo in repos) repo.withPr(null)];
        if (repos.any(
          (repo) => repo.createBlockedReason == 'pr_status_unavailable',
        )) {
          _refreshedAt.remove(key);
        } else if (!statusChanged) {
          _refreshedAt[key] = _clock();
        }
        if (!statusChanged) {
          _observedStatuses[key] = _worktree(key)?.prStatuses ?? const [];
        }
        _cachedPrBusy[key] = result['busy'] == true;
        // A settled host response is authoritative for whether a PR command
        // remains active. This repairs a missed terminal progress delta after
        // navigating away mid-creation or merge, while retaining failed feeds
        // because their error details are still useful to the user.
        final progress = _prProgress[key];
        if (result['busy'] != true && progress != null) {
          final settled = RemotePrProgressState(
            creation:
                progress.creation?.currentPhase == RemotePrCreationPhase.error
                ? progress.creation
                : null,
            merge: progress.merge?.currentPhase == RemoteMergePrPhase.error
                ? progress.merge
                : null,
          );
          if (settled.isEmpty) {
            _prProgress.remove(key);
          } else {
            _prProgress[key] = settled;
          }
          _markPrProgressChanged(key);
        }
        for (final poll in _polls) {
          if (!poll._inFlight && remoteWorktreeKeyOf(poll.worktree) == key) {
            poll._arm();
          }
        }
        notify();
        if (statusChanged) return remotePrActionDiscardedResult;
      }
      // Other actions report their effect through the `pr` delta; the
      // overview scope carries no PR activity, so nothing is re-read.
      return result;
    }

    try {
      final response = await repository.runPrAction(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        action: action,
        repoId: repoId,
        identity: identity,
        confirmUnresolvedComments: confirmUnresolvedComments,
      );
      return complete(await awaitCommandResult(response));
    } on Object {
      if (refreshKey != null &&
          sessionGeneration() == refreshSessionGeneration &&
          isConnected() &&
          _prRefreshRequestRevisions[refreshKey] == refreshRequestRevision) {
        _refreshedAt.remove(refreshKey);
      }
      rethrow;
    }
  }

  /// Pauses or resumes hooks in a worktree. The desktop's `portal.hook.event`
  /// upserts update the sidebar; the overview scope carries no hooks, so
  /// nothing is re-read. Errors surface to the caller so the UI can show a
  /// snackbar.
  Future<void> setHooksPaused({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required bool paused,
    String? hookKey,
    bool all = false,
  }) async {
    await submit(
      () => repository.setHooksPaused(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        paused: paused,
        hookKey: hookKey,
        all: all,
      ),
    );
  }

  bool applyPrProgress(Map<String, RemotePrProgressState>? progress) {
    if (progress == null || progress.isEmpty) return false;
    for (final entry in progress.entries) {
      final key = remoteWorktreeKeyFromEvent(entry.key);
      if (key == null) continue;
      final current = _prProgress[key];
      final patch = entry.value;
      final currentMerge = current?.merge;
      final patchMerge = patch.merge;
      final next = RemotePrProgressState(
        creation: patch.clearCreation
            ? null
            : (patch.creation ?? current?.creation),
        merge: patch.clearMerge
            ? null
            : patchMerge == null ||
                  (currentMerge != null &&
                      patchMerge.isEarlierReadOf(currentMerge))
            ? currentMerge
            : patchMerge,
      );
      if (next.isEmpty) {
        _prProgress.remove(key);
      } else {
        _prProgress[key] = next;
      }
      _markPrProgressChanged(key);
    }
    while (_prProgress.length > _kMaxPrProgress) {
      _prProgress.remove(_prProgress.keys.first);
    }
    return true;
  }

  void _markPrProgressChanged(RemoteWorktreeKey key) {
    _prProgressRevisions.remove(key);
    _prProgressRevisions[key] = ++_nextPrProgressRevision;
    while (_prProgressRevisions.length > _kMaxPrProgressRevisions) {
      _prProgressRevisions.remove(_prProgressRevisions.keys.first);
    }
  }

  int _markPrRefreshRequested(RemoteWorktreeKey key) {
    final revision = ++_nextPrRefreshRequestRevision;
    _prRefreshRequestRevisions.remove(key);
    _prRefreshRequestRevisions[key] = revision;
    while (_prRefreshRequestRevisions.length > _kMaxPrProgressRevisions) {
      _prRefreshRequestRevisions.remove(_prRefreshRequestRevisions.keys.first);
    }
    return revision;
  }

  void reset() {
    _prProgress.clear();
    _prProgressRevisions.clear();
    _prRefreshRequestRevisions.clear();
    _prActions.clear();
    _prRepoProjections.clear();
    _refreshedAt.clear();
    _observedStatuses.clear();
    _observedLocalState.clear();
    _cachedPrBusy.clear();
  }

  void dispose() {
    for (final poll in _polls.toList()) {
      poll.dispose();
    }
    reset();
  }
}

/// Refreshes stale PR state on open. Legacy desktops retain the one-minute
/// cadence; push hosts repeat busy reads and retry missing opening metadata once.
/// One refresh runs at a time; a refresh requested
/// by visibility while one is running queues at most one trailing refresh,
/// which still needs the view visible in the same session when it starts.
final class PrStatePoll {
  PrStatePoll._(this._tracker, this.worktree);

  final PrStateTracker _tracker;
  final RemoteWorktree worktree;
  bool _visible = false;
  bool _disposed = false;
  bool _inFlight = false;
  bool _trailing = false;
  Timer? _tick;
  int _missingReadRetries = 0;

  /// Whether the view is shown and the app is in the foreground. Becoming
  /// visible refreshes at once; becoming hidden stops the cadence.
  void setVisible(bool visible) {
    if (_disposed || visible == _visible) return;
    _visible = visible;
    _tick?.cancel();
    _tick = null;
    if (!visible || !_tracker.repository.supportsPrActions) return;
    _missingReadRetries = 0;
    if (!_tracker.repository.supportsPrStatusPush ||
        _tracker._needsRefresh(worktree)) {
      unawaited(_refresh(queueIfBusy: true));
    } else {
      _arm();
    }
  }

  void _arm() {
    _tick?.cancel();
    _tick = null;
    if (_disposed || !_visible) return;
    // Busy actions still need a follow-up: older progress/lock paths can end
    // without a PR-status change. A settled push-capable chat has no timer.
    if (_tracker.repository.supportsPrStatusPush &&
        !_tracker.cachedPrBusyFor(
          worktree.workspaceLocalId,
          worktree.localId,
        )) {
      // One retry can recover missing or unavailable action metadata without
      // restoring an idle poll. An empty successful list counts as usable.
      final key = remoteWorktreeKeyOf(worktree);
      final actions = _tracker._prActions[key];
      final hasUsableActions =
          _tracker._refreshedAt.containsKey(key) &&
          actions != null &&
          actions.every(
            (repo) => repo.createBlockedReason != 'pr_status_unavailable',
          );
      if (hasUsableActions) {
        _missingReadRetries = 0;
        return;
      }
      if (_missingReadRetries >= 1) return;
      _missingReadRetries++;
    }
    _tick = _tracker._timer(kRemotePrRefreshInterval, () {
      _tick = null;
      if (_disposed || !_visible) return;
      unawaited(_refresh());
    });
  }

  Future<void> _refresh({bool queueIfBusy = false}) async {
    if (_inFlight) {
      if (queueIfBusy) _trailing = true;
      return;
    }
    _inFlight = true;
    final generation = _tracker.sessionGeneration();
    try {
      await _tracker.refreshPrState(worktree);
    } finally {
      _inFlight = false;
      _arm();
    }
    if (!_trailing) return;
    _trailing = false;
    if (_disposed ||
        !_visible ||
        !_tracker.repository.supportsPrActions ||
        generation != _tracker.sessionGeneration()) {
      return;
    }
    if (!_tracker.repository.supportsPrStatusPush ||
        _tracker._needsRefresh(worktree)) {
      unawaited(_refresh());
    }
  }

  void dispose() {
    _disposed = true;
    _tick?.cancel();
    _tick = null;
    _tracker._polls.remove(this);
  }
}

// Only host-relevant changes invalidate action eligibility. Per-job detail and
// queue position updates are display data and do not need another action read.
Record _prReadiness(RemoteWorktreePr pr, {bool includeRepoId = true}) => (
  includeRepoId ? pr.repoId : null,
  pr.prNumber,
  pr.url,
  pr.state,
  pr.baseRefName,
  pr.checkStatus,
  pr.reviewStatus,
  pr.mergeReady,
  pr.hasConflicts,
  pr.unresolvedReviewThreadCount ?? pr.commentCount,
  pr.mergeQueue?.inQueue,
);

bool _samePrReadiness(List<RemoteWorktreePr> a, List<RemoteWorktreePr> b) =>
    _listEquals(
      [for (final pr in a) _prReadiness(pr, includeRepoId: a.length != 1)],
      [for (final pr in b) _prReadiness(pr, includeRepoId: b.length != 1)],
    );

_PrLocalState _localState(RemoteWorktree row) => (
  branch: row.branch,
  insertions: row.insertions,
  deletions: row.deletions,
  working: row.isWorking,
);

bool _localEligibilityChanged(_PrLocalState previous, _PrLocalState current) =>
    previous.branch != current.branch ||
    previous.insertions != current.insertions ||
    previous.deletions != current.deletions ||
    (previous.working && !current.working);

bool _listEquals<T>(List<T> a, List<T> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}
