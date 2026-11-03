/// Shared value types and identity helpers for `RemoteControlViewModel` and
/// its collaborators. The UI consumes public state through the view model's
/// re-exports.
library;

import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'remote_identity.dart';

export 'remote_identity.dart';
export 'snapshot_memo.dart';

typedef PendingChatAttachmentBatch = ({
  String commandId,
  int sessionGeneration,
  List<ChatAttachmentDraft> drafts,
  String? provisionalCreateCommandId,
  bool restoreImmediately,
});

/// Attachment drafts retained for a submitted send until its command settles.
final class PendingChatAttachments {
  const PendingChatAttachments({
    required this.key,
    required this.worktree,
    required this.sessionGeneration,
    required this.drafts,
    required this.provisionalCreateCommandId,
    required this.retainedAt,
    required this.restoreImmediately,
    this.submitting = false,
    this.sendFailed = false,
  });

  final RemoteChatKey key;

  /// Null for standalone chats.
  final RemoteWorktreeKey? worktree;
  final int sessionGeneration;
  final List<ChatAttachmentDraft> drafts;
  final String? provisionalCreateCommandId;
  final DateTime retainedAt;

  /// Restores into whichever chat of its worktree is shown: its send never
  /// reached a live owner, or its provisional chat was never created.
  final bool restoreImmediately;

  /// Owned by a send still awaiting its submission response.
  final bool submitting;

  /// The desktop rejected the send; restores when its own chat is shown.
  final bool sendFailed;

  PendingChatAttachments copyWith({
    bool? restoreImmediately,
    bool? sendFailed,
  }) => PendingChatAttachments(
    key: key,
    worktree: worktree,
    sessionGeneration: sessionGeneration,
    drafts: drafts,
    provisionalCreateCommandId: provisionalCreateCommandId,
    retainedAt: retainedAt,
    restoreImmediately: restoreImmediately ?? this.restoreImmediately,
    submitting: submitting,
    sendFailed: sendFailed ?? this.sendFailed,
  );

  PendingChatAttachmentBatch toBatch(String commandId) => (
    commandId: commandId,
    sessionGeneration: sessionGeneration,
    drafts: drafts,
    provisionalCreateCommandId: provisionalCreateCommandId,
    restoreImmediately: restoreImmediately,
  );
}
