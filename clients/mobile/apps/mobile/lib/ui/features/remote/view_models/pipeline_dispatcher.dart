import 'dart:async';

import 'package:mobile/data/models/remote_pipeline_dispatch.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';

import 'owned_command_registry.dart';

/// Watchdog for a dispatch-form request the desktop never answers.
const Duration kRemotePipelineFormTimeout = Duration(seconds: 20);

/// Watchdog for a dispatch the desktop never confirms.
const Duration kRemotePipelineDispatchTimeout = Duration(seconds: 30);

const String kRemotePipelineDispatchUnconfirmed =
    "The desktop didn't confirm the run. Check Pipeline runs before trying "
    'again.';

const String _formLoadFailed = "Couldn't load this pipeline. Try again.";

sealed class RemotePipelineFormState {
  const RemotePipelineFormState();
}

/// One load attempt. Not const: the dispatcher tells attempts apart by
/// identity, so a late answer from an earlier attempt cannot settle a newer
/// one.
final class RemotePipelineFormLoading extends RemotePipelineFormState {
  RemotePipelineFormLoading();
}

final class RemotePipelineFormLoaded extends RemotePipelineFormState {
  const RemotePipelineFormLoaded(this.form);
  final RemotePipelineDispatchForm form;
}

final class RemotePipelineFormFailed extends RemotePipelineFormState {
  const RemotePipelineFormFailed(this.message);
  final String message;
}

sealed class RemotePipelineDispatchState {
  const RemotePipelineDispatchState();
}

/// One start attempt. Not const: the dispatcher tells attempts apart by
/// identity, so a late answer from an earlier attempt cannot settle a newer
/// one.
final class RemotePipelineDispatchSubmitting
    extends RemotePipelineDispatchState {
  RemotePipelineDispatchSubmitting();

  /// The relay has accepted the command during reconnect. The form may close,
  /// but this attempt still blocks another Run until its outcome is known.
  bool queuedWhileReconnecting = false;
}

final class RemotePipelineDispatchStarted extends RemotePipelineDispatchState {
  const RemotePipelineDispatchStarted(this.executionId);
  final String executionId;
}

final class RemotePipelineDispatchFailed extends RemotePipelineDispatchState {
  const RemotePipelineDispatchFailed(this.message);
  final String message;
}

/// Session-scoped dispatch forms and pipeline starts (CAN-3174), keyed by
/// worktree and pipeline. One start per pipeline is in flight at a time, and
/// none is ever retried automatically: command ids are server-assigned, so a
/// blind resend could start a second run.
final class PipelineDispatcher {
  PipelineDispatcher({
    required this.repository,
    required this.commands,
    required this.isConnected,
    required this.notify,
    this.formTimeout = kRemotePipelineFormTimeout,
    this.dispatchTimeout = kRemotePipelineDispatchTimeout,
    this.timer = Timer.new,
  });

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final bool Function() isConnected;
  final void Function() notify;
  final Duration formTimeout;
  final Duration dispatchTimeout;
  final Timer Function(Duration, void Function()) timer;

  final Map<String, RemotePipelineFormState> _forms = {};
  final Map<String, Timer> _formWatchdogs = {};
  final Map<String, ({String key, RemotePipelineFormLoading attempt})>
  _formCommands = {};
  final Map<String, RemotePipelineDispatchState> _dispatches = {};
  final Map<String, Timer> _dispatchWatchdogs = {};
  final Map<String, ({String key, RemotePipelineDispatchSubmitting attempt})>
  _dispatchCommands = {};

  static String _key(String worktreeLocalId, String pipelineId) =>
      '$worktreeLocalId\u0000$pipelineId';

  RemotePipelineFormState? formState({
    required String worktreeLocalId,
    required String pipelineId,
  }) => _forms[_key(worktreeLocalId, pipelineId)];

  Future<void> loadForm({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
  }) async {
    final key = _key(worktreeLocalId, pipelineId);
    if (_forms[key] is RemotePipelineFormLoading) return;
    if (!isConnected()) {
      _settleForm(key, null, failure: 'Not connected to a desktop.');
      return;
    }
    final attempt = RemotePipelineFormLoading();
    _forms[key] = attempt;
    _formWatchdogs.remove(key)?.cancel();
    _formWatchdogs[key] = timer(
      formTimeout,
      () => _settleForm(key, attempt, failure: _formLoadFailed),
    );
    notify();
    try {
      final response = await repository.requestPipelineDispatchForm(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        pipelineId: pipelineId,
      );
      // A reset, the watchdog, or a newer attempt already settled this load;
      // a late answer must not overwrite it.
      if (!identical(_forms[key], attempt)) return;
      if (response.result case final result?) {
        _settleForm(
          key,
          attempt,
          form: RemotePipelineDispatchForm.fromGetResult(result),
        );
        return;
      }
      final commandId = response.commandId;
      if (commandId.isEmpty) {
        _settleForm(key, attempt, failure: _formLoadFailed);
        return;
      }
      _formCommands[commandId] = (key: key, attempt: attempt);
      commands.register(
        commandId,
        recordOutcome: false,
        onCompleted: (result) {
          if (_formCommands.remove(commandId) == null) return;
          _settleForm(
            key,
            attempt,
            form: result == null
                ? null
                : RemotePipelineDispatchForm.fromGetResult(result),
            failure: result == null ? _formLoadFailed : null,
          );
        },
        onFailed: (message) {
          if (_formCommands.remove(commandId) != null) {
            _settleForm(key, attempt, failure: message);
          }
        },
      );
    } on RemoteControlException catch (e) {
      _settleForm(key, attempt, failure: e.message);
    } catch (_) {
      _settleForm(key, attempt, failure: _formLoadFailed);
    }
  }

  /// Settles [attempt] only while it is still the key's current load.
  void _settleForm(
    String key,
    RemotePipelineFormLoading? attempt, {
    RemotePipelineDispatchForm? form,
    String? failure,
  }) {
    if (attempt != null && !identical(_forms[key], attempt)) return;
    _formWatchdogs.remove(key)?.cancel();
    _formCommands.removeWhere((_, owner) => owner.key == key);
    _forms[key] = form != null
        ? RemotePipelineFormLoaded(form)
        : RemotePipelineFormFailed(failure ?? _formLoadFailed);
    notify();
  }

  RemotePipelineDispatchState? dispatchState({
    required String worktreeLocalId,
    required String pipelineId,
  }) => _dispatches[_key(worktreeLocalId, pipelineId)];

  /// Starts [pipelineId]. Ignored while a start for it is already in flight.
  Future<void> dispatch({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String pipelineId,
    required Map<String, String> inputs,
  }) async {
    final key = _key(worktreeLocalId, pipelineId);
    if (_dispatches[key] is RemotePipelineDispatchSubmitting) return;
    if (!isConnected()) {
      _dispatches[key] = const RemotePipelineDispatchFailed(
        'Not connected to a desktop.',
      );
      notify();
      return;
    }
    final attempt = RemotePipelineDispatchSubmitting();
    _dispatches[key] = attempt;
    _dispatchWatchdogs[key] = timer(
      dispatchTimeout,
      () => _settleDispatch(
        key,
        attempt,
        failure: kRemotePipelineDispatchUnconfirmed,
      ),
    );
    notify();
    try {
      final commandId = await repository.dispatchPipeline(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        pipelineId: pipelineId,
        inputs: inputs,
      );
      // A reset, the watchdog, or a newer attempt already settled this start;
      // a late answer must not reopen it or lend it this command id.
      if (!identical(_dispatches[key], attempt)) return;
      _trackDispatchCommand(key, attempt, commandId);
    } on RemotePipelineDispatchQueuedException catch (e) {
      // The relay accepted this command but the desktop has not received it.
      // Its normal watchdog would enable a duplicate Run during a long
      // reconnect; wait for the terminal event or matching run update instead.
      if (!identical(_dispatches[key], attempt)) return;
      _dispatchWatchdogs.remove(key)?.cancel();
      _trackDispatchCommand(key, attempt, e.commandId);
      if (identical(_dispatches[key], attempt)) {
        attempt.queuedWhileReconnecting = true;
        notify();
      }
    } on RemotePipelineDispatchOutcomeUnknownException {
      _settleDispatch(
        key,
        attempt,
        failure: kRemotePipelineDispatchUnconfirmed,
      );
    } on RemoteControlException catch (e) {
      _settleDispatch(key, attempt, failure: e.message);
    } catch (_) {
      _settleDispatch(
        key,
        attempt,
        failure: 'Could not reach your desktop. Try again.',
      );
    }
  }

  void _trackDispatchCommand(
    String key,
    RemotePipelineDispatchSubmitting attempt,
    String commandId,
  ) {
    if (commandId.isEmpty) {
      _settleDispatch(
        key,
        attempt,
        failure: kRemotePipelineDispatchUnconfirmed,
      );
      return;
    }
    _dispatchCommands[commandId] = (key: key, attempt: attempt);
    commands.register(
      commandId,
      recordOutcome: false,
      onCompleted: (result) {
        if (_dispatchCommands.remove(commandId) == null) return;
        final executionId = result?['executionId'];
        _settleDispatch(
          key,
          attempt,
          executionId: executionId is String && executionId.isNotEmpty
              ? executionId
              : commandId,
        );
      },
      onFailed: (message) {
        if (_dispatchCommands.remove(commandId) != null) {
          _settleDispatch(key, attempt, failure: message);
        }
      },
    );
  }

  /// Settles the start whose command produced a `pipeline_run` upsert, in
  /// case the command's own terminal event is lost. Returns whether it did.
  bool observeRunStarted({
    required String? commandId,
    required String executionId,
  }) {
    if (commandId == null) return false;
    final owner = _dispatchCommands.remove(commandId);
    if (owner == null) return false;
    _settleDispatch(owner.key, owner.attempt, executionId: executionId);
    return true;
  }

  /// Forgets a settled start once the screen has acted on it.
  void clearDispatch({
    required String worktreeLocalId,
    required String pipelineId,
  }) {
    final key = _key(worktreeLocalId, pipelineId);
    if (_dispatches[key] is RemotePipelineDispatchSubmitting) return;
    if (_dispatches.remove(key) != null) notify();
  }

  /// Settles [attempt] only while it is still the key's current start, so an
  /// earlier attempt's late answer cannot cancel the newer attempt's watchdog
  /// or drop its command.
  void _settleDispatch(
    String key,
    RemotePipelineDispatchSubmitting attempt, {
    String? executionId,
    String? failure,
  }) {
    if (!identical(_dispatches[key], attempt)) return;
    _dispatchWatchdogs.remove(key)?.cancel();
    _dispatchCommands.removeWhere((_, owner) => owner.key == key);
    _dispatches[key] = executionId != null
        ? RemotePipelineDispatchStarted(executionId)
        : RemotePipelineDispatchFailed(
            failure ?? kRemotePipelineDispatchUnconfirmed,
          );
    notify();
  }

  /// Skipped events cannot confirm a start. Release the form with the
  /// existing check-runs guidance, without replaying any pipeline command.
  void reloadAfterSkippedEvents() {
    for (final entry in _dispatches.entries.toList()) {
      if (entry.value case final RemotePipelineDispatchSubmitting attempt) {
        _settleDispatch(
          entry.key,
          attempt,
          failure: kRemotePipelineDispatchUnconfirmed,
        );
      }
    }
  }

  /// Forgets every form and start. Work still in flight sees its attempt
  /// missing from the maps and drops its answer.
  void reset() {
    for (final watchdog in [
      ..._formWatchdogs.values,
      ..._dispatchWatchdogs.values,
    ]) {
      watchdog.cancel();
    }
    _formWatchdogs.clear();
    _dispatchWatchdogs.clear();
    _forms.clear();
    _formCommands.clear();
    _dispatches.clear();
    _dispatchCommands.clear();
  }

  void dispose() => reset();
}
