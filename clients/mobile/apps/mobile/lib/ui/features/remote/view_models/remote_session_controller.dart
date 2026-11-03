import 'dart:async';
import 'dart:math' as math;

import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'remote_identity.dart';
import 'remote_session_store.dart' show RemoteSnapshotReadBaseline;

/// Most events the server returns in one batch
/// (`PORTAL_BROWSER_EVENT_PAGE_MAX_COUNT` in the web event service). A full
/// batch means more backlog is queued behind it; a shorter one means the
/// replay has caught up, except for the rare batch cut by the byte budget.
const int kRemotePortalEventBatchMaxCount = 25;

/// Longest the post-unlock replay may hold back repaints. The backlog after
/// a long lock arrives as dozens of back-to-back batches; painting each one
/// replays every streaming revision and every intermediate sidebar on screen.
/// The cap keeps a backlog that never reports a short batch, or an overview
/// read that never lands, from freezing the UI.
const Duration kRemoteEventCatchUpMaxHold = Duration(seconds: 4);

/// How long the app may stay in the background before its return reloads the
/// session instead of replaying the events it missed. A longer absence
/// leaves a backlog that would stream onto the screen for seconds; reloading
/// moves it once to the current state, the way a relaunch does.
const Duration kRemoteFreshResumeAfter = Duration(minutes: 1);

/// Minimum spacing between auto-restore probes, so rapid
/// foreground/background cycles cannot hammer `GET .../session`.
const Duration _restoreProbeThrottle = Duration(seconds: 5);

/// Spacing of automatic retries after a restore probe that could not reach the
/// server (CAN-3557); the last value repeats. The first is no shorter than
/// [_restoreProbeThrottle], so a retry is never throttled away.
const List<Duration> _restoreRetryDelays = [
  Duration(seconds: 5),
  Duration(seconds: 10),
  Duration(seconds: 20),
  Duration(seconds: 30),
];

/// Longest a pairing's first snapshot waits for its session caches to load.
/// The persisted chat tails load alongside the snapshot read, so they are in
/// memory before chats can be opened; a slow disk falls back to the network
/// rather than delaying the session.
const Duration kRemoteSessionCacheBudget = Duration(milliseconds: 500);

/// How long event delivery may be down before the app says it is
/// reconnecting. Covers a normal resume, where the stream answers within a
/// second, so returning to the app does not flash a warning (CAN-3557).
const Duration kRemoteReconnectingGrace = Duration(seconds: 2);

/// How long event delivery may be down before the app stops saying it is
/// reconnecting and says the server cannot be reached. Retries continue.
const Duration kRemoteUnreachableAfter = Duration(seconds: 30);

/// Whether this phone's own connection to the server is delivering events.
/// Independent of the desktop's liveness, which the server reports in
/// [RemotePortalConnectionStatus].
enum RemoteLinkState {
  /// Delivering, or down for less than [kRemoteReconnectingGrace].
  live,

  /// Down for longer than the grace; what is on screen is a cache.
  reconnecting,

  /// Down for longer than [kRemoteUnreachableAfter]; still retrying.
  unreachable,
}

enum RemoteSnapshotRefreshOutcome { applied, failed, superseded }

/// A snapshot read and the load generation it ran under.
typedef RemoteSnapshotRefreshResult = ({
  int generation,
  RemoteSnapshotRefreshOutcome outcome,
});

/// Applies a fetched snapshot to the session's state.
typedef RemoteSnapshotApplier =
    void Function(
      RemoteSessionSnapshot snapshot, {
      RemoteSnapshotReadBaseline? baseline,
    });

bool _isDegradedConnection(RemotePortalConnectionStatus? status) =>
    status == RemotePortalConnectionStatus.reconnecting ||
    status == RemotePortalConnectionStatus.inactive;

/// The pairing lifecycle of one Remote Control client: connect, restore, and
/// disconnect; the live event subscription; and foreground/background input.
///
/// Every asynchronous path captures the load generation it started under and
/// drops its result once a newer connect/restore/refresh/disconnect, a
/// session end, or disposal has advanced it. The session generation advances
/// whenever a pairing starts or is discarded, so work bound to one pairing
/// cannot apply to the next. Metadata refreshes of the same pairing replace
/// [connection] but keep the session generation.
final class RemoteSessionController {
  RemoteSessionController({
    required this.repository,
    required this.notify,
    required this.isDisposed,
    required this.applySnapshot,
    required this.onSnapshotApplied,
    required this.captureReadBaseline,
    required this.clearSnapshot,
    required this.hasSnapshot,
    required this.resetSession,
    required this.discardMissedEventState,
    required this.restoreSessionCaches,
    required this.onEventBatch,
    required this.onBackgrounded,
    required this.onForegrounded,
    required this.onEventsStopped,
    required this.onDeliveryRecovered,
    required this.canRefreshOnForeground,
    required this.refresh,
    required this.scheduleRefresh,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final void Function() notify;
  final bool Function() isDisposed;
  final RemoteSnapshotApplier applySnapshot;

  /// A snapshot read under load [generation] was applied.
  final void Function(int generation) onSnapshotApplied;
  final RemoteSnapshotReadBaseline Function() captureReadBaseline;
  final void Function() clearSnapshot;
  final bool Function() hasSnapshot;

  /// Discards every collaborator's state for the paired session.
  final void Function() resetSession;

  /// Drops the state that events skipped by a fresh resume would have
  /// updated, keeping the pairing; see [kRemoteFreshResumeAfter].
  final void Function() discardMissedEventState;

  /// Scopes session-keyed caches to [sessionId]; null when the server
  /// reported no session. A returned future completes once they are loaded.
  final FutureOr<void> Function(String? sessionId) restoreSessionCaches;
  final void Function(RemotePortalEventBatch batch) onEventBatch;
  final void Function() onBackgrounded;
  final void Function() onForegrounded;
  final void Function() onEventsStopped;

  /// Event delivery came back after [RemoteLinkState.reconnecting], or the
  /// desktop came back from reconnecting or inactive. Not called for a
  /// resume that answers within the grace, or for a new pairing.
  final void Function() onDeliveryRecovered;

  /// Whether a foreground should re-read the overview now rather than
  /// schedule it.
  final bool Function() canRefreshOnForeground;
  final Future<bool> Function() refresh;
  final void Function() scheduleRefresh;

  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  RemoteConnectionStatus _status = RemoteConnectionStatus.disconnected;
  RemoteConnection? _connection;
  Object? _error;
  int _loadGeneration = 0;
  int _sessionGeneration = 0;
  bool _eventsResumed = false;
  bool _awaitingPostForegroundBatch = false;

  /// Set while the post-unlock replay is draining; see
  /// [_holdPaintsUntilCaughtUp].
  Timer? _catchUpHold;
  bool _paintHeld = false;

  /// The held foreground's overview read, until it settles.
  Object? _foregroundRead;

  /// Whether full backlog pages are still arriving under the hold.
  bool _replayDraining = false;
  bool _isAppBackgrounded = false;

  /// When the current background began; null while foregrounded.
  DateTime? _backgroundedAt;

  /// Set while the event cursor is discarded and no snapshot has replaced the
  /// state the skipped events would have updated. Delivery stays paused until
  /// one does: resuming without a seeded cursor would replay the session.
  bool _awaitingFreshSnapshot = false;
  Timer? _freshSnapshotRetry;
  int _freshSnapshotRetryAttempt = 0;
  DateTime? _lastRestoreProbeAt;

  /// True while the latest restore probe could not reach the server, so a
  /// server-side pairing may still exist. Cleared by a definitive probe and
  /// by a manual connect or disconnect.
  bool _restoreInconclusive = false;
  Timer? _restoreRetry;
  int _restoreRetryAttempt = 0;

  /// True when [_status] is [RemoteConnectionStatus.error] because the desktop
  /// ended the session, rather than because a pairing code was rejected. An
  /// auto-probe over a live pairing error (CAN-2588's surface) would stomp the
  /// inline message the user is reading, so only the former is re-probeable.
  bool _errorFromSessionEnded = false;
  bool _refreshingConnectionMetadata = false;
  bool _restoring = false;
  bool _hasProbedSession = false;

  /// Set by [settleWithoutDesktop].
  bool _noDesktop = false;
  RemotePortalConnectionStatus? _portalConnectionStatus;
  StreamSubscription<RemotePortalEventBatch>? _eventsSubscription;
  StreamSubscription<bool>? _eventsLiveSubscription;
  RemoteLinkState _linkState = RemoteLinkState.live;
  Timer? _linkGraceTimer;
  Timer? _linkVerdictTimer;
  Future<RemoteSnapshotRefreshResult>? _latestSnapshotRefresh;

  /// Current pairing lifecycle state.
  RemoteConnectionStatus get status => _status;

  /// Metadata about the paired desktop; non-null only when [isConnected].
  RemoteConnection? get connection => _connection;

  /// Non-null when the most recent connect/fetch ended with an error.
  Object? get error => _error;

  /// True while a pairing attempt is in flight.
  bool get isConnecting => _status == RemoteConnectionStatus.connecting;

  /// True when paired with a desktop.
  bool get isConnected => _status == RemoteConnectionStatus.connected;

  /// True while the one-shot session restore probe is in flight.
  bool get isRestoring => _restoring;

  /// True once a restore probe has definitively found a session or its absence.
  /// An inconclusive probe cannot establish that there is no paired desktop.
  bool get hasProbedSession => _hasProbedSession;

  /// True while restore keeps retrying because the server could not be
  /// reached; a paired desktop may still exist (CAN-3557).
  bool get isRestoreRetrying => _restoreInconclusive;

  /// This phone's own event delivery. Only meaningful while connected and
  /// foregrounded; reads [RemoteLinkState.live] otherwise.
  RemoteLinkState get linkState => _linkState;

  /// True while the app is backgrounded; live delivery is paused.
  bool get isAppBackgrounded => _isAppBackgrounded;

  /// Desktop liveness derived server-side from heartbeat age; refreshed by
  /// every event batch. Null until the first batch (or state read) arrives.
  RemotePortalConnectionStatus? get portalConnectionStatus =>
      _portalConnectionStatus;

  /// Whether the desktop is reconnecting or inactive.
  bool get isDegraded => _isDegradedConnection(_portalConnectionStatus);

  /// Advances on every connect/restore/refresh/disconnect and session end;
  /// async work started under an older value is stale.
  int get loadGeneration => _loadGeneration;

  /// Changes whenever a pairing starts or the paired remote session is
  /// discarded; stable across metadata refreshes of the same pairing.
  int get sessionGeneration => _sessionGeneration;

  /// True when an auto-restore probe of an existing server-side pairing
  /// (`GET .../session`) is currently allowed.
  ///
  /// CAN-2651: this used to be a permanent one-shot latch. Combined with
  /// [onAppForegrounded]'s `!isConnected` early return and a view model that is
  /// created once at the app root, a single unlucky cold start — during a Mac
  /// sleep or a Wi-Fi drop — stranded the user on the six-digit pairing form
  /// for the whole process lifetime. The gate is now "nothing connected and no
  /// attempt in flight", throttled rather than latched.
  bool _canAutoRestore() {
    if (_noDesktop) return false;
    if (_restoring || _status == RemoteConnectionStatus.connecting) {
      return false;
    }
    if (_status == RemoteConnectionStatus.connected) return false;
    if (_status == RemoteConnectionStatus.error && !_errorFromSessionEnded) {
      return false;
    }
    final lastProbe = _lastRestoreProbeAt;
    if (lastProbe != null &&
        _clock().difference(lastProbe) < _restoreProbeThrottle) {
      return false;
    }
    return true;
  }

  /// Records that this session cannot pair a desktop, such as a guest's
  /// (CAN-2872). The Portal refuses it, so a restore probe could only come
  /// back inconclusive and retry for good, leaving everything that waits on
  /// [hasProbedSession] (the first cloud project, a remembered computer
  /// destination) waiting with it. The pairing counts as answered with no
  /// desktop, an in-flight probe is dropped, and restore stops probing.
  ///
  /// Pass `notify: false` from a widget's `initState`, before anything below
  /// it has read this session.
  void settleWithoutDesktop({bool notify = true}) {
    if (_noDesktop) return;
    _noDesktop = true;
    ++_loadGeneration;
    _restoring = false;
    _cancelRestoreRetry();
    _restoreRetryAttempt = 0;
    _restoreInconclusive = false;
    _hasProbedSession = true;
    if (notify) this.notify();
  }

  /// Undoes [settleWithoutDesktop] when the session that could not pair ends,
  /// so a session that can pair, such as the account a guest signed in to,
  /// probes and restores its desktop as usual.
  ///
  /// Pass `notify: false` from a widget's `dispose`, where notifying is not
  /// allowed; the next restore notifies.
  void allowDesktop({bool notify = true}) {
    if (!_noDesktop) return;
    _noDesktop = false;
    _hasProbedSession = false;
    _lastRestoreProbeAt = null;
    if (notify) this.notify();
  }

  /// Auto-restore of an existing server-side pairing (`GET .../session`).
  ///
  /// Runs on first build of the Remote tab and again on every foreground while
  /// disconnected, throttled to [_restoreProbeThrottle]. No-op while connected,
  /// while a pairing attempt is in flight, or over a pairing error the user
  /// still needs to see.
  ///
  /// A probe that cannot reach the server retries on its own while the app is
  /// foregrounded, so reopening the app during a network blip does not leave
  /// a live pairing behind the pairing form (CAN-3557).
  Future<void> restoreIfIdle() async {
    if (!_canAutoRestore()) {
      _scheduleRestoreRetry();
      return;
    }
    _cancelRestoreRetry();
    _lastRestoreProbeAt = _clock();
    final generation = ++_loadGeneration;
    _restoring = true;
    notify();
    var probeWasDefinitive = false;

    try {
      final probe = await repository.probeSession();
      if (generation != _loadGeneration) return;
      probeWasDefinitive = probe.outcome != RemoteSessionProbeOutcome.unknown;
      final connection = probe.connection;
      if (connection == null) {
        if (probe.outcome == RemoteSessionProbeOutcome.gone) {
          restoreSessionCaches(null);
        }
        return;
      }
      final caches = restoreSessionCaches(connection.sessionId);
      _connection = connection;
      _adoptConnectionStatus(connection);
      _status = RemoteConnectionStatus.connected;
      _errorFromSessionEnded = false;
      final snapshot = await repository.fetchSnapshot();
      if (generation != _loadGeneration) return;
      await _sessionCachesLoaded(caches);
      if (generation != _loadGeneration) return;
      applySnapshot(snapshot);
      onSnapshotApplied(generation);
      _error = null;
      _startEventsAfterSnapshot(generation);
    } catch (e) {
      if (generation != _loadGeneration) return;
      if (_connection == null) {
        // Restore is best-effort when no server-side pairing exists.
        _status = RemoteConnectionStatus.disconnected;
      } else {
        // The pairing is valid even if its first shell-state read failed.
        // Preserve it so the connected surface can offer a retry.
        _status = RemoteConnectionStatus.connected;
        _error = e;
      }
    } finally {
      if (generation == _loadGeneration) {
        _restoring = false;
        _hasProbedSession = probeWasDefinitive;
        _restoreInconclusive = !probeWasDefinitive && _connection == null;
        if (_restoreInconclusive) {
          _scheduleRestoreRetry();
        } else {
          _restoreRetryAttempt = 0;
          _cancelRestoreRetry();
        }
        notify();
      }
    }
  }

  /// Waits for [caches] to load, at most [kRemoteSessionCacheBudget]. A
  /// failed load counts as loaded: caches are disposable.
  Future<void> _sessionCachesLoaded(FutureOr<void> caches) async {
    if (caches is! Future<void>) return;
    final loaded = Completer<void>();
    void finish() {
      if (!loaded.isCompleted) loaded.complete();
    }

    final budget = _timer(kRemoteSessionCacheBudget, finish);
    unawaited(
      caches.then<void>((_) {}, onError: (Object _) {}).whenComplete(finish),
    );
    await loaded.future;
    budget.cancel();
  }

  /// Re-probes after an inconclusive restore. No-op while backgrounded, when
  /// a retry is already pending, or when nothing is left to restore.
  void _scheduleRestoreRetry() {
    if (!_restoreInconclusive || _isAppBackgrounded || isDisposed()) return;
    if (_restoreRetry != null) return;
    final delay =
        _restoreRetryDelays[math.min(
          _restoreRetryAttempt,
          _restoreRetryDelays.length - 1,
        )];
    _restoreRetryAttempt += 1;
    _restoreRetry = _timer(delay, () {
      _restoreRetry = null;
      unawaited(restoreIfIdle());
    });
  }

  void _cancelRestoreRetry() {
    _restoreRetry?.cancel();
    _restoreRetry = null;
  }

  /// A manual connect or disconnect supersedes any pending restore retry.
  void _abandonRestoreRetry() {
    _restoreInconclusive = false;
    _restoreRetryAttempt = 0;
    _cancelRestoreRetry();
  }

  /// Seeds the degraded-banner state from the session the server just
  /// reported, so a restore onto a stale session renders the banner right away
  /// instead of waiting for the first event batch (CAN-2651) — which, on a
  /// session that is stale precisely because the desktop went quiet, is exactly
  /// the wrong thing to wait for.
  void _adoptConnectionStatus(RemoteConnection connection) {
    final status = connection.connectionStatus;
    if (status != null) {
      _portalConnectionStatus = status;
    }
  }

  /// Pairs with a desktop using [pairingCode], then loads the first snapshot.
  ///
  /// Transitions disconnected → connecting → connected on success. A pairing
  /// rejection transitions to error; a snapshot failure after successful
  /// pairing remains connected so the one-shot code is not lost and the state
  /// read can be retried. A slow in-flight attempt whose result is superseded
  /// by a newer connect/refresh/disconnect, or by disposal, is discarded via a
  /// load-generation guard.
  Future<void> connect(String pairingCode) async {
    _abandonRestoreRetry();
    final generation = ++_loadGeneration;
    // A new pairing, even one that reuses the server session id, must not
    // accept work started under the previous one.
    _sessionGeneration += 1;
    _status = RemoteConnectionStatus.connecting;
    _error = null;
    notify();

    try {
      final connection = await repository.connect(pairingCode);
      if (generation != _loadGeneration) return;
      final caches = restoreSessionCaches(connection.sessionId);
      _connection = connection;
      _adoptConnectionStatus(connection);
      _status = RemoteConnectionStatus.connected;
      _errorFromSessionEnded = false;
      final snapshot = await repository.fetchSnapshot();
      if (generation != _loadGeneration) return;
      await _sessionCachesLoaded(caches);
      if (generation != _loadGeneration) return;
      applySnapshot(snapshot);
      onSnapshotApplied(generation);
      _error = null;
      _startEventsAfterSnapshot(generation);
    } catch (e) {
      if (generation != _loadGeneration) return;
      _error = e;
      if (_connection == null) {
        clearSnapshot();
        _status = RemoteConnectionStatus.error;
        // A rejected code is the user's problem to fix, not something an
        // auto-probe should paper over.
        _errorFromSessionEnded = false;
      } else {
        // Pairing codes are one-shot. Once redemption succeeds, keep the
        // paired session and let the connected UI retry only the snapshot.
        _status = RemoteConnectionStatus.connected;
      }
    } finally {
      if (generation == _loadGeneration) {
        notify();
      }
    }
  }

  /// Tears down the pairing and returns to the disconnected state.
  ///
  /// The local state resets before the server teardown is awaited, so the
  /// pairing form shows on the next frame even when the end request stalls
  /// (CAN-4426). Nothing runs after that await, so a late teardown cannot
  /// clear a pairing made in the meantime.
  Future<void> disconnect() async {
    _abandonRestoreRetry();
    ++_loadGeneration;
    // The pairing is discarded now: its work must not land while the server
    // teardown is in flight.
    _sessionGeneration += 1;
    _stopEvents();
    // Starts the server teardown; the repository forgets the session at once.
    final teardown = repository.disconnect();
    _clearSessionState();
    _status = RemoteConnectionStatus.disconnected;
    _error = null;
    // A restore superseded above never clears its own pending flag.
    _restoring = false;
    notify();
    try {
      await teardown;
    } catch (_) {
      // Disconnect is best-effort; local state is already reset.
    }
  }

  /// Re-fetches the session snapshot under a new load generation.
  /// Fails without a read while disconnected.
  Future<RemoteSnapshotRefreshResult> refreshSnapshot() {
    if (!isConnected) {
      return Future.value((
        generation: _loadGeneration,
        outcome: RemoteSnapshotRefreshOutcome.failed,
      ));
    }
    final generation = ++_loadGeneration;
    final refresh = _performSnapshotRefresh(generation);
    _latestSnapshotRefresh = refresh;
    return refresh;
  }

  /// [refreshSnapshot], then follows each newer refresh that supersedes it
  /// while the pairing at [sessionGenerationAtStart] stays current, so the
  /// caller learns whether the latest read landed rather than that its own
  /// was overtaken.
  Future<RemoteSnapshotRefreshResult> settledSnapshotRefresh(
    int sessionGenerationAtStart,
  ) async {
    var result = await refreshSnapshot();
    while (result.outcome == RemoteSnapshotRefreshOutcome.superseded) {
      if (!isSessionCurrent(sessionGenerationAtStart)) break;
      final latestRefresh = _latestSnapshotRefresh;
      if (latestRefresh == null) break;
      final latestResult = await latestRefresh;
      if (latestResult.generation <= result.generation) break;
      result = latestResult;
    }
    return result;
  }

  /// Whether the pairing at [sessionGenerationAtStart] is still live.
  bool isSessionCurrent(int sessionGenerationAtStart) =>
      !isDisposed() &&
      isConnected &&
      _sessionGeneration == sessionGenerationAtStart;

  Future<RemoteSnapshotRefreshResult> _performSnapshotRefresh(
    int generation,
  ) async {
    final baseline = captureReadBaseline();
    try {
      final snapshot = await repository.fetchSnapshot();
      if (generation != _loadGeneration) {
        return (
          generation: generation,
          outcome: RemoteSnapshotRefreshOutcome.superseded,
        );
      }
      if (_awaitingFreshSnapshot) {
        _awaitingFreshSnapshot = false;
        _cancelFreshSnapshotRetry();
        discardMissedEventState();
      }
      applySnapshot(snapshot, baseline: baseline);
      onSnapshotApplied(generation);
      _error = null;
      // A cold connect/restore whose first snapshot failed deliberately keeps
      // events paused: without a seeded cursor, applying them would replay the
      // session from zero over an empty shell. A successful retry establishes
      // that base and can safely start delivery. Normal refreshes are a no-op
      // here because the repository already has an active subscription.
      _startEventsAfterSnapshot(generation);
      return (
        generation: generation,
        outcome: RemoteSnapshotRefreshOutcome.applied,
      );
    } catch (e) {
      if (generation != _loadGeneration) {
        return (
          generation: generation,
          outcome: RemoteSnapshotRefreshOutcome.superseded,
        );
      }
      _error = e;
      if (_awaitingFreshSnapshot) _scheduleFreshSnapshotRetry();
      return (
        generation: generation,
        outcome: RemoteSnapshotRefreshOutcome.failed,
      );
    } finally {
      if (generation == _loadGeneration) {
        notify();
      }
    }
  }

  /// Stops live event delivery while the app is backgrounded.
  void onAppBackgrounded() {
    _isAppBackgrounded = true;
    _cancelFreshSnapshotRetry();
    _backgroundedAt ??= _clock();
    _cancelRestoreRetry();
    _awaitingPostForegroundBatch = false;
    onBackgrounded();
    _releasePaintHold(paint: false);
    _resetLink();
    if (!isConnected) return;
    _eventsResumed = false;
    repository.pauseEvents();
  }

  /// Catches up missed activity and restarts live event delivery when the
  /// app returns to the foreground.
  Future<void> onAppForegrounded() async {
    _isAppBackgrounded = false;
    final backgroundedAt = _backgroundedAt;
    _backgroundedAt = null;
    // Returning to the app is a fresh request for the session; restart the
    // retry backoff rather than continuing a long one.
    _restoreRetryAttempt = 0;
    onForegrounded();
    if (!isConnected) {
      // CAN-2651: foregrounding while disconnected must be able to re-probe.
      // A session the server flagged stale during a sleep or a Wi-Fi drop is
      // revivable, and this is the moment the user is asking for it back.
      await restoreIfIdle();
      return;
    }
    if (hasSnapshot() &&
        (_awaitingFreshSnapshot ||
            (backgroundedAt != null &&
                _clock().difference(backgroundedAt) >=
                    kRemoteFreshResumeAfter))) {
      await _resumeFresh();
      return;
    }
    // A warm session already has a safe replay cursor. Resume it before slow
    // metadata/overview reads; cold sessions still require the initial seed.
    Object? foregroundRead;
    if (hasSnapshot()) {
      if (!_eventsResumed) {
        _awaitingPostForegroundBatch = true;
        if (canRefreshOnForeground()) {
          // The backlog replays from the old cursor while the overview read
          // is in flight. Paint once the read lands, so the sidebar jumps to
          // the current state instead of stepping through the backlog.
          foregroundRead = _foregroundRead = Object();
          _holdPaintsUntilCaughtUp();
        }
      }
      _startEvents();
    }
    try {
      await refreshConnectionMetadata();
      if (!isConnected) return;
      if (canRefreshOnForeground()) {
        await refresh();
      } else {
        scheduleRefresh();
      }
      if (isConnected && hasSnapshot()) _startEvents();
    } finally {
      if (foregroundRead != null &&
          identical(foregroundRead, _foregroundRead)) {
        _foregroundRead = null;
        if (!_replayDraining) _releasePaintHold();
      }
    }
  }

  /// Reloads the session the way a relaunch does: skips the events missed in
  /// the background instead of replaying them, re-reads the snapshot, and
  /// drops the state those events would have updated so open views reload
  /// it. Repaints hold until the read lands, so the screen moves once.
  Future<void> _resumeFresh() async {
    _awaitingFreshSnapshot = true;
    _eventsResumed = false;
    repository.discardEventCursor();
    _holdPaintsUntilCaughtUp();
    _freshSnapshotRetryAttempt = 0;
    _cancelFreshSnapshotRetry();
    _armLinkTimers();
    final read = refreshSnapshot();
    unawaited(refreshConnectionMetadata());
    await read;
    // A newer read may have applied in the meantime; paint whatever landed.
    if (!_isAppBackgrounded) _releasePaintHold();
  }

  /// This read unblocks event delivery, so it must not wait behind chat
  /// hydration that itself needs events. Reuse the session retry backoff.
  void _scheduleFreshSnapshotRetry() {
    if (_isAppBackgrounded || isDisposed() || !isConnected) return;
    _cancelFreshSnapshotRetry();
    final index = _freshSnapshotRetryAttempt.clamp(
      0,
      _restoreRetryDelays.length - 1,
    );
    _freshSnapshotRetryAttempt++;
    _freshSnapshotRetry = _timer(_restoreRetryDelays[index], () {
      _freshSnapshotRetry = null;
      if (!_awaitingFreshSnapshot ||
          _isAppBackgrounded ||
          isDisposed() ||
          !isConnected) {
        return;
      }
      unawaited(refreshSnapshot());
    });
  }

  void _cancelFreshSnapshotRetry() {
    _freshSnapshotRetry?.cancel();
    _freshSnapshotRetry = null;
  }

  /// Opens an event batch: the first full batch after a foreground holds
  /// repaints until the replay catches up.
  void beginEventBatch(RemotePortalEventBatch batch) {
    _markLinkLive();
    if (!_awaitingPostForegroundBatch) return;
    _awaitingPostForegroundBatch = false;
    if (batch.events.length == kRemotePortalEventBatchMaxCount) {
      _replayDraining = true;
      _holdPaintsUntilCaughtUp();
    }
  }

  /// Closes an event batch: a short batch means the replay caught up. A
  /// pending foreground read keeps holding; the read releases it.
  void endEventBatch(RemotePortalEventBatch batch) {
    if (batch.events.length < kRemotePortalEventBatchMaxCount) {
      _replayDraining = false;
      if (_foregroundRead == null) _releasePaintHold();
    }
  }

  /// Adopts the desktop liveness a batch reported; returns whether it
  /// changed. A degraded desktop re-reads the connection metadata.
  bool adoptPortalConnectionStatus(RemotePortalConnectionStatus? status) {
    if (status == null || status == _portalConnectionStatus) return false;
    final wasDegraded = isDegraded;
    _portalConnectionStatus = status;
    if (_isDegradedConnection(status)) {
      unawaited(refreshConnectionMetadata());
    } else if (wasDegraded && status == RemotePortalConnectionStatus.active) {
      onDeliveryRecovered();
    }
    return true;
  }

  /// Whether a post-unlock replay is holding repaints. A held repaint is
  /// recorded and painted once the hold releases.
  bool deferPaint() {
    if (_catchUpHold != null) {
      _paintHeld = true;
      return true;
    }
    _paintHeld = false;
    return false;
  }

  /// Replaying a full post-unlock batch paints once after the backlog drains,
  /// instead of once per server batch. An idle resume never starts the hold.
  void _holdPaintsUntilCaughtUp() {
    _catchUpHold ??= _timer(kRemoteEventCatchUpMaxHold, _releasePaintHold);
  }

  void _releasePaintHold({bool paint = true}) {
    _foregroundRead = null;
    _replayDraining = false;
    final hold = _catchUpHold;
    if (hold == null) return;
    hold.cancel();
    _catchUpHold = null;
    if (paint && _paintHeld) {
      _paintHeld = false;
      notify();
    }
  }

  void _startEvents() {
    if (_isAppBackgrounded || _awaitingFreshSnapshot) return;
    _eventsSubscription ??= repository.events.listen(onEventBatch);
    _eventsLiveSubscription ??= repository.eventsLive.listen(_onEventsLive);
    if (_eventsResumed) return;
    _eventsResumed = true;
    // Delivery is down until the new subscription answers.
    _armLinkTimers();
    repository.resumeEvents();
  }

  void _onEventsLive(bool live) {
    if (!_eventsResumed) return;
    if (live) {
      _markLinkLive();
    } else {
      _armLinkTimers();
    }
  }

  void _markLinkLive() {
    _cancelLinkTimers();
    final recovered = _linkState != RemoteLinkState.live;
    _setLinkState(RemoteLinkState.live);
    if (recovered) onDeliveryRecovered();
  }

  /// Starts the reconnecting grace, unless delivery is already known to be
  /// down or the grace is already running.
  void _armLinkTimers() {
    if (_linkState != RemoteLinkState.live || _linkGraceTimer != null) return;
    _linkGraceTimer = _timer(kRemoteReconnectingGrace, () {
      _linkGraceTimer = null;
      _setLinkState(RemoteLinkState.reconnecting);
    });
    _linkVerdictTimer = _timer(kRemoteUnreachableAfter, () {
      _linkVerdictTimer = null;
      _setLinkState(RemoteLinkState.unreachable);
    });
  }

  void _cancelLinkTimers() {
    _linkGraceTimer?.cancel();
    _linkGraceTimer = null;
    _linkVerdictTimer?.cancel();
    _linkVerdictTimer = null;
  }

  /// Delivery stopped on purpose; nothing is pending to report.
  void _resetLink() {
    _cancelLinkTimers();
    _setLinkState(RemoteLinkState.live);
  }

  void _setLinkState(RemoteLinkState state) {
    if (_linkState == state) return;
    _linkState = state;
    if (!isDisposed()) notify();
  }

  /// Starts live delivery only after a snapshot has seeded the event cursor, so
  /// the subscription resumes *after* the hydrated state instead of replaying
  /// the whole session history over it (regression B1/B2). A failed cold
  /// snapshot keeps delivery paused until a refresh succeeds; there is no
  /// trustworthy base state or cursor to apply events against before then. The
  /// generation guard drops a superseded connect/restore attempt.
  void _startEventsAfterSnapshot(int generation) {
    if (generation != _loadGeneration) return;
    if (_connection == null) return;
    _startEvents();
  }

  void _stopEvents() {
    _cancelFreshSnapshotRetry();
    // Session teardown paints its own state right after stopping events.
    _awaitingPostForegroundBatch = false;
    _releasePaintHold(paint: false);
    _cancelLinkTimers();
    _linkState = RemoteLinkState.live;
    _eventsResumed = false;
    repository.pauseEvents();
    onEventsStopped();
  }

  /// The desktop ended the session: tear it down into a re-probeable error.
  void handleRemoteSessionEnded() {
    ++_loadGeneration;
    _stopEvents();
    // Forget the ended session locally, so a later restore can adopt a newly
    // paired desktop instead of waiting on this one.
    repository.clearLocalSession();
    _resetSession();
    _status = RemoteConnectionStatus.error;
    // Server-side teardown, not a bad pairing code: a later foreground may
    // legitimately re-probe (the desktop can come back).
    _errorFromSessionEnded = true;
    _error = const RemoteControlException(
      'The desktop ended the Remote Control session.',
    );
    notify();
  }

  /// Re-reads the authoritative session after the desktop rejected a command
  /// with "no active remote control session", and reports whether the pairing
  /// is genuinely gone.
  ///
  /// That rejection is not the discriminator it looks like: the command route
  /// answers it for *any* persisted session whose status is not ACTIVE,
  /// including an `inactive` row that the next desktop heartbeat revives
  /// (CAN-2651). Treating the rejection itself as proof of an orphan threw
  /// away recoverable pairings after a laptop sleep or a Wi-Fi drop and forced
  /// a needless re-pair, so the rejection only starts the check and
  /// `GET .../session` decides — through
  /// [RemoteControlRepository.probeSession], which separates the server's own
  /// "no such session" from a read that never reached it or that answered
  /// about another desktop. Only the former is proof; the others keep the
  /// cached session, because the teardown this gates forces a re-pair, which
  /// needs the desktop.
  Future<bool> isRemoteSessionGone(int generation) async {
    final RemoteSessionProbe probe;
    try {
      probe = await repository.probeSession();
    } catch (_) {
      return false;
    }
    if (generation != _loadGeneration) return false;
    switch (probe.outcome) {
      case RemoteSessionProbeOutcome.unknown:
        // The server could not be asked, or answered about another desktop.
        // Dropping the pairing on this would force a re-pair, so keep the
        // cached session and try again later.
        return false;
      case RemoteSessionProbeOutcome.gone:
        return true;
      case RemoteSessionProbeOutcome.renderable:
        final session = probe.connection;
        if (session != null) {
          // Still recoverable. Adopt the freshly read metadata so the degraded
          // header stops reporting the heartbeat captured at connect time.
          _connection = session;
          _adoptConnectionStatus(session);
        }
        return false;
    }
  }

  /// Drops a pairing [isRemoteSessionGone] proved gone, on this phone only.
  ///
  /// CAN-3624: only the user's Disconnect ends a session on the server. The
  /// server already reported this one gone, so a later restore cannot
  /// reattach it: the auto-restore probe adopts only a renderable session.
  void handleRemoteSessionUnavailable() {
    ++_loadGeneration;
    _stopEvents();
    repository.clearLocalSession();
    _resetSession();
    _status = RemoteConnectionStatus.error;
    _errorFromSessionEnded = true;
    _error = const RemoteControlException(
      'The desktop is no longer connected. Connect it again to continue.',
    );
    notify();
  }

  /// Re-reads the paired desktop's metadata when the app foregrounds or the
  /// live connection degrades. Besides keeping the header's heartbeat current,
  /// this refreshes capabilities that an upgraded desktop may add to the
  /// existing Portal session. Event batches remain the authority on status;
  /// only connection metadata and repository capability gates are refreshed.
  Future<void> refreshConnectionMetadata() async {
    // Single-flight: a flapping desktop can change status several times per
    // batch window, and one heartbeat read per flip would be pure noise.
    if (_refreshingConnectionMetadata) return;
    final generation = _sessionGeneration;
    final connectionAtStart = _connection;
    if (connectionAtStart == null) return;
    _refreshingConnectionMetadata = true;
    final RemoteConnection? session;
    try {
      session = await repository.refreshSessionMetadata();
    } catch (_) {
      return;
    } finally {
      _refreshingConnectionMetadata = false;
    }
    if (session == null) return;
    if (!isSessionCurrent(generation) ||
        !identical(_connection, connectionAtStart)) {
      return;
    }
    _connection = session;
    notify();
  }

  void _resetSession() {
    _sessionGeneration += 1;
    _clearSessionState();
  }

  /// Drops the discarded pairing's metadata and every collaborator's state.
  void _clearSessionState() {
    _connection = null;
    _portalConnectionStatus = null;
    _awaitingFreshSnapshot = false;
    resetSession();
  }

  /// Invalidates in-flight work and stops live delivery for good.
  void dispose() {
    _cancelRestoreRetry();
    ++_loadGeneration;
    _stopEvents();
    unawaited(_eventsSubscription?.cancel());
    _eventsSubscription = null;
    unawaited(_eventsLiveSubscription?.cancel());
    _eventsLiveSubscription = null;
  }
}
