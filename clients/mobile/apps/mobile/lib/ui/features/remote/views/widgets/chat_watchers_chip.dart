import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_control.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_watchers_sheet.dart';

/// The composer's watcher count, desktop `ChatInput`'s `watchersSlot`.
class ChatWatchersChip extends StatelessWidget {
  const ChatWatchersChip({
    super.key,
    required this.count,
    required this.onPressed,
  });

  final int count;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return CanopyComposerControl(
      key: const ValueKey('composer-watchers'),
      glyph: CanopyGlyph.eyeSparkle,
      label: '$count',
      showLabel: count > 1,
      tone: CanopyComposerControlTone.statusActive,
      tooltip: 'Manage chat watchers',
      onTap: onPressed,
    );
  }
}

/// The chip for one worktree chat, or null to hide it. Like desktop, it hides
/// with no watchers, while a prompt holds the composer, and when the desktop
/// does not offer chat watchers (the view model then projects none).
Widget? remoteChatWatchersChip(
  BuildContext context, {
  required RemoteControlViewModel viewModel,
  required RemoteWorktree? worktree,
  required String? chatId,
  required bool promptOpen,
}) {
  if (worktree == null || chatId == null || promptOpen) return null;
  return _RemoteChatWatchersChip(
    viewModel: viewModel,
    worktree: worktree,
    chatId: chatId,
  );
}

/// Holds its subscription even when the count is zero, so the first watcher
/// can make the control appear without another part of the screen changing.
class _RemoteChatWatchersChip extends StatefulWidget {
  const _RemoteChatWatchersChip({
    required this.viewModel,
    required this.worktree,
    required this.chatId,
  });

  final RemoteControlViewModel viewModel;
  final RemoteWorktree worktree;
  final String chatId;

  @override
  State<_RemoteChatWatchersChip> createState() =>
      _RemoteChatWatchersChipState();
}

class _RemoteChatWatchersChipState extends State<_RemoteChatWatchersChip> {
  int? _session;

  @override
  void didUpdateWidget(_RemoteChatWatchersChip oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.viewModel != widget.viewModel ||
        oldWidget.worktree.workspaceLocalId !=
            widget.worktree.workspaceLocalId ||
        oldWidget.worktree.localId != widget.worktree.localId) {
      _session = null;
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.viewModel,
    builder: (context, _) {
      final vm = widget.viewModel;
      final worktree = widget.worktree;
      if (vm.supportsChatWatchers && _session != vm.sessionGeneration) {
        _session = vm.sessionGeneration;
        unawaited(
          vm.refreshWorktreeActivity(
            workspaceLocalId: worktree.workspaceLocalId,
            worktreeLocalId: worktree.localId,
          ),
        );
      }
      final count = vm
          .watchersForChat(
            worktree.localId,
            widget.chatId,
            workspaceLocalId: worktree.workspaceLocalId,
          )
          .length;
      if (count == 0) return const SizedBox.shrink();
      return ChatWatchersChip(
        count: count,
        onPressed: () => unawaited(
          showChatWatchersSheet(
            context,
            viewModel: vm,
            worktree: worktree,
            chatId: widget.chatId,
          ),
        ),
      );
    },
  );
}
