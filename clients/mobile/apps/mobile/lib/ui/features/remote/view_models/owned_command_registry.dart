import 'dart:async';

import 'package:mobile/data/repositories/remote_control_repository.dart';

/// Newest completed-command results retained for [OwnedCommandRegistry]
/// queries. Callers read a result back only across the submit→event race (the
/// pending-create id upgrade, composer reconciliation), so the ring just needs
/// to outlive that race, not the session.
const int kMaxCompletedCommandResults = 32;

/// Newest terminal events whose command submission response has not arrived
/// yet. Portal events are shared by every client attached to the desktop
/// session, so an unknown id is not a Mobile failure unless a later submit
/// response claims it. Bounding the buffer prevents foreign client traffic
/// from accumulating for the lifetime of the pairing.
const int kMaxUnclaimedCommandTerminals = 32;

/// Reacts to the desktop's `portal.command.completed` for an owned command.
typedef OwnedCommandCompleted = void Function(Map<String, dynamic>? result);

/// Reacts to the desktop's `portal.command.failed` for an owned command.
typedef OwnedCommandFailed = void Function(String message);

typedef _OwnedCommand = ({
  OwnedCommandCompleted? onCompleted,
  OwnedCommandFailed? onFailed,
  bool recordOutcome,
});

/// A terminal event observed before its submission response claimed the id.
/// A non-null [failure] marks a failed command.
typedef _UnclaimedTerminal = ({
  String? failure,
  Map<String, dynamic>? result,
  int projectionSequence,
});

/// The commands this Mobile client submitted on the shared portal session,
/// and the handler each one registered for its terminal event.
///
/// Terminal events for ids no one registered are foreign (another client's
/// commands) and never reach a handler or the failure banner. They are held
/// only in a bounded buffer so a submit response that arrives after its own
/// terminal event can still claim it.
///
/// The registry keeps the outcome bookkeeping every feature shares: completed
/// results, failure messages, and the latest failure for the banner. Feature
/// reactions live in the handlers the features register.
final class OwnedCommandRegistry {
  OwnedCommandRegistry({
    required this.notify,
    this.maxUnclaimedTerminals = kMaxUnclaimedCommandTerminals,
    this.maxCompletedResults = kMaxCompletedCommandResults,
  });

  /// Called when claiming a buffered terminal changes recorded state. Event
  /// delivery reports changes through [handleCompleted] / [handleFailed]
  /// instead, so a whole batch notifies once.
  final void Function() notify;
  final int maxUnclaimedTerminals;
  final int maxCompletedResults;

  final Map<String, _OwnedCommand> _owned = {};
  final Map<String, _UnclaimedTerminal> _unclaimed = {};

  /// Insertion-ordered so overflow trims the oldest.
  final Map<String, Map<String, dynamic>?> _completedResults = {};
  final Map<String, int> _completedProjectionSequences = {};
  final Map<String, String> _failedMessages = {};
  final Map<String, Completer<Map<String, dynamic>?>> _waiters = {};
  String? _failureMessage;

  /// Latest asynchronous failure of a recorded command, retained until
  /// cleared.
  String? get failureMessage => _failureMessage;

  /// Clears [failureMessage]; returns whether there was one.
  bool clearFailureMessage() {
    if (_failureMessage == null) return false;
    _failureMessage = null;
    return true;
  }

  /// Whether the desktop rejected [commandId]. Retained for the session.
  bool hasFailed(String? commandId) =>
      commandId != null && _failedMessages.containsKey(commandId);

  /// The desktop's rejection message for [commandId], if it failed.
  String? failureMessageFor(String commandId) => _failedMessages[commandId];

  /// Whether the desktop reported terminal success for [commandId]. Only the
  /// newest [maxCompletedResults] completions are remembered.
  bool hasCompleted(String? commandId) =>
      commandId != null && _completedResults.containsKey(commandId);

  /// The completion result of [commandId]; null when it has not completed or
  /// completed without a result.
  Map<String, dynamic>? resultOf(String commandId) =>
      _completedResults[commandId];

  /// The caller's projection sequence when [commandId]'s completion was
  /// observed, or null when it has not completed.
  int? completedProjectionSequence(String commandId) =>
      _completedProjectionSequences[commandId];

  /// Submits a command and [register]s the returned id.
  Future<String> submit(
    Future<String> Function() submit, {
    OwnedCommandCompleted? onCompleted,
    OwnedCommandFailed? onFailed,
    bool throwIfFailed = false,
  }) async => register(
    await submit(),
    onCompleted: onCompleted,
    onFailed: onFailed,
    throwIfFailed: throwIfFailed,
  );

  /// Claims [commandId] as submitted by this client and attaches its
  /// handlers, replacing any registered earlier for the same id. An empty id
  /// is returned unregistered.
  ///
  /// If the terminal event raced ahead of the submit response, it is applied
  /// now. With [throwIfFailed], a failure that already arrived is rethrown as
  /// a [RemoteControlException].
  ///
  /// With [recordOutcome] false the command is internal: its terminal runs
  /// only the handler, and is not recorded as a result or failure nor shown
  /// in [failureMessage].
  String register(
    String commandId, {
    OwnedCommandCompleted? onCompleted,
    OwnedCommandFailed? onFailed,
    bool recordOutcome = true,
    bool throwIfFailed = false,
  }) {
    if (commandId.isEmpty) return commandId;
    final command = (
      onCompleted: onCompleted,
      onFailed: onFailed,
      recordOutcome: recordOutcome,
    );
    final terminal = _unclaimed.remove(commandId);
    if (terminal == null) {
      _owned[commandId] = command;
    } else {
      final failure = terminal.failure;
      final changed = failure != null
          ? _fail(commandId, command, failure)
          : _complete(
              commandId,
              command,
              terminal.result,
              terminal.projectionSequence,
            );
      if (changed) notify();
    }
    if (throwIfFailed) {
      final failure = _failedMessages[commandId];
      if (failure != null) throw RemoteControlException(failure);
    }
    return commandId;
  }

  /// Stops tracking [commandId] without an outcome. A later terminal event
  /// for it is treated as foreign.
  void release(String commandId) => _owned.remove(commandId);

  /// Routes a `portal.command.completed` event. Returns whether recorded
  /// state changed. [projectionSequence] is recorded with the result, or
  /// buffered with it when no registration has claimed the id yet.
  bool handleCompleted(
    String commandId,
    Map<String, dynamic>? result, {
    required int projectionSequence,
  }) {
    if (commandId.isEmpty) return false;
    final command = _owned.remove(commandId);
    if (command == null) {
      _buffer(commandId, (
        failure: null,
        result: result,
        projectionSequence: projectionSequence,
      ));
      return false;
    }
    return _complete(commandId, command, result, projectionSequence);
  }

  /// Routes a `portal.command.failed` event. Returns whether recorded state
  /// changed.
  bool handleFailed(
    String commandId,
    String message, {
    required int projectionSequence,
  }) {
    if (commandId.isEmpty) return false;
    final command = _owned.remove(commandId);
    if (command == null) {
      _buffer(commandId, (
        failure: message,
        result: null,
        projectionSequence: projectionSequence,
      ));
      return false;
    }
    return _fail(commandId, command, message);
  }

  /// Resolves with [commandId]'s completion result, or fails with a
  /// [RemoteControlException] carrying its failure message. Throws a
  /// [TimeoutException] when no terminal arrives within [timeout]. Callers
  /// check [hasCompleted] / [hasFailed] first: an earlier terminal is not
  /// replayed.
  Future<Map<String, dynamic>?> waitForResult(
    String commandId, {
    required Duration timeout,
  }) {
    final completer = Completer<Map<String, dynamic>?>();
    _waiters[commandId] = completer;
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        if (identical(_waiters[commandId], completer)) {
          _waiters.remove(commandId);
        }
        throw TimeoutException(null, timeout);
      },
    );
  }

  bool _complete(
    String commandId,
    _OwnedCommand command,
    Map<String, dynamic>? result,
    int projectionSequence,
  ) {
    _waiters.remove(commandId)?.complete(result);
    if (!command.recordOutcome) {
      command.onCompleted?.call(result);
      return false;
    }
    _completedResults[commandId] = result;
    _completedProjectionSequences[commandId] = projectionSequence;
    while (_completedResults.length > maxCompletedResults) {
      final oldest = _completedResults.keys.first;
      _completedResults.remove(oldest);
      _completedProjectionSequences.remove(oldest);
    }
    command.onCompleted?.call(result);
    return true;
  }

  bool _fail(String commandId, _OwnedCommand command, String message) {
    _waiters.remove(commandId)?.completeError(RemoteControlException(message));
    if (!command.recordOutcome) {
      command.onFailed?.call(message);
      return false;
    }
    _failureMessage = message;
    _failedMessages[commandId] = message;
    command.onFailed?.call(message);
    return true;
  }

  void _buffer(String commandId, _UnclaimedTerminal terminal) {
    // Re-insertion makes the map's oldest entry the least recently observed.
    _unclaimed.remove(commandId);
    _unclaimed[commandId] = terminal;
    while (_unclaimed.length > maxUnclaimedTerminals) {
      _unclaimed.remove(_unclaimed.keys.first);
    }
  }

  /// The skipped event window may contain any pending command's outcome.
  /// Settle callers without claiming that the desktop rejected the action.
  /// Keep ownership so status polling and later terminal events can still
  /// reconcile work the desktop may be running. Failure handlers run only
  /// when the desktop reports a rejection.
  void invalidateAfterSkippedEvents() {
    const message =
        'Could not confirm the result. Refresh to check its status.';
    final waiters = List.of(_waiters.values);
    _waiters.clear();
    _unclaimed.clear();
    for (final waiter in waiters) {
      if (!waiter.isCompleted) {
        waiter.completeError(const RemoteControlException(message));
      }
    }
  }

  /// Forgets every command for a discarded session. Pending waits fail as
  /// disconnected.
  void reset() {
    for (final waiter in _waiters.values) {
      if (!waiter.isCompleted) {
        waiter.completeError(
          const RemoteControlException('Remote Control is disconnected.'),
        );
      }
    }
    _clear();
  }

  /// Drops every handler. Pending waits are left to their own timeouts, so
  /// callers still suspended when the owner is disposed resume as before.
  void dispose() => _clear();

  void _clear() {
    _waiters.clear();
    _owned.clear();
    _unclaimed.clear();
    _completedResults.clear();
    _completedProjectionSequences.clear();
    _failedMessages.clear();
    _failureMessage = null;
  }
}
