import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/chat_watcher_card_presentation.dart';
import 'package:mobile/ui/features/remote/view_models/chat_watcher_delete_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

/// Opens the open chat's watchers. [viewModel] is passed in because a modal
/// route cannot see the shell's providers.
Future<void> showChatWatchersSheet(
  BuildContext context, {
  required RemoteControlViewModel viewModel,
  required RemoteWorktree worktree,
  required String chatId,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  useSafeArea: true,
  showDragHandle: true,
  builder: (_) => ChatWatchersSheet(
    viewModel: viewModel,
    worktree: worktree,
    chatId: chatId,
  ),
);

/// Desktop's "Chat watchers" modal for one chat. Rows follow the live
/// projection, so a deleted watcher leaves when its removal delta lands.
/// There is no "Jump to chat": the subscriber is always the open chat.
class ChatWatchersSheet extends StatefulWidget {
  const ChatWatchersSheet({
    super.key,
    required this.viewModel,
    required this.worktree,
    required this.chatId,
    this.clock = DateTime.now,
  });

  final RemoteControlViewModel viewModel;
  final RemoteWorktree worktree;
  final String chatId;
  final DateTime Function() clock;

  @override
  State<ChatWatchersSheet> createState() => _ChatWatchersSheetState();
}

class _ChatWatchersSheetState extends State<ChatWatchersSheet> {
  late final _deletes = ChatWatcherDeleteController(
    delete: widget.viewModel.deleteWatcher,
  );
  late final _changes = Listenable.merge([widget.viewModel, _deletes]);

  @override
  void dispose() {
    _deletes.dispose();
    super.dispose();
  }

  String _subscribedChat() =>
      widget.viewModel
          .chatSummariesFor(
            workspaceLocalId: widget.worktree.workspaceLocalId,
            worktreeLocalId: widget.worktree.localId,
          )
          .where((summary) => summary.chatId == widget.chatId)
          .firstOrNull
          ?.displayTitle ??
      'This chat';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    return ListenableBuilder(
      listenable: _changes,
      builder: (context, _) {
        final watchers = widget.viewModel.watchersForChat(
          widget.worktree.localId,
          widget.chatId,
          workspaceLocalId: widget.worktree.workspaceLocalId,
        );
        final subscribedChat = _subscribedChat();
        final now = widget.clock();
        return SingleChildScrollView(
          key: const ValueKey('chat-watchers-sheet'),
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            spacing: 12,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Semantics(
                  header: true,
                  child: Text(
                    'Chat watchers',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                  ),
                ),
              ),
              if (watchers.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  child: Text(
                    'No active watchers for this chat. Ask the agent to watch a build or pull request.',
                    key: const ValueKey('chat-watchers-empty'),
                    style: AppTypography.body.copyWith(
                      color: colors.foregroundSecondary,
                    ),
                  ),
                )
              else
                for (final watcher in watchers)
                  _WatcherCard(
                    key: ValueKey('chat-watcher-${watcher.id}'),
                    watcher: watcher,
                    presentation: ChatWatcherCardPresentation.from(
                      watcher,
                      subscribedChat: subscribedChat,
                      now: now,
                    ),
                    deletes: _deletes,
                  ),
            ],
          ),
        );
      },
    );
  }
}

class _WatcherCard extends StatelessWidget {
  const _WatcherCard({
    super.key,
    required this.watcher,
    required this.presentation,
    required this.deletes,
  });

  final RemoteWatcher watcher;
  final ChatWatcherCardPresentation presentation;
  final ChatWatcherDeleteController deletes;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final destructive = StatusColors.of(context).destructive;
    final id = watcher.id;
    final card = presentation;
    final secondary = AppTypography.bodySmall.copyWith(
      color: colors.foregroundSecondary,
    );
    final primary = AppTypography.bodySmall.copyWith(color: colors.foreground);
    final error = deletes.errorFor(id);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
      decoration: BoxDecoration(
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            card.title,
            style: AppTypography.sectionLabel.copyWith(
              color: colors.foreground,
            ),
          ),
          if (card.subtitle case final subtitle?)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(subtitle, style: secondary),
            ),
          const SizedBox(height: 8),
          for (final row in card.rows)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 12,
                children: [
                  SizedBox(
                    width: 116,
                    child: Text(row.label, style: secondary),
                  ),
                  Expanded(
                    child: Text(
                      row.value,
                      style: row.isError
                          ? primary.copyWith(color: destructive)
                          : primary,
                    ),
                  ),
                ],
              ),
            ),
          if (card.githubFilters.isNotEmpty ||
              card.githubSamples.isNotEmpty) ...[
            const SizedBox(height: 4),
            Wrap(
              key: ValueKey('chat-watcher-github-$id'),
              spacing: 12,
              runSpacing: 2,
              children: [
                for (final filter in card.githubFilters)
                  Text(filter, style: primary),
              ],
            ),
            for (final sample in card.githubSamples)
              Text(
                sample,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: secondary,
              ),
            if (card.githubOverflow > 0)
              Text('+${card.githubOverflow} more', style: secondary),
          ],
          if (card.followUp case final followUp?)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text.rich(
                TextSpan(
                  children: [
                    TextSpan(text: 'Follow-up ', style: secondary),
                    TextSpan(text: followUp, style: primary),
                  ],
                ),
              ),
            ),
          if (deletes.isConfirming(id))
            _DeleteConfirm(watcherId: id, deletes: deletes)
          else
            Align(
              alignment: Alignment.centerRight,
              child: CanopyButton(
                key: ValueKey('chat-watcher-delete-$id'),
                variant: CanopyButtonVariant.inline,
                foregroundColor: colors.foregroundSecondary,
                label: deletes.isPending(id) ? 'Deleting…' : 'Delete',
                loading: deletes.isPending(id),
                onPressed: () => deletes.arm(id),
              ),
            ),
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  error,
                  key: ValueKey('chat-watcher-error-$id'),
                  style: primary.copyWith(color: destructive),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _DeleteConfirm extends StatelessWidget {
  const _DeleteConfirm({required this.watcherId, required this.deletes});

  final String watcherId;
  final ChatWatcherDeleteController deletes;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final id = watcherId;
    final pending = deletes.isPending(id);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 4),
        CheckboxListTile(
          key: ValueKey('chat-watcher-notify-$id'),
          value: deletes.notifySubscriber,
          onChanged: pending
              ? null
              : (value) => deletes.setNotifySubscriber(value ?? false),
          controlAffinity: ListTileControlAffinity.leading,
          contentPadding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          title: Text(
            'Notify subscribing chat',
            style: AppTypography.body.copyWith(color: colors.foreground),
          ),
          subtitle: Text(
            'Sends a final watcher-deleted message to the chat that '
            'subscribed to this watcher.',
            style: AppTypography.bodySmall.copyWith(
              color: colors.foregroundSecondary,
            ),
          ),
        ),
        Wrap(
          alignment: WrapAlignment.end,
          spacing: 4,
          children: [
            CanopyButton(
              key: ValueKey('chat-watcher-cancel-$id'),
              variant: CanopyButtonVariant.inline,
              foregroundColor: colors.foregroundSecondary,
              label: 'Cancel',
              onPressed: pending ? null : deletes.cancel,
            ),
            CanopyButton(
              key: ValueKey('chat-watcher-confirm-delete-$id'),
              variant: CanopyButtonVariant.inline,
              foregroundColor: StatusColors.of(context).destructive,
              label: pending ? 'Deleting…' : 'Confirm delete',
              loading: pending,
              onPressed: () => unawaited(deletes.confirm(id)),
            ),
          ],
        ),
      ],
    );
  }
}
