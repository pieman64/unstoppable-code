import 'dart:async';

import 'remote_identity.dart';

/// Coalesces scheduled reconciliation: a foreground return the Remote
/// surface could not read at once, a failed refresh, or a shell delta the
/// reducer cannot apply.
/// Ordinary streamed deltas apply locally and never schedule an overview read.
const Duration kRemoteStateRefreshDebounce = Duration(milliseconds: 1200);

/// Fallback budget for shell mutations the mobile reducer cannot yet apply.
const Duration kRemoteDeltaRefreshInterval = Duration(seconds: 30);

/// Consecutive failed scheduled refreshes counted towards the retry backoff.
const int _kMaxCountedRefreshFailures = 5;

/// Worktree-snapshot follow-ups released with one overview read.
typedef OverviewFollowUp = ({
  /// Worktrees whose snapshot signalled that the server cache is ready. Their
  /// chat-tab loading state clears once the read lands.
  Set<RemoteWorktreeKey> resolvedWorktrees,

  /// Worktrees whose activity slices were projected and must be re-read.
  Set<RemoteWorktreeKey> hydratedWorktrees,

  /// Whether this read also answers a pending scheduled refresh, so its
  /// failure counts towards the retry backoff.
  bool countFailure,
});

/// Runs one overview read and reports whether it landed. A null follow-up
/// is a plain scheduled refresh.
typedef OverviewRefresh = Future<bool> Function(OverviewFollowUp? followUp);

/// When the Remote surface re-reads the session overview.
///
/// Refreshes are debounced, spaced by [kRemoteDeltaRefreshInterval] after a
/// success when only streamed deltas asked for them, and backed off after
/// failures. They run only while the app is foregrounded, connected, and a
/// Remote surface is visible.
///
/// CAN-3370: each overview read makes the server queue a desktop overview
/// build, and the desktop answers state requests one at a time. A build
/// queued while a chat opens delays that transcript by the whole build, so
/// overview reads wait while [isHydrationPending] holds. Deferred reads are
/// released after the current event batch, so follow-ups gathered from one
/// batch share one read.
final class OverviewRefreshScheduler {
  OverviewRefreshScheduler({
    required this.isConnected,
    required this.isBackgrounded,
    required this.isHydrationPending,
    required this.needsOverviewRequest,
    required this.onRefresh,
    this.debounce = kRemoteStateRefreshDebounce,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final bool Function() isConnected;
  final bool Function() isBackgrounded;

  /// Whether a chat transcript or foreground chat is still hydrating.
  final bool Function() isHydrationPending;

  /// Whether the next scheduled refresh must first ask the desktop for a
  /// fresh projection. Such a refresh cannot be answered by a follow-up read
  /// of the server cache.
  final bool Function() needsOverviewRequest;
  final OverviewRefresh onRefresh;

  /// See [kRemoteStateRefreshDebounce].
  final Duration debounce;

  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  bool _tabVisible = true;
  int _visibleRoutes = 0;

  bool _pending = false;
  bool _deltaOnly = true;
  bool _armedIsDelta = true;
  DateTime? _lastSuccessAt;
  int _failures = 0;
  Timer? _armed;

  /// Overview reads held back by [isHydrationPending]: a scheduled refresh,
  /// plus the worktree-snapshot follow-ups.
  bool _deferred = false;
  final Set<RemoteWorktreeKey> _deferredResolved = {};
  final Set<RemoteWorktreeKey> _deferredHydrated = {};
  bool _releaseQueued = false;

  /// Replaced on [reset], so a follow-up read that outlives its session
  /// cannot schedule work in the next one.
  Object _session = Object();
  bool _disposed = false;

  /// Whether the Remote tab or a Remote route is showing.
  bool get isVisible => _tabVisible || _visibleRoutes > 0;

  /// Home's IndexedStack keeps Remote mounted on other tabs. Keep consuming
  /// events there, but defer automatic overview reconciliation until return.
  void setRemoteVisible(bool visible) {
    if (_tabVisible == visible) return;
    final wasVisible = isVisible;
    _tabVisible = visible;
    _syncVisibility(wasVisible);
  }

  /// Keep overview reconciliation active while a Remote chat route covers a
  /// different Home tab. The returned callback releases this route on pop.
  void Function() beginRemoteRouteVisibility() {
    final wasVisible = isVisible;
    _visibleRoutes++;
    _syncVisibility(wasVisible);
    var released = false;
    return () {
      if (released) return;
      released = true;
      final wasVisible = isVisible;
      _visibleRoutes--;
      _syncVisibility(wasVisible);
    };
  }

  void _syncVisibility(bool wasVisible) {
    final visible = isVisible;
    if (wasVisible == visible) return;
    if (!visible) {
      cancelArmed();
    } else if (_pending) {
      _arm();
    }
  }

  /// Requests an overview read. [fromDelta] marks a request that only
  /// streamed deltas asked for; those wait out [kRemoteDeltaRefreshInterval]
  /// after the last successful read.
  void schedule({bool fromDelta = false}) {
    _pending = true;
    _deltaOnly = _deltaOnly && fromDelta;
    _arm();
  }

  /// Claims the pending scheduled refresh for a read that is starting now.
  ({bool pending, bool deltaOnly}) takePending() {
    cancelArmed();
    final taken = (pending: _pending, deltaOnly: _deltaOnly);
    _pending = false;
    _deltaOnly = true;
    return taken;
  }

  /// Records a landed overview read: resets the backoff and starts the delta
  /// interval.
  void recordSuccess() {
    _lastSuccessAt = _clock();
    _failures = 0;
  }

  /// Records a failed read that answered a scheduled refresh.
  void recordFailure() {
    if (_failures < _kMaxCountedRefreshFailures) _failures++;
  }

  /// Cancels the armed refresh without dropping the request, so it re-arms
  /// on the next foreground or visibility change.
  void cancelArmed() {
    _armed?.cancel();
    _armed = null;
  }

  /// Holds worktree-snapshot follow-ups until chat hydration settles, then
  /// releases them with one read after the current event batch.
  void deferWorktreeFollowUp(
    Set<RemoteWorktreeKey> resolvedWorktrees,
    Set<RemoteWorktreeKey> hydratedWorktrees,
  ) {
    _deferredResolved.addAll(resolvedWorktrees);
    _deferredHydrated.addAll(hydratedWorktrees);
    releaseDeferred();
  }

  /// Releases deferred reads after the current event batch, unless chat
  /// hydration is still pending.
  void releaseDeferred() {
    if (isHydrationPending()) return;
    if (_releaseQueued) return;
    if (!_deferred && _deferredResolved.isEmpty) return;
    _releaseQueued = true;
    scheduleMicrotask(_release);
  }

  void _release() {
    _releaseQueued = false;
    if (_disposed || !isConnected() || isHydrationPending()) return;
    _deferred = false;
    if (_deferredResolved.isEmpty) {
      if (_pending) _arm();
      return;
    }
    final resolvedWorktrees = {..._deferredResolved};
    final hydratedWorktrees = {..._deferredHydrated};
    _deferredResolved.clear();
    _deferredHydrated.clear();
    // The follow-up reads the same overview cache as a scheduled refresh, so
    // it also answers one, unless that refresh must first ask the desktop.
    final coalesced = _pending && !needsOverviewRequest();
    final deltaOnly = _deltaOnly;
    if (coalesced) {
      _pending = false;
      _deltaOnly = true;
      cancelArmed();
    } else if (_pending) {
      _arm();
    }
    final session = _session;
    unawaited(() async {
      final applied = await onRefresh((
        resolvedWorktrees: resolvedWorktrees,
        hydratedWorktrees: hydratedWorktrees,
        countFailure: coalesced,
      ));
      if (_disposed || !identical(session, _session)) return;
      if (coalesced && !applied) schedule(fromDelta: deltaOnly);
    }());
  }

  void _arm() {
    if (isBackgrounded() || !isVisible || !isConnected()) return;
    if (isHydrationPending()) {
      _deferred = true;
      return;
    }
    // An armed refresh is kept unless it only waits out the delta interval
    // and this request needs an earlier read.
    if (_armed?.isActive == true && (_deltaOnly || !_armedIsDelta)) return;
    _armed?.cancel();
    _armedIsDelta = _deltaOnly;
    _armed = _timer(delay, () {
      _armed = null;
      // A chat opened while this refresh was armed.
      if (isHydrationPending()) {
        _deferred = true;
        return;
      }
      unawaited(onRefresh(null));
    });
  }

  /// How long a refresh armed now waits.
  Duration get delay {
    var delay = debounce;
    final lastSuccess = _lastSuccessAt;
    if (_deltaOnly && lastSuccess != null) {
      final remaining =
          kRemoteDeltaRefreshInterval - _clock().difference(lastSuccess);
      if (remaining > delay) delay = remaining;
    }
    if (_failures > 0) {
      final retryBase = debounce > Duration.zero
          ? debounce
          : const Duration(seconds: 1);
      final retryDelay = retryBase * (1 << _failures);
      final boundedRetry = retryDelay > kRemoteDeltaRefreshInterval
          ? kRemoteDeltaRefreshInterval
          : retryDelay;
      if (boundedRetry > delay) delay = boundedRetry;
    }
    return delay;
  }

  /// Forgets the discarded session's requests and backoff. Visibility is
  /// owned by the UI and survives.
  void reset() {
    cancelArmed();
    _session = Object();
    _pending = false;
    _deltaOnly = true;
    _deferred = false;
    _deferredResolved.clear();
    _deferredHydrated.clear();
    _lastSuccessAt = null;
    _failures = 0;
  }

  void dispose() {
    _disposed = true;
    reset();
  }
}
