import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_chat_follow_up.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart'
    show RemotePortalCommandResult;

import 'owned_command_registry.dart';

/// Deadline for a whole follow-up preparation: the request and any wait for
/// its command event. The send that follows is not bounded by it.
const Duration kRemotePipelineFollowUpTimeout = Duration(seconds: 30);

const String kRemotePipelineFollowUpOwnerUnavailable =
    "This run's worktree is no longer available. Nothing was sent.";

const String _unconfirmed =
    "Your desktop didn't answer. Nothing was sent. Try again.";

/// Sends [text] to [target] through the normal chat send.
typedef RemoteFollowUpSend =
    Future<RemoteChatSendResult> Function(
      RemoteWorktreeChatTarget target,
      String text,
    );

/// Manual chat follow-up from a pipeline run's saved plan or report
/// (CAN-3719).
///
/// The desktop builds the review prompt from its saved reference and picks
/// the run owner's receiving chat; this sends that prompt through the normal
/// chat send, so drafts, queueing and uncertain-send reconciliation apply
/// unchanged. Every send targets the run's own worktree, never the selected
/// one. One action per run is in flight at a time, and none is retried
/// automatically.
final class PipelineChatFollowUpCoordinator {
  PipelineChatFollowUpCoordinator({
    required this.repository,
    required this.commands,
    required this.send,
    required this.ownerExists,
    required this.isConnected,
    required this.sessionGeneration,
    required this.notify,
    this.timeout = kRemotePipelineFollowUpTimeout,
  });

  final RemoteControlRepository repository;
  final OwnedCommandRegistry commands;
  final RemoteFollowUpSend send;

  /// Whether the session still lists the worktree.
  final bool Function(String workspaceLocalId, String worktreeLocalId)
  ownerExists;
  final bool Function() isConnected;
  final int Function() sessionGeneration;
  final void Function() notify;
  final Duration timeout;

  /// The attempt in flight per execution, compared by identity so a stale
  /// attempt finishing after a reset cannot clear a newer one.
  final Map<String, Object> _pending = {};
  final Map<String, String> _errors = {};
  bool _disposed = false;

  bool isPending(String executionId) => _pending.containsKey(executionId);

  /// Why the last follow-up for [executionId] did not reach a chat.
  String? error(String executionId) => _errors[executionId];

  void clearError(String executionId) {
    if (_errors.remove(executionId) != null) notify();
  }

  /// Sends the review prompt for [output] of [run] to the run owner's chat.
  /// Resolves with the receiving chat, including a chat that holds the
  /// message as not sent or uncertain, or null when nothing was sent. Ignored
  /// while a follow-up for the run is pending, and after [dispose].
  Future<RemoteWorktreeChatTarget?> start(
    RemotePipelineRun run,
    RemotePipelineFollowUpOutput output,
  ) async {
    final executionId = run.localId;
    if (_disposed || _pending.containsKey(executionId)) return null;
    final workspaceLocalId = run.workspaceLocalId;
    final worktreeLocalId = run.worktreeLocalId;
    final String? refusal;
    if (!repository.supportsPipelineChatFollowUp) {
      refusal = kRemotePipelineFollowUpUnsupported;
    } else if (!isConnected()) {
      refusal = 'Not connected to your desktop. Nothing was sent.';
    } else if (workspaceLocalId == null ||
        worktreeLocalId == null ||
        !ownerExists(workspaceLocalId, worktreeLocalId)) {
      refusal = kRemotePipelineFollowUpOwnerUnavailable;
    } else {
      refusal = null;
    }
    if (refusal != null) {
      _errors[executionId] = refusal;
      notify();
      return null;
    }
    final attempt = Object();
    _pending[executionId] = attempt;
    _errors.remove(executionId);
    notify();
    final generation = sessionGeneration();
    // A reset or dispose drops the pending marker; a new session advances
    // the generation. Either way the attempt must not send or report.
    bool isCurrent() =>
        identical(_pending[executionId], attempt) &&
        generation == sessionGeneration();
    // Past the deadline a late answer or event must not be used, even before
    // this attempt settles.
    var expired = false;
    String? commandId;
    try {
      final preparation =
          await _prepare(
            workspaceLocalId: workspaceLocalId!,
            worktreeLocalId: worktreeLocalId!,
            executionId: executionId,
            output: output,
            isCurrent: () => !expired && isCurrent(),
            onAwaitingCommand: (id) => commandId = id,
          ).timeout(
            timeout,
            onTimeout: () {
              expired = true;
              if (commandId case final id?) commands.release(id);
              throw const RemoteControlException(_unconfirmed);
            },
          );
      if (!isCurrent()) return null;
      if (preparation == null ||
          preparation.executionId != executionId ||
          preparation.workspaceLocalId != workspaceLocalId ||
          preparation.worktreeLocalId != worktreeLocalId ||
          preparation.output != output) {
        throw const RemoteControlException(_unconfirmed);
      }
      if (!ownerExists(workspaceLocalId, worktreeLocalId)) {
        throw const RemoteControlException(
          kRemotePipelineFollowUpOwnerUnavailable,
        );
      }
      final target = RemoteWorktreeChatTarget(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        chatId: preparation.chatId,
      );
      String? receivingChatId;
      try {
        receivingChatId =
            (await send(target, preparation.prompt)).chatId ?? target.chatId;
      } on RemoteChatSendNotSentException catch (e) {
        // The receiving chat keeps the message as a not-sent or uncertain
        // row with its own Resend; open it there instead of resending here.
        receivingChatId = e.chatId ?? target.chatId;
        if (receivingChatId == null) rethrow;
      }
      if (!isCurrent()) return null;
      return RemoteWorktreeChatTarget(
        workspaceLocalId: workspaceLocalId,
        worktreeLocalId: worktreeLocalId,
        chatId: receivingChatId,
      );
    } on RemoteControlException catch (e) {
      if (isCurrent()) _errors[executionId] = e.message;
      return null;
    } catch (_) {
      if (isCurrent()) _errors[executionId] = _unconfirmed;
      return null;
    } finally {
      if (identical(_pending[executionId], attempt)) {
        _pending.remove(executionId);
        notify();
      }
    }
  }

  Future<RemotePipelineFollowUpPreparation?> _prepare({
    required String workspaceLocalId,
    required String worktreeLocalId,
    required String executionId,
    required RemotePipelineFollowUpOutput output,
    required bool Function() isCurrent,
    required void Function(String commandId) onAwaitingCommand,
  }) async {
    final RemotePortalCommandResult response = await repository
        .preparePipelineChatFollowUp(
          workspaceLocalId: workspaceLocalId,
          worktreeLocalId: worktreeLocalId,
          executionId: executionId,
          output: output,
        );
    if (!isCurrent()) return null;
    final inline = response.result;
    if (inline != null) {
      return RemotePipelineFollowUpPreparation.fromJson(inline);
    }
    // The relay stopped waiting; the answer arrives as the command's
    // terminal event, possibly before this registration.
    final commandId = response.commandId;
    if (commandId.isEmpty) return null;
    final answer = Completer<Map<String, dynamic>?>();
    onAwaitingCommand(commandId);
    commands.register(
      commandId,
      recordOutcome: false,
      onCompleted: (result) {
        if (!answer.isCompleted) answer.complete(result);
      },
      onFailed: (message) {
        if (!answer.isCompleted) {
          answer.completeError(RemoteControlException(message));
        }
      },
    );
    final result = await answer.future;
    return result == null
        ? null
        : RemotePipelineFollowUpPreparation.fromJson(result);
  }

  /// Forgets errors and pending markers of a discarded session. Work still
  /// in flight finds its attempt stale and reports nothing.
  void reset() {
    _pending.clear();
    _errors.clear();
  }

  /// Discards work in flight like [reset] and ignores later starts.
  void dispose() {
    _disposed = true;
    reset();
  }
}
