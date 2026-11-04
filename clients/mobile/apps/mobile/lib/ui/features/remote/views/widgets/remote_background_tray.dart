import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pipeline_run.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/run_presentation.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';
import '../remote_background_agent_chat_screen.dart';
import '../remote_pipeline_run_screen.dart';
import 'background_tray.dart';
import 'background_tray_run_row.dart';

/// Keeps tray projection, its clock and session lifetime out of the chat route.
class RemoteBackgroundTray extends StatefulWidget {
  const RemoteBackgroundTray({
    super.key,
    required this.target,
    this.active = true,
  });
  final RemoteWorktreeChatTarget target;
  final bool active;

  @override
  State<RemoteBackgroundTray> createState() => _RemoteBackgroundTrayState();
}

class _RemoteBackgroundTrayState extends State<RemoteBackgroundTray> {
  RemoteControlViewModel? _source;
  late BackgroundTrayViewModel _tray;
  int? _generation;
  ({int generation, String workspace, String worktree})? _activityTarget;
  bool _projecting = false;

  void _changed() {
    if (mounted && !_projecting) setState(() {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final source = context.read<RemoteControlViewModel>();
    if (_source != source) {
      if (_source != null) {
        _source?.removeListener(_sync);
        _tray.dispose();
      }
      _source = source;
      _activityTarget = null;
      source.addListener(_sync);
      _tray = BackgroundTrayViewModel(
        onChanged: _changed,
        lifetime: source.backgroundTrayRunLifetime,
      );
      _generation = source.sessionGeneration;
    }
    _sync();
  }

  @override
  void didUpdateWidget(RemoteBackgroundTray oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  void _sync() {
    final source = _source;
    if (source == null) return;
    if (_generation != source.sessionGeneration) {
      _tray.dispose();
      _tray = BackgroundTrayViewModel(
        onChanged: _changed,
        lifetime: source.backgroundTrayRunLifetime,
      );
      _generation = source.sessionGeneration;
    }
    final target = widget.target;
    final activityTarget = (
      generation: source.sessionGeneration,
      workspace: target.workspaceLocalId,
      worktree: target.worktreeLocalId,
    );
    if (widget.active &&
        source.isConnected &&
        _activityTarget != activityTarget) {
      _activityTarget = activityTarget;
      source.ensureBackgroundProcesses(
        workspaceLocalId: target.workspaceLocalId,
        worktreeLocalId: target.worktreeLocalId,
      );
    }
    final chatId = target.chatId;
    _projecting = true;
    _tray.update(
      target: target,
      backgroundProcesses: chatId == null
          ? const []
          : source.backgroundProcessesFor(
              workspaceLocalId: target.workspaceLocalId,
              worktreeLocalId: target.worktreeLocalId,
              chatId: chatId,
            ),
      messages: source.messagesFor(target),
      pipelineRuns: source.pipelineRunsFor(target.worktreeLocalId),
      chatSummary: source
          .chatSummariesFor(
            workspaceLocalId: target.workspaceLocalId,
            worktreeLocalId: target.worktreeLocalId,
          )
          .where((s) => s.chatId == target.chatId)
          .firstOrNull,
    );
    if (!widget.active) _tray.setExpanded(false);
    _projecting = false;
    _changed();
  }

  /// Stop and Resume use the run's Portal commands, as the web Portal's Stop
  /// does: only with the pipeline capability and a live session. Without
  /// them, Resume opens the run, where Respond always goes.
  BackgroundTrayRunControls? _runControls() {
    final source = _source;
    if (source == null) return null;
    final target = widget.target;
    final canCommand = source.supportsPipelineDispatch && source.isConnected;
    void open(BackgroundTrayRun run) {
      final pipelineRun = run.pipelineRun;
      if (pipelineRun == null) return;
      pushRemotePipelineRunScreen(
        context,
        workspaceLocalId: target.workspaceLocalId,
        worktreeLocalId: target.worktreeLocalId,
        run: pipelineRun,
      );
    }

    void submit(BackgroundTrayRun run, RemotePipelineRunAction action) {
      final executionId = run.pipelineRun?.localId;
      if (executionId == null) return;
      unawaited(
        source.submitPipelineRunAction(
          workspaceLocalId: target.workspaceLocalId,
          worktreeLocalId: target.worktreeLocalId,
          executionId: executionId,
          action: action,
        ),
      );
    }

    return BackgroundTrayRunControls(
      canStop: canCommand,
      isPending: (run) => switch (run.pipelineRun?.localId) {
        final id? => source.pendingPipelineRunAction(id) != null,
        null => false,
      },
      onOpen: open,
      onAction: (run, action) => switch (action) {
        BackgroundTrayRunAction.stop => submit(
          run,
          RemotePipelineRunAction.cancel,
        ),
        BackgroundTrayRunAction.resume when canCommand => submit(
          run,
          RemotePipelineRunAction.resume,
        ),
        BackgroundTrayRunAction.resume ||
        BackgroundTrayRunAction.respond => open(run),
        BackgroundTrayRunAction.dismiss => _tray.dismissRun(run.id),
      },
    );
  }

  @override
  void dispose() {
    _source?.removeListener(_sync);
    _tray.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => BackgroundTray(
    summary: _tray.summary,
    now: _tray.now,
    onOpenAgent: (target) {
      final source = _source;
      if (source == null) return;
      final generation = source.sessionGeneration;
      final parent = widget.target;
      unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => RemoteBackgroundAgentChatScreen(
              source: source,
              parent: parent,
              target: target,
              sessionGeneration: generation,
            ),
          ),
        ),
      );
    },
    runControls: _runControls(),
    active: widget.active,
    expanded: _tray.expanded,
    onExpandedChanged: _tray.setExpanded,
  );
}
