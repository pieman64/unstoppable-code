import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';

/// Keeps remote draft keys and provisional-chat recovery out of the screen.
final class RemoteChatDraftCoordinator {
  RemoteChatDraftCoordinator({
    required this.store,
    required this.binding,
    required this.composerText,
  });

  final ChatDraftStore store;
  final ComposerDraftBinding binding;
  final String Function() composerText;

  bool sentFromNewChat = false;

  /// The newest unprojected standalone chat with an unconfirmed first send.
  String? firstUnprojectedChat(
    Iterable<String> unsentChatIds,
    bool Function(String chatId) isProjected,
  ) => unsentChatIds.where((id) => !isProjected(id)).firstOrNull;

  /// Provisional worktree tabs that still need to be shown for unsent text.
  List<String> adoptableChatIds({
    required Iterable<String> unsentChatIds,
    required Set<String> pendingChatIds,
    required Set<String> projectedChatIds,
    required bool isLoading,
  }) => isLoading
      ? const []
      : [
          for (final id in unsentChatIds)
            if (!pendingChatIds.contains(id) && !projectedChatIds.contains(id))
              id,
        ];

  DraftTarget? targetFor({
    required RemoteWorkspace? workspace,
    required RemoteWorktree? worktree,
    required RemoteStandaloneChat? standaloneChat,
    required String? chatId,
  }) {
    // A tree workspace's new chat owns the draft only until its worktree
    // exists; after that the text belongs to that worktree, not to the
    // workspace's next new chat.
    if (workspace case final current?
        when !sentFromNewChat && worktree == null) {
      return RemoteNewChatDraftTarget(current.localId);
    }
    if (worktree != null) {
      return RemoteWorktreeChatDraftTarget(
        workspaceLocalId: worktree.workspaceLocalId,
        worktreeLocalId: worktree.localId,
        chatId: chatId,
      );
    }
    if (standaloneChat != null) {
      return RemoteStandaloneChatDraftTarget(standaloneChat.localId);
    }
    return null;
  }

  /// Carries text from the new-chat composer unless the recovered chat has
  /// its own draft already.
  void resumeUnsentFirstChat(DraftTarget chat) {
    sentFromNewChat = true;
    if (binding.target != null && store.draftFor(chat).isEmpty) {
      binding.rebind(chat);
    } else {
      binding.bind(chat);
    }
  }

  /// Moves a new-chat draft into the worktree created for it, and a
  /// worktree's no-chat draft into its first resolved tab.
  void switchTarget(DraftTarget? next) {
    if ((binding.target, next) case (
      RemoteNewChatDraftTarget(:final workspaceLocalId),
      RemoteWorktreeChatDraftTarget() && final to,
    ) when to.workspaceLocalId == workspaceLocalId) {
      binding.rebind(to);
      return;
    }
    if ((binding.target, next)
        case (
          RemoteWorktreeChatDraftTarget(
            chatId: null,
            :final workspaceLocalId,
            :final worktreeLocalId,
          ),
          RemoteWorktreeChatDraftTarget(chatId: _?) && final to,
        )
        when to.workspaceLocalId == workspaceLocalId &&
            to.worktreeLocalId == worktreeLocalId &&
            composerText().isNotEmpty &&
            store.draftFor(to).isEmpty) {
      binding.rebind(to);
      return;
    }
    binding.bind(next);
  }

  /// Moves a failed provisional tab's draft to the selected reachable tab.
  void preserveFailedTabDraft({
    required RemoteWorktree? worktree,
    required String failedChatId,
    required DraftTarget? next,
  }) {
    if (worktree == null) return;
    final from = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: worktree.workspaceLocalId,
      worktreeLocalId: worktree.localId,
      chatId: failedChatId,
    );
    final typed = store.draftFor(from);
    if (typed.isEmpty || next == null || next == from) return;
    final saved = store.draftFor(next);
    store.setDraft(next, saved.isEmpty ? typed : '$typed\n$saved');
    store.setDraft(from, '');
  }
}
