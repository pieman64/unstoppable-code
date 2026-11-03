import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_chat_row.dart';
import 'package:provider/provider.dart';

/// A [CloudChatRow] with a long-press menu, matching the remote worktree
/// rows. Delete moves the chat into its project's retention window, as the
/// web sidebar's Delete does.
class CloudChatActionsRow extends StatefulWidget {
  const CloudChatActionsRow({
    super.key,
    required this.chat,
    required this.working,
    required this.deletionRetentionDays,
    required this.onTap,
    this.leadingInset = 16,
  });

  final CloudChatSummary chat;
  final bool working;

  /// Days the server keeps a deleted chat; zero when the project omits it.
  final int deletionRetentionDays;
  final VoidCallback onTap;
  final double leadingInset;

  @override
  State<CloudChatActionsRow> createState() => _CloudChatActionsRowState();
}

class _CloudChatActionsRowState extends State<CloudChatActionsRow> {
  bool _menuOpen = false;
  bool _deleting = false;

  String get _chatId => widget.chat.externalId;

  Future<void> _showMenu(Offset position) async {
    if (_menuOpen || _deleting) return;
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final local = overlay.globalToLocal(position);
    final theme = Theme.of(context);
    final isChildTab = widget.chat.taskChatExternalId != null;
    final hasPendingSend = _hasPendingAffectedSend(
      context.read<CloudChatsViewModel>(),
      context.read<CloudChatViewModel>(),
    );
    final enabled = !widget.working && !isChildTab && !hasPendingSend;
    _menuOpen = true;
    try {
      final selected = await showMenu<String>(
        context: context,
        position: RelativeRect.fromRect(
          Rect.fromLTWH(local.dx, local.dy, 0, 0),
          Offset.zero & overlay.size,
        ),
        items: [
          PopupMenuItem<String>(
            key: ValueKey('cloud-delete-chat-$_chatId'),
            value: 'delete',
            enabled: enabled,
            child: Row(
              children: [
                CanopyIcon(
                  glyph: CanopyGlyph.trashCan,
                  size: 20,
                  tint: enabled ? theme.colorScheme.error : theme.disabledColor,
                ),
                const SizedBox(width: 12),
                const Text('Delete'),
              ],
            ),
          ),
          if (isChildTab)
            const PopupMenuItem<String>(
              enabled: false,
              child: Text(
                'Delete the main chat to remove its child tabs.',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            )
          else if (!enabled)
            PopupMenuItem<String>(
              enabled: false,
              child: Text(
                hasPendingSend
                    ? 'Wait for the queued message to send before deleting it.'
                    : 'Wait for the chat to finish before deleting it.',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
        ],
      );
      if (!mounted || selected != 'delete') return;
      await _delete();
    } finally {
      _menuOpen = false;
    }
  }

  bool _hasPendingAffectedSend(
    CloudChatsViewModel list,
    CloudChatViewModel session,
  ) {
    final state = session.state;
    if (state == null ||
        (state.outbox.isEmpty && session.queuedTurns.isEmpty)) {
      return false;
    }
    if (state.chatId == _chatId) return true;
    return list.workspaces.any(
      (workspace) => workspace.chats.any(
        (chat) =>
            chat.externalId == state.chatId &&
            chat.taskChatExternalId == _chatId,
      ),
    );
  }

  Future<void> _delete() async {
    if (_deleting || widget.chat.taskChatExternalId != null) return;
    _deleting = true;
    final list = context.read<CloudChatsViewModel>();
    final session = context.read<CloudChatViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final generation = list.scopeGeneration;
    try {
      final confirmed = await confirmDestructive(
        context,
        title: 'Delete chat?',
        message:
            'Delete “${cloudChatDisplayTitle(widget.chat)}”? '
            '${_retentionSentence(widget.deletionRetentionDays)} '
            'You can restore it on the web from Archived and deleted.',
        confirmLabel: 'Delete',
        confirmKey: const ValueKey('cloud-delete-confirm'),
      );
      if (!confirmed || !mounted || generation != list.scopeGeneration) {
        return;
      }
      final affectedChatIds = {
        _chatId,
        for (final workspace in list.workspaces)
          for (final chat in workspace.chats)
            if (chat.taskChatExternalId == _chatId) chat.externalId,
      };
      final hasPendingSend = _hasPendingAffectedSend(list, session);
      if ((session.turnInProgress &&
              affectedChatIds.contains(session.state?.chatId)) ||
          hasPendingSend) {
        messenger
          ..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              content: Text(
                hasPendingSend
                    ? 'Wait for the queued message to send before deleting it.'
                    : 'Wait for the chat to finish before deleting it.',
              ),
            ),
          );
        return;
      }
      await list.delete(_chatId);
      if (affectedChatIds.contains(session.state?.chatId)) session.close();
    } catch (error) {
      if (!messenger.mounted) return;
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              error is CloudApiException
                  ? error.message
                  : "Couldn't delete the chat. Try again.",
            ),
          ),
        );
    } finally {
      _deleting = false;
    }
  }

  static String _retentionSentence(int days) => switch (days) {
    <= 0 => 'Deleted chats are kept for a while, then removed.',
    1 => 'Deleted chats are kept for 1 day, then removed.',
    _ => 'Deleted chats are kept for $days days, then removed.',
  };

  @override
  Widget build(BuildContext context) {
    void openMenu() {
      final box = context.findRenderObject()! as RenderBox;
      _showMenu(box.localToGlobal(box.size.center(Offset.zero)));
    }

    return Semantics(
      customSemanticsActions: {
        const CustomSemanticsAction(label: 'Chat actions'): openMenu,
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPressStart: (details) => _showMenu(details.globalPosition),
        child: CloudChatRow(
          chat: widget.chat,
          working: widget.working,
          leadingInset: widget.leadingInset,
          onTap: widget.onTap,
        ),
      ),
    );
  }
}
