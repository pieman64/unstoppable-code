import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';
import '../remote_background_agent_chat_screen.dart';
import 'background_tray.dart';

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
    active: widget.active,
    expanded: _tray.expanded,
    onExpandedChanged: _tray.setExpanded,
  );
}
