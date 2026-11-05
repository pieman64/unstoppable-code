import 'dart:async';

import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'owned_command_registry.dart';
import 'pipeline_run_status.dart';

/// Watchdog for a pipeline detail or log request with no desktop answer.
const Duration kRemotePipelineRunTimeout = Duration(seconds: 10);

/// Watchdog for a cancel, resume, or retry with no desktop answer.
const Duration kRemotePipelineActionTimeout = Duration(seconds: 30);

/// Session-scoped pipeline runs and the commands used to inspect or control them.
final class PipelineRunTracker {
  PipelineRunTracker({
    required this.repository,
    required this.commands,
    required this.activityFor,
    required this.isConnected,
    required this.notify,
    this.runTimeout = kRemotePipelineRunTimeout,
    this.actionTimeout = kRemotePipelineActionTimeout,
    this.timer = Timer.new,
  });

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final RemoteWorktreeActivity Function(String) activityFor;
  final bool Function() isConnected;
  final void Function() notify;
  final Duration runTimeout;
  final Duration actionTimeout;
  final Timer Function(Duration, void Function()) timer;

  /// Runs learned from `portal.pipeline.event`, keyed by execution id.
  /// Overlaid on the worktree slice rows, which are only as fresh as the
  /// last scoped `/state` read.
  final Map<String, RemotePipelineRun> _pipelineRunUpdates = {};

  /// Detail/log requests awaiting the desktop's answering event, keyed by
  /// execution id, with the watchdog that settles a silent desktop.
  final Map<String, Timer> _pipelineRunWatchdogs = {};
  final Map<String, ({Future<String> Function() submit, Object token})>
  _pendingReads = {};

  /// Command id -> execution id, so an asynchronous rejection settles the
  /// request that caused it.
  final Map<String, String> _pipelineCommandExecutions = {};
  final Map<String, String> _pipelineRunErrors = {};

  /// In-flight run controls, keyed by execution id, with the watchdog that
  /// re-offers the control when the desktop stays silent, and the command id
  /// -> execution id map that settles them. Kept apart from the detail/log
  /// request state above: a control's outcome must not show the run screen's
  /// loading spinner, and its failure is not a failure to load the run.
  final Map<String, RemotePipelineRunAction> _pipelineActionsPending = {};
  final Map<String, Timer> _pipelineActionWatchdogs = {};
  final Map<String, String> _pipelineActionCommands = {};
  final Map<String, String> _pipelineActionErrors = {};

  /// The worktree's visible pipeline runs, newest first: the scoped-read
  /// rows with every live update folded in, minus the child runs the desktop
  /// groups away from its own activity list.
  List<RemotePipelineRun> pipelineRunsFor(String worktreeLocalId) {
    final merged = <String, RemotePipelineRun>{};
    for (final run in activityFor(worktreeLocalId).pipelineRuns) {
      merged[run.localId] = run;
    }
    for (final entry in _pipelineRunUpdates.entries) {
      final incoming = entry.value;
      final existing = merged[entry.key];
      // An update for a run this worktree has never seen only belongs here
      // when the wire says so; a row with no scope claims nothing.
      if (existing == null && incoming.worktreeLocalId != worktreeLocalId) {
        continue;
      }
      merged[entry.key] = existing == null
          ? incoming
          : existing.mergeWith(incoming);
    }
    final rows = [
      for (final run in merged.values)
        if (!run.hidden) run,
    ];
    rows.sort(comparePipelineRunRecency);
    return List.unmodifiable(rows);
  }

  /// One run by execution id. Falls back to the live cache so a hidden child
  /// run stays readable if something ever links to it directly.
  RemotePipelineRun? pipelineRunFor({
    required String worktreeLocalId,
    required String executionId,
  }) {
    for (final run in pipelineRunsFor(worktreeLocalId)) {
      if (run.localId == executionId) return run;
    }
    return _pipelineRunUpdates[executionId];
  }

  void applyPipelineRun(RemotePipelineRun run) {
    final existing = _pipelineRunUpdates[run.localId];
    final merged = existing == null ? run : existing.mergeWith(run);
    _pipelineRunUpdates[run.localId] = merged;
    // The desktop's own run update is authoritative: once it says the run
    // stopped, a cancel still waiting on its command result is done, even
    // when that result has not arrived (or its id is not registered yet).
    if (_pipelineActionsPending[run.localId] ==
            RemotePipelineRunAction.cancel &&
        merged.status.isNotEmpty &&
        !isPipelineRunActive(merged.status)) {
      _settlePipelineAction(run.localId);
    }
  }

  /// True while a detail or log request for [executionId] is still waiting
  /// for the desktop's answer.
  bool isPipelineRunPending(String executionId) =>
      _pipelineRunWatchdogs.containsKey(executionId);

  String? pipelineRunError(String executionId) =>
      _pipelineRunErrors[executionId];

  Future<void> requestPipelineRunDetail({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
  }) => _requestPipelineData(
    executionId,
    () => repository.requestPipelineExecution(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
    ),
  );

  Future<void> requestPipelineStepLog({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required String jobId,
    required String stepId,
  }) => _requestPipelineData(
    executionId,
    () => repository.requestPipelineStepLog(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
      executionId: executionId,
      jobId: jobId,
      stepId: stepId,
    ),
  );

  Future<void> _requestPipelineData(
    String executionId,
    Future<String> Function() submit,
  ) async {
    if (!isConnected()) {
      _settlePipelineRequest(executionId, error: 'Not connected to a desktop.');
      return;
    }
    final read = (submit: submit, token: Object());
    _pendingReads[executionId] = read;
    _pipelineRunErrors.remove(executionId);
    _pipelineRunWatchdogs.remove(executionId)?.cancel();
    _pipelineRunWatchdogs[executionId] = timer(
      runTimeout,
      () => _settlePipelineRequest(executionId),
    );
    notify();
    try {
      final commandId = await submit();
      if (!identical(_pendingReads[executionId]?.token, read.token)) return;
      if (commandId.isEmpty) return;
      _pipelineCommandExecutions[commandId] = executionId;
      commands.register(
        commandId,
        recordOutcome: false,
        onFailed: (message) {
          if (_pipelineCommandExecutions.remove(commandId) != null) {
            _settlePipelineRequest(executionId, error: message);
          }
        },
        onCompleted: (_) {
          _pipelineCommandExecutions.remove(commandId);
        },
      );
    } on RemoteControlException catch (e) {
      if (!identical(_pendingReads[executionId]?.token, read.token)) return;
      _settlePipelineRequest(executionId, error: e.message);
    } catch (_) {
      if (!identical(_pendingReads[executionId]?.token, read.token)) return;
      _settlePipelineRequest(executionId, error: 'Could not load this run.');
    }
  }

  void _settlePipelineRequest(String executionId, {String? error}) {
    _pendingReads.remove(executionId);
    _pipelineRunWatchdogs.remove(executionId)?.cancel();
    if (error != null) {
      _pipelineRunErrors[executionId] = error;
    } else {
      // A run landing live (e.g. a desktop-side retry, or any other update
      // to this execution) settles a pending request the same way an
      // explicit fetch does, and must not leave an earlier failed request's
      // message sitting above the freshly-landed data.
      _pipelineRunErrors.remove(executionId);
    }
    _pipelineCommandExecutions.removeWhere((_, id) => id == executionId);
    notify();
  }

  /// The control sent for [executionId] that the desktop has not answered.
  RemotePipelineRunAction? pendingPipelineRunAction(String executionId) =>
      _pipelineActionsPending[executionId];

  /// Why the desktop rejected the last control sent for [executionId].
  String? pipelineRunActionError(String executionId) =>
      _pipelineActionErrors[executionId];

  void clearPipelineRunActionError(String executionId) {
    if (_pipelineActionErrors.remove(executionId) != null) {
      notify();
    }
  }

  /// Sends a cancel, resume or retry for one run. One control per run at a
  /// time: a second tap while the first is in flight is ignored.
  Future<void> submitPipelineRunAction({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineRunAction action,
  }) async {
    if (_pipelineActionsPending.containsKey(executionId)) return;
    if (!isConnected()) {
      _settlePipelineAction(executionId, error: 'Not connected to a desktop.');
      return;
    }
    _pipelineActionErrors.remove(executionId);
    _pipelineActionsPending[executionId] = action;
    _pipelineActionWatchdogs[executionId] = timer(
      actionTimeout,
      () => _settlePipelineAction(executionId),
    );
    notify();
    try {
      final commandId = await repository.submitPipelineRunAction(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        executionId: executionId,
        action: action,
      );
      if (commandId.isEmpty) {
        _settlePipelineAction(executionId);
        return;
      }
      _pipelineActionCommands[commandId] = executionId;
      commands.register(
        commandId,
        recordOutcome: false,
        onCompleted: (_) {
          if (_pipelineActionCommands.remove(commandId) != null) {
            _settlePipelineAction(executionId);
          }
        },
        onFailed: (message) {
          if (_pipelineActionCommands.remove(commandId) != null) {
            _settlePipelineAction(executionId, error: message);
          }
        },
      );
    } on RemoteControlException catch (e) {
      _settlePipelineAction(executionId, error: e.message);
    } catch (_) {
      _settlePipelineAction(
        executionId,
        error: 'Could not reach your desktop. Try again.',
      );
    }
  }

  void _settlePipelineAction(String executionId, {String? error}) {
    _pipelineActionWatchdogs.remove(executionId)?.cancel();
    _pipelineActionsPending.remove(executionId);
    _pipelineActionCommands.removeWhere((_, id) => id == executionId);
    if (error != null) _pipelineActionErrors[executionId] = error;
    notify();
  }

  bool removePipelineRun(String executionId) {
    return _pipelineRunUpdates.remove(executionId) != null;
  }

  void settlePipelineRequest(String executionId) =>
      _settlePipelineRequest(executionId);

  /// The fresh snapshot has reseeded the cursor. Reissue reads whose
  /// answers may have fallen before it; never replay pipeline controls.
  void reloadAfterSkippedEvents() {
    final reads = Map.of(_pendingReads);
    reset();
    for (final entry in reads.entries) {
      unawaited(_requestPipelineData(entry.key, entry.value.submit));
    }
  }

  void reset() {
    _pendingReads.clear();
    _pipelineRunUpdates.clear();
    _pipelineRunErrors.clear();
    _pipelineCommandExecutions.clear();
    for (final watchdog in _pipelineRunWatchdogs.values) {
      watchdog.cancel();
    }
    _pipelineRunWatchdogs.clear();
    _pipelineActionsPending.clear();
    _pipelineActionCommands.clear();
    _pipelineActionErrors.clear();
    for (final watchdog in _pipelineActionWatchdogs.values) {
      watchdog.cancel();
    }
    _pipelineActionWatchdogs.clear();
  }

  void dispose() => reset();
}
