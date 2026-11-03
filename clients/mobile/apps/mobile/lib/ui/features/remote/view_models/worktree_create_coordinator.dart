import 'dart:async';

import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/portal_command_status.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'owned_command_registry.dart';
import 'remote_identity.dart';

/// How long an accepted worktree create keeps being reconciled before the
/// view model reports it as still pending, counted in foreground time. A
/// create runs a real `git worktree add` plus root validation on the
/// desktop, so it can far outlive the server's ~25s command-result wait;
/// two minutes covers the slow tail without holding a stuck create's UI open
/// forever.
const Duration kRemoteWorktreeCreateTimeout = Duration(minutes: 2);

/// Foreground time an accepted create waits for pushed updates before a
/// recovery round, and between rounds. Ready and failure events settle the
/// caller without waiting for this timer. Rounds read command status or
/// queue a desktop re-projection, so they stay rare (CAN-4875).
const Duration kRemoteWorktreeCreateRecoveryInterval = Duration(seconds: 30);

/// Most terminal deferred-create failures retained; see
/// [WorktreeCreateCoordinator.recordSetupFailure].
const int _kMaxWorktreeSetupFailures = 16;

/// Identity owned by the UI flow that initiated a non-idempotent worktree
/// create. Retaining the same instance lets that flow reconcile or claim its
/// result without allowing a later, unrelated create with identical options
/// to reuse the worktree.
final class RemoteWorktreeCreateAttempt {
  RemoteWorktreeCreateAttempt();
}

/// Where an in-flight worktree create stands, for progress copy. Exposed
/// while [WorktreeCreateCoordinator.isCreatingWorktree] holds; null otherwise.
enum RemoteWorktreeCreatePhase {
  /// Submitted; the desktop has not acknowledged the create yet.
  submitting,

  /// The desktop reserved the worktree (its id is known) and is running the
  /// background git setup that may still roll the reservation back.
  settingUp,

  /// Accepted, but the command has not reported its worktree id yet.
  awaitingDesktop,
}

/// An accepted worktree create awaiting reconciliation against snapshots.
final class PendingWorktreeCreate {
  const PendingWorktreeCreate({
    required this.attempt,
    required this.sessionGeneration,
    required this.workspaceLocalId,
    required this.baseWorktreeId,
    required this.forkOpenTabs,
    required this.commandId,
    required this.createdWorktreeId,
  });

  final RemoteWorktreeCreateAttempt attempt;

  /// The pairing the create was submitted under; see
  /// [WorktreeCreateCoordinator.sessionGeneration].
  final int sessionGeneration;
  final String workspaceLocalId;
  final String? baseWorktreeId;
  final bool forkOpenTabs;
  final String? commandId;
  final String? createdWorktreeId;

  PendingWorktreeCreate copyWith({String? createdWorktreeId}) =>
      PendingWorktreeCreate(
        attempt: attempt,
        sessionGeneration: sessionGeneration,
        workspaceLocalId: workspaceLocalId,
        baseWorktreeId: baseWorktreeId,
        forkOpenTabs: forkOpenTabs,
        commandId: commandId,
        createdWorktreeId: createdWorktreeId ?? this.createdWorktreeId,
      );
}

typedef _ReconciledWorktreeCreate = ({
  PendingWorktreeCreate pending,
  RemoteWorktree worktree,
});

final class _WorktreeCreateReconciliation {
  _WorktreeCreateReconciliation(
    this.pending, {
    required this.deadline,
    required this.recoverAt,
  });

  final PendingWorktreeCreate pending;
  final result = Completer<RemoteWorktree>();

  /// The foreground deadline and the next recovery round. Both move later
  /// by the time spent in the background.
  DateTime deadline;
  DateTime recoverAt;
  Timer? timer;
  Timer? deadlineTimer;
  Completer<void>? delay;

  /// Stops both timers and keeps any wait pending.
  void cancelTimers() {
    deadlineTimer?.cancel();
    deadlineTimer = null;
    timer?.cancel();
    timer = null;
  }

  void cancelDelay() {
    cancelTimers();
    final waiting = delay;
    delay = null;
    if (waiting != null && !waiting.isCompleted) waiting.complete();
  }
}

/// Submits worktree ("task") creates and reconciles each accepted create
/// until its worktree appears. Pushed updates settle it; a recovery round
/// runs only after they are overdue, and never in the background.
///
/// A create is non-idempotent on the desktop, so an attempt whose outcome is
/// unresolved stays pending across calls when its command or worktree id is
/// known. An attempt with neither id is released at the reconciliation deadline;
/// the caller must check the desktop before retrying to avoid a duplicate.
final class WorktreeCreateCoordinator {
  WorktreeCreateCoordinator({
    required this.repository,
    required this.commands,
    required this.notify,
    required this.isConnected,
    required this.isDisposed,
    required this.sessionGeneration,
    required this.worktreesFor,
    required this.refreshSnapshot,
    this.recoveryInterval = kRemoteWorktreeCreateRecoveryInterval,
    this.timeout = kRemoteWorktreeCreateTimeout,
    DateTime Function()? clock,
    RemoteTimerFactory? timer,
  }) : _clock = clock ?? DateTime.now,
       _timer = timer ?? Timer.new;

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final void Function() notify;
  final bool Function() isConnected;
  final bool Function() isDisposed;

  /// The current pairing; a create is bound to the one it started on.
  /// Metadata refreshes of the same pairing keep it, so they do not
  /// invalidate the create.
  final int Function() sessionGeneration;
  final List<RemoteWorktree> Function(String workspaceLocalId) worktreesFor;

  /// Re-reads the snapshot after a recovery projection, returning whether
  /// the read was applied. Pushed rows do not need this round trip.
  final Future<bool> Function() refreshSnapshot;

  /// See [kRemoteWorktreeCreateRecoveryInterval].
  final Duration recoveryInterval;

  /// See [kRemoteWorktreeCreateTimeout].
  final Duration timeout;

  final DateTime Function() _clock;
  final RemoteTimerFactory _timer;

  bool _creatingWorktree = false;
  RemoteWorktreeCreateAttempt? _creatingWorktreeAttempt;
  String? _creatingWorkspaceLocalId;
  PendingWorktreeCreate? _pendingWorktreeCreate;
  _WorktreeCreateReconciliation? _reconciliation;
  RemoteWorktreeCreateAttempt? _refreshingAttempt;
  final Map<RemoteWorktreeCreateAttempt, _ReconciledWorktreeCreate>
  _reconciledWorktreeCreates = {};

  /// Terminal deferred-create failures from `portal.state.delta`
  /// `worktreeSetupFailure` fields, insertion-ordered so overflow trims the
  /// oldest. The desktop rolls the reserved worktree back, so this is the only
  /// record of why a git-pending create disappeared.
  final Map<RemoteWorktreeKey, String> _worktreeSetupFailures = {};

  /// When the app went to the background; null in the foreground.
  DateTime? _backgroundedAt;

  /// True while a worktree create is in flight or its outcome still needs to
  /// be reconciled. The UI disables other create affordances against this: a
  /// create runs a real `git worktree add` on the desktop, so retrying an
  /// unresolved command could queue a duplicate.
  bool get isCreatingWorktree =>
      _creatingWorktree || _pendingWorktreeCreate != null;

  /// Workspace targeted by the in-flight or still-unresolved create, so the
  /// list can mark where the new task will appear. Null when no create is
  /// active or pending.
  String? get creatingWorktreeWorkspaceId =>
      _creatingWorkspaceLocalId ?? _pendingWorktreeCreate?.workspaceLocalId;

  /// True while an accepted create still lacks an authoritative worktree id.
  bool get isWorktreeCreateStillRunning => unidentifiedAttempt != null;

  /// The pending create's attempt while its worktree id is still unknown.
  /// A completion event or command-status response must supply the id.
  RemoteWorktreeCreateAttempt? get unidentifiedAttempt {
    final pending = _pendingWorktreeCreate;
    return pending != null && pending.createdWorktreeId == null
        ? pending.attempt
        : null;
  }

  /// Progress phase of the active create, or null when none is in flight.
  /// A completed-command echo that carried the id counts as the reservation
  /// being known even before the pending record absorbs it.
  RemoteWorktreeCreatePhase? get worktreeCreatePhase {
    final pending = _pendingWorktreeCreate;
    if (pending == null) {
      return _creatingWorktree ? RemoteWorktreeCreatePhase.submitting : null;
    }
    final commandId = pending.commandId;
    final echoedId = commandId == null
        ? null
        : commands.resultOf(commandId)?['id'];
    final hasId =
        pending.createdWorktreeId != null ||
        (echoedId is String && echoedId.isNotEmpty);
    return hasId
        ? RemoteWorktreeCreatePhase.settingUp
        : RemoteWorktreeCreatePhase.awaitingDesktop;
  }

  /// Records a deferred create's terminal setup failure for [worktree].
  void recordSetupFailure(RemoteWorktreeKey worktree, String error) {
    _worktreeSetupFailures[worktree] = error;
    while (_worktreeSetupFailures.length > _kMaxWorktreeSetupFailures) {
      _worktreeSetupFailures.remove(_worktreeSetupFailures.keys.first);
    }
    _settleReconciliation();
  }

  /// Creates a new worktree ("task") in [workspaceLocalId] and resolves to it
  /// once the desktop reports it in a fresh snapshot.
  ///
  /// [baseWorktreeId] branches from an existing worktree instead of the
  /// workspace default branch; [forkOpenTabs] additionally copies that
  /// worktree's open tabs. Retain and reuse [attempt] only when the same UI
  /// flow retries an accepted create whose result is still being reconciled.
  ///
  /// Throws [RemoteControlException] when the desktop rejects the create, or
  /// when the create was accepted but no worktree had appeared by the time the
  /// refreshed snapshot arrived. That second case means the create is still
  /// running, NOT that it failed — the message tells the user to refresh
  /// rather than retry, because resubmitting would create a duplicate.
  Future<RemoteWorktree> createWorktree({
    required String workspaceLocalId,
    String? baseWorktreeId,
    bool forkOpenTabs = false,
    RemoteWorktreeCreateAttempt? attempt,
  }) async {
    if (!isConnected()) {
      throw const RemoteControlException('Remote Control is disconnected.');
    }
    if (_creatingWorktree) {
      throw const RemoteControlException('A task is already being created.');
    }

    final createAttempt = attempt ?? RemoteWorktreeCreateAttempt();
    final reconciled = _reconciledWorktreeCreates[createAttempt];
    if (reconciled != null) {
      _ensureCreateSessionIsCurrent(reconciled.pending);
      final matchesReconciled =
          reconciled.pending.workspaceLocalId == workspaceLocalId &&
          reconciled.pending.baseWorktreeId == baseWorktreeId &&
          reconciled.pending.forkOpenTabs == forkOpenTabs;
      if (!matchesReconciled) {
        throw const RemoteControlException(
          'This task was already created with different project or branch '
          'options. Restore those selections to continue it.',
        );
      }
      _reconciledWorktreeCreates.remove(createAttempt);
      return reconciled.worktree;
    }

    final pending = _pendingWorktreeCreate;
    if (pending != null) {
      final matchesPending =
          identical(pending.attempt, createAttempt) &&
          pending.workspaceLocalId == workspaceLocalId &&
          pending.baseWorktreeId == baseWorktreeId &&
          pending.forkOpenTabs == forkOpenTabs;
      if (!matchesPending) {
        throw const RemoteControlException(
          'A previous task is still being created. Pull to refresh in a '
          'moment — creating another one could make a duplicate.',
        );
      }
      return _reconcilePendingWorktreeCreate(pending);
    }

    final sessionAtStart = sessionGeneration();
    _creatingWorktree = true;
    _creatingWorktreeAttempt = createAttempt;
    _creatingWorkspaceLocalId = workspaceLocalId;
    notify();
    try {
      // These ids help the desktop choose a branch name. They never identify
      // this create's result: only its command can supply that identity.
      final existingIds = [
        for (final worktree in worktreesFor(workspaceLocalId)) worktree.localId,
      ];
      RemoteWorktreeCreateResult? result;
      try {
        result = await repository.createWorktree(
          workspaceLocalId: workspaceLocalId,
          existingWorktreeIds: existingIds,
          baseWorktreeId: baseWorktreeId,
          forkOpenTabs: forkOpenTabs,
        );
      } on RemoteWorktreeCreateOutcomeUnknownException {
        // The request may have committed before its response was lost. Treat
        // that the same as an accepted pending create and reconcile below.
      }
      // Checked before registering: a discarded pairing's command must not
      // join the current pairing's command state.
      if (!_isSessionCurrent(sessionAtStart)) {
        throw const RemoteControlException(
          'The Remote Control session changed while this task was being '
          'created. Refresh the current session before retrying.',
        );
      }
      final commandId = switch (result?.commandId) {
        null || '' => null,
        final id => commands.register(
          id,
          throwIfFailed: true,
          onCompleted: (_) => _worktreeCreateCompleted(id),
          onFailed: (_) => _worktreeCreateFailed(id),
        ),
      };
      final createdWorktreeId = result?.worktreeLocalId;
      final create = PendingWorktreeCreate(
        attempt: createAttempt,
        sessionGeneration: sessionAtStart,
        workspaceLocalId: workspaceLocalId,
        baseWorktreeId: baseWorktreeId,
        forkOpenTabs: forkOpenTabs,
        commandId: commandId,
        createdWorktreeId: createdWorktreeId,
      );
      _pendingWorktreeCreate = create;
      // The phase just moved from submitting to reserved/awaiting; let
      // progress copy update before the first reconcile round lands.
      notify();
      return await _reconcileWorktreeCreate(create, recoverNow: false);
    } finally {
      if (identical(_creatingWorktreeAttempt, createAttempt)) {
        _creatingWorktree = false;
        _creatingWorktreeAttempt = null;
        _creatingWorkspaceLocalId = null;
        notify();
      }
    }
  }

  /// Claims only the row identified by this create's command. Another
  /// client's newly appearing worktree must never take this flow's message.
  void reconcileSnapshot() {
    final original = _pendingWorktreeCreate;
    final pendingCreate = original == null
        ? null
        : _upgradedPendingCreate(original);
    if (pendingCreate == null) return;
    final match = _findCreatedWorktree(pendingCreate);
    if (match.created case final created?) {
      // The create call may already have timed out. Preserve the resolved
      // result until that originating flow retries and claims it, otherwise
      // the retry would submit another non-idempotent git worktree create.
      _reconciledWorktreeCreates[pendingCreate.attempt] = (
        pending: pendingCreate,
        worktree: created,
      );
      _pendingWorktreeCreate = null;
      _settleReconciliation();
    }
  }

  bool _isSessionCurrent(int sessionAtStart) =>
      !isDisposed() && isConnected() && sessionGeneration() == sessionAtStart;

  Future<RemoteWorktree> _reconcilePendingWorktreeCreate(
    PendingWorktreeCreate pending,
  ) async {
    _creatingWorktree = true;
    _creatingWorktreeAttempt = pending.attempt;
    notify();
    try {
      // The user asked again, so check with the desktop at once.
      return await _reconcileWorktreeCreate(pending, recoverNow: true);
    } finally {
      if (identical(_creatingWorktreeAttempt, pending.attempt)) {
        _creatingWorktree = false;
        _creatingWorktreeAttempt = null;
        notify();
      }
    }
  }

  /// Follows pushed ready/failure updates, using bounded recovery reads
  /// when delivery is missed. Identifiable outcomes stay pending across retries.
  /// The first round waits [recoveryInterval] unless [recoverNow].
  Future<RemoteWorktree> _reconcileWorktreeCreate(
    PendingWorktreeCreate pending, {
    required bool recoverNow,
  }) async {
    final now = _foregroundNow;
    final reconciliation = _WorktreeCreateReconciliation(
      pending,
      deadline: now.add(timeout),
      recoverAt: recoverNow || timeout <= Duration.zero
          ? now
          : now.add(recoveryInterval),
    );
    _reconciliation = reconciliation;
    _armDeadline(reconciliation);
    // Attach the result listener before a buffered terminal can settle it.
    final result = reconciliation.result.future;
    unawaited(
      _recoverWorktreeCreate(reconciliation).then(
        (_) {},
        onError: (Object error, StackTrace stack) {
          if (!reconciliation.result.isCompleted) {
            reconciliation.result.completeError(error, stack);
          }
        },
      ),
    );
    try {
      final created = await result;
      _ensureCreateSessionIsCurrent(pending);
      _reconciledWorktreeCreates.remove(pending.attempt);
      return created;
    } finally {
      reconciliation.cancelDelay();
      if (identical(_reconciliation, reconciliation)) _reconciliation = null;
    }
  }

  /// Pushed rows and terminal events can settle a create while recovery I/O
  /// is still in flight. The I/O may finish later, but cannot settle a new
  /// create or schedule another round for the old one.
  void _settleReconciliation() {
    final active = _reconciliation;
    if (active == null || active.result.isCompleted) return;
    final pending = active.pending;
    if (!_isSessionCurrent(pending.sessionGeneration)) return;
    final commandId = pending.commandId;
    final failure = commandId == null
        ? null
        : commands.failureMessageFor(commandId);
    final current = _upgradedPendingCreate(pending);
    final createdId = current.createdWorktreeId;
    final setupKey = createdId == null
        ? null
        : remoteWorktreeKey(current.workspaceLocalId, createdId);
    final setupFailure = setupKey == null
        ? null
        : _worktreeSetupFailures[setupKey];
    final error = failure ?? setupFailure;
    if (error != null) {
      if (setupKey != null) _worktreeSetupFailures.remove(setupKey);
      if (identical(_pendingWorktreeCreate?.attempt, pending.attempt)) {
        _pendingWorktreeCreate = null;
      }
      active.result.completeError(RemoteControlException(error));
      return;
    }
    final cached = _reconciledWorktreeCreates[pending.attempt];
    final created =
        cached?.worktree ??
        (createdId == null ? null : _findCreatedWorktree(current).created);
    if (created == null) return;
    if (identical(_pendingWorktreeCreate?.attempt, pending.attempt)) {
      _pendingWorktreeCreate = null;
    }
    active.result.complete(created);
  }

  Future<void> _recoverWorktreeCreate(
    _WorktreeCreateReconciliation reconciliation,
  ) async {
    final pending = reconciliation.pending;
    _settleReconciliation();
    if (reconciliation.result.isCompleted) return;
    if (_backgroundedAt != null ||
        _clock().isBefore(reconciliation.recoverAt)) {
      await _delayRound(reconciliation);
    }
    while (!reconciliation.result.isCompleted) {
      _ensureCreateSessionIsCurrent(pending);
      var current = _upgradedPendingCreate(pending);
      final commandId = current.commandId;
      if (current.createdWorktreeId == null && commandId != null) {
        await _recoverCommandStatus(current, reconciliation: reconciliation);
        if (reconciliation.result.isCompleted) return;
        current = _upgradedPendingCreate(pending);
      }
      if (current.createdWorktreeId != null && _backgroundedAt == null) {
        try {
          await repository.requestOverviewState();
        } catch (_) {
          // The reservation may already exist; recovery is best effort.
        }
        if (reconciliation.result.isCompleted) return;
        _ensureCreateSessionIsCurrent(pending);
        // The app left during the request. Reading now would run in the
        // background; the return's own refresh reads the snapshot instead.
        if (_backgroundedAt == null) {
          await refreshSnapshot();
          if (reconciliation.result.isCompleted) return;
          _ensureCreateSessionIsCurrent(pending);
          reconcileSnapshot();
          _settleReconciliation();
          if (reconciliation.result.isCompleted) return;
        }
      }
      if (!_foregroundNow.isBefore(reconciliation.deadline)) {
        _expireReconciliation(reconciliation);
        return;
      }
      reconciliation.recoverAt = _foregroundNow.add(recoveryInterval);
      await _delayRound(reconciliation);
    }
  }

  void _expireReconciliation(_WorktreeCreateReconciliation active) {
    if (active.result.isCompleted) return;
    final pending = _upgradedPendingCreate(active.pending);
    if (pending.commandId == null &&
        pending.createdWorktreeId == null &&
        _isSessionCurrent(pending.sessionGeneration) &&
        identical(_pendingWorktreeCreate?.attempt, active.pending.attempt)) {
      // Neither status reads nor pushed rows can identify this request. Stop
      // blocking future creates, but never guess its result from another row.
      _pendingWorktreeCreate = null;
    }
    active.result.completeError(_pendingError(pending));
  }

  RemoteControlException _pendingError(PendingWorktreeCreate pending) =>
      pending.commandId == null
      ? const RemoteControlException(
          "We couldn't confirm whether this task was created. Check your desktop "
          'before trying again to avoid creating a duplicate.',
        )
      : const RemoteControlException(
          'The task is still being created on your desktop and will appear '
          'once it finishes — creating it again would make a duplicate.',
        );

  /// The clock with the background time left out: while backgrounded, it
  /// stays at the moment the app left.
  DateTime get _foregroundNow => _backgroundedAt ?? _clock();

  Duration _untilForeground(DateTime at) {
    final delay = at.difference(_clock());
    return delay.isNegative ? Duration.zero : delay;
  }

  /// Waits for [reconciliation]'s next round. Its timer runs only in the
  /// foreground; a return re-arms it.
  Future<void> _delayRound(_WorktreeCreateReconciliation reconciliation) {
    final elapsed = Completer<void>();
    reconciliation.delay = elapsed;
    _armRound(reconciliation);
    return elapsed.future;
  }

  void _armRound(_WorktreeCreateReconciliation reconciliation) {
    reconciliation.timer?.cancel();
    reconciliation.timer = null;
    final elapsed = reconciliation.delay;
    if (elapsed == null || elapsed.isCompleted || _backgroundedAt != null) {
      return;
    }
    reconciliation.timer = _timer(
      _untilForeground(reconciliation.recoverAt),
      () {
        if (identical(reconciliation.delay, elapsed)) {
          reconciliation.delay = null;
        }
        if (!elapsed.isCompleted) elapsed.complete();
      },
    );
  }

  void _armDeadline(_WorktreeCreateReconciliation reconciliation) {
    reconciliation.deadlineTimer?.cancel();
    reconciliation.deadlineTimer = null;
    if (timeout <= Duration.zero || _backgroundedAt != null) return;
    reconciliation.deadlineTimer = _timer(
      _untilForeground(reconciliation.deadline),
      () => _expireReconciliation(reconciliation),
    );
  }

  /// Stops recovery rounds and the deadline while the app is in the
  /// background.
  void pauseReconciliation() {
    _backgroundedAt ??= _clock();
    _reconciliation?.cancelTimers();
  }

  /// Resumes after the background, which counts toward neither the wait nor
  /// the recovery cadence.
  void resumeReconciliation() {
    final since = _backgroundedAt;
    _backgroundedAt = null;
    final active = _reconciliation;
    if (active == null || active.result.isCompleted) return;
    if (since != null) {
      final away = _clock().difference(since);
      active
        ..deadline = active.deadline.add(away)
        ..recoverAt = active.recoverAt.add(away);
    }
    _armDeadline(active);
    _armRound(active);
  }

  /// A fresh resume skipped the events that may have settled the create, so
  /// the active reconciliation checks with the desktop at once.
  void reconcileAfterSkippedEvents() {
    final active = _reconciliation;
    if (active == null || active.result.isCompleted) return;
    active.recoverAt = _foregroundNow;
    _armRound(active);
  }

  /// A pull-to-refresh can recover an accepted command after its original
  /// waiter expired. This reads status once and never submits the create again.
  Future<void> recoverPendingCreate() async {
    final pending = _pendingWorktreeCreate;
    if (pending == null ||
        pending.commandId == null ||
        pending.createdWorktreeId != null ||
        _creatingWorktree ||
        _reconciliation != null ||
        _refreshingAttempt != null ||
        !_isSessionCurrent(pending.sessionGeneration)) {
      return;
    }
    _refreshingAttempt = pending.attempt;
    try {
      await _recoverCommandStatus(pending);
    } finally {
      if (identical(_refreshingAttempt, pending.attempt)) {
        _refreshingAttempt = null;
      }
    }
  }

  Future<void> _recoverCommandStatus(
    PendingWorktreeCreate pending, {
    _WorktreeCreateReconciliation? reconciliation,
  }) async {
    final commandId = pending.commandId;
    if (commandId == null) return;
    try {
      final status = await repository.projects.commandStatus(commandId);
      if (reconciliation?.result.isCompleted == true ||
          !_isSessionCurrent(pending.sessionGeneration) ||
          !identical(_pendingWorktreeCreate?.attempt, pending.attempt) ||
          status.commandId != commandId) {
        return;
      }
      switch (status.status) {
        case BrowserPortalCommandStatus.completed:
          final createdId = status.result?['id'];
          if (createdId is String && createdId.isNotEmpty) {
            _pendingWorktreeCreate = _upgradedPendingCreate(
              pending,
            ).copyWith(createdWorktreeId: createdId);
            reconcileSnapshot();
            _settleReconciliation();
            notify();
          }
        case BrowserPortalCommandStatus.failed:
          _failPendingCreate(
            pending,
            status.error ?? 'The desktop did not accept the request.',
          );
        case BrowserPortalCommandStatus.expired:
          if (status.delivered == false) {
            _failPendingCreate(
              pending,
              status.error ?? 'The desktop did not accept the request.',
            );
          }
        case BrowserPortalCommandStatus.queued:
        case BrowserPortalCommandStatus.delivered:
          break;
      }
    } catch (_) {
      // A failed status read proves nothing about a non-idempotent create.
    }
  }

  void _failPendingCreate(PendingWorktreeCreate pending, String message) {
    if (!identical(_pendingWorktreeCreate?.attempt, pending.attempt)) return;
    _pendingWorktreeCreate = null;
    final active = _reconciliation;
    if (active != null &&
        identical(active.pending.attempt, pending.attempt) &&
        !active.result.isCompleted) {
      active.result.completeError(RemoteControlException(message));
    }
    notify();
  }

  /// Throws when [pending]'s pairing is gone, after dropping its pending
  /// record and any result reconciled for it: neither may bind to a later
  /// pairing.
  void _ensureCreateSessionIsCurrent(PendingWorktreeCreate pending) {
    if (_isSessionCurrent(pending.sessionGeneration)) return;
    if (identical(_pendingWorktreeCreate?.attempt, pending.attempt)) {
      _pendingWorktreeCreate = null;
    }
    _reconciledWorktreeCreates.remove(pending.attempt);
    throw const RemoteControlException(
      'The Remote Control session changed while this task was being created. '
      'Refresh the current session before retrying.',
    );
  }

  /// The freshest view of [pending]: prefers the live field (which absorbs
  /// completed-event id upgrades), then folds in a buffered
  /// `portal.command.completed` result that may have arrived before the
  /// pending record was installed.
  PendingWorktreeCreate _upgradedPendingCreate(PendingWorktreeCreate pending) {
    var current = _pendingWorktreeCreate ?? pending;
    final commandId = current.commandId;
    if (current.createdWorktreeId == null && commandId != null) {
      final completedId = commands.resultOf(commandId)?['id'];
      if (completedId is String && completedId.isNotEmpty) {
        current = current.copyWith(createdWorktreeId: completedId);
        if (_pendingWorktreeCreate != null) _pendingWorktreeCreate = current;
      }
    }
    return current;
  }

  /// Folds the authoritative created-worktree id into the pending record so
  /// the reconcile loop (and the still-running banner) switch to id-based
  /// resolution immediately.
  void _worktreeCreateCompleted(String commandId) {
    final pending = _pendingWorktreeCreate;
    if (pending != null && pending.commandId == commandId) {
      _upgradedPendingCreate(pending);
    }
    _settleReconciliation();
  }

  void _worktreeCreateFailed(String commandId) {
    _settleReconciliation();
    if (_pendingWorktreeCreate?.commandId == commandId) {
      _pendingWorktreeCreate = null;
    }
  }

  /// Only an authoritative id from the create response, completion event,
  /// or command-status read can select a row. A list diff is never evidence.
  ({RemoteWorktree? created}) _findCreatedWorktree(
    PendingWorktreeCreate pending,
  ) {
    final id = pending.createdWorktreeId;
    if (id == null) return (created: null);
    for (final worktree in worktreesFor(pending.workspaceLocalId)) {
      if (worktree.localId == id &&
          worktree.workspaceLocalId == pending.workspaceLocalId &&
          worktree.setupPhase != RemoteWorktreeSetupPhase.gitPending) {
        return (created: worktree);
      }
    }
    return (created: null);
  }

  /// Drops every create of the discarded session. An in-flight create finds
  /// its session gone at its next check and fails without a retry path.
  void reset() {
    final active = _reconciliation;
    if (active != null && !active.result.isCompleted) {
      active.result.completeError(
        const RemoteControlException(
          'The Remote Control session changed while this task was being created. '
          'Refresh the current session before retrying.',
        ),
      );
      active.cancelDelay();
    }
    _creatingWorktree = false;
    _creatingWorktreeAttempt = null;
    _creatingWorkspaceLocalId = null;
    _pendingWorktreeCreate = null;
    _refreshingAttempt = null;
    _reconciledWorktreeCreates.clear();
    _worktreeSetupFailures.clear();
  }

  void dispose() => reset();
}
