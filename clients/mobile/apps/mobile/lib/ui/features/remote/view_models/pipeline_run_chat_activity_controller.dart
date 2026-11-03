import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'pipeline_run_chat_activity.dart';
import 'remote_control_view_model.dart';

/// One worktree chat screen's Agent activity panels (CAN-3619): which runs
/// each turn shows, their controls, and the user's expand/collapse choices
/// for as long as the screen is open.
///
/// It listens to the whole [RemoteControlViewModel] but notifies only when
/// something a panel shows changes (which turns have runs, a run's status,
/// name, start, job states, or its pending control or error), so streaming
/// chat text and live step output never rebuild the transcript.
final class PipelineRunChatActivityController extends ChangeNotifier
    with DisposeSafeNotifier {
  PipelineRunChatActivityController({
    required this.viewModel,
    required this.workspaceLocalId,
    required this.worktreeLocalId,
  }) {
    viewModel.addListener(_onSourceChanged);
  }

  final RemoteControlViewModel viewModel;
  final String workspaceLocalId;
  final String worktreeLocalId;

  String? _chatId;
  PipelineRunChatActivity _activity = PipelineRunChatActivity.empty;
  String? _signature;

  /// Explicit user choices, keyed by chat and turn. Absent means the default:
  /// expanded only for the latest turn with activity.
  final Map<(String, String), bool> _expanded = {};

  /// The chat [activity] shows.
  String? get chatId => _chatId;

  /// The bound chat's panels; rendering reads only this.
  PipelineRunChatActivity get activity => _activity;

  /// Binds [chatId] and returns its panels. Binding another chat reads its
  /// runs when needed and recomputes in place without notifying. Call it
  /// outside build.
  PipelineRunChatActivity bind(String chatId) {
    if (chatId != _chatId) {
      _chatId = chatId;
      _hydrateRuns();
      _recompute();
    }
    return _activity;
  }

  /// Foreground chat opens without the worktree's activity slices, and a
  /// finished run sends no live update, so a run this session has not cached
  /// would show only after Activity & files opened. Older hosts already
  /// hydrate the whole worktree when the chat opens. Repeated on every source
  /// change: the read is single-flight per session, so this only reads again
  /// once connected, in a new session, or when a failed read may retry.
  void _hydrateRuns() {
    if (!viewModel.supportsPipelineRunChatLinks ||
        !viewModel.supportsForegroundChat) {
      return;
    }
    viewModel.ensurePipelineRuns(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
  }

  bool isExpanded(
    String chatId,
    String turnKey, {
    required String? latestTurnKey,
  }) => _expanded[(chatId, turnKey)] ?? turnKey == latestTurnKey;

  void toggle(String chatId, String turnKey, {required String? latestTurnKey}) {
    _expanded[(chatId, turnKey)] = !isExpanded(
      chatId,
      turnKey,
      latestTurnKey: latestTurnKey,
    );
    notifyListenersSafe();
  }

  RemotePipelineRunAction? pendingAction(String executionId) =>
      viewModel.pendingPipelineRunAction(executionId);

  String? actionError(String executionId) =>
      viewModel.pipelineRunActionError(executionId);

  /// Sends the run's existing cancel command. No confirmation: the desktop
  /// and the run screen cancel on one tap too.
  Future<void> cancel(String executionId) => viewModel.submitPipelineRunAction(
    workspaceLocalId: workspaceLocalId,
    worktreeLocalId: worktreeLocalId,
    executionId: executionId,
    action: RemotePipelineRunAction.cancel,
  );

  void _onSourceChanged() {
    if (_chatId == null || isDisposed) return;
    _hydrateRuns();
    if (_recompute()) notifyListenersSafe();
  }

  /// Returns whether anything a panel shows changed.
  bool _recompute() {
    final chatId = _chatId;
    final activity = chatId == null || !viewModel.supportsPipelineRunChatLinks
        ? PipelineRunChatActivity.empty
        : selectPipelineRunChatActivity(
            chatId: chatId,
            worktreeLocalId: worktreeLocalId,
            runs: viewModel.pipelineRunsFor(worktreeLocalId),
          );
    _activity = activity;
    final signature = _signatureOf(activity);
    if (signature == _signature) return false;
    _signature = signature;
    return true;
  }

  String _signatureOf(PipelineRunChatActivity activity) {
    final parts = <String>[];
    for (final MapEntry(key: turn, value: runs)
        in activity.runsByTurn.entries) {
      parts.add('turn:$turn');
      for (final run in runs) {
        parts.add(
          [
            run.localId,
            run.status,
            run.pipelineName,
            run.startedAt,
            pendingAction(run.localId)?.name,
            actionError(run.localId),
            for (final job in run.jobs ?? const <RemotePipelineRunJob>[])
              '${job.jobId}=${job.status}<${(job.needs ?? const []).join(',')}',
          ].join('\u0000'),
        );
      }
    }
    return parts.join('\u0001');
  }

  @override
  void dispose() {
    viewModel.removeListener(_onSourceChanged);
    super.dispose();
  }
}

/// A chat screen's [PipelineRunChatActivityController], kept for the
/// screen's lifetime so expand/collapse choices hold across chat tabs.
final class PipelineRunChatActivityHost {
  PipelineRunChatActivityController? _controller;

  /// The controller for [worktree]'s chats, or null where a chat shows no
  /// panel: standalone chats and cowork entries. Another worktree replaces
  /// the held controller.
  PipelineRunChatActivityController? controllerFor(
    RemoteControlViewModel viewModel,
    RemoteWorktree? worktree,
  ) {
    if (worktree == null ||
        !showsPipelineRunChatActivity(worktree, viewModel.workspaces)) {
      return null;
    }
    final current = _controller;
    if (current != null &&
        current.workspaceLocalId == worktree.workspaceLocalId &&
        current.worktreeLocalId == worktree.localId) {
      return current;
    }
    current?.dispose();
    return _controller = PipelineRunChatActivityController(
      viewModel: viewModel,
      workspaceLocalId: worktree.workspaceLocalId,
      worktreeLocalId: worktree.localId,
    );
  }

  void dispose() => _controller?.dispose();
}
