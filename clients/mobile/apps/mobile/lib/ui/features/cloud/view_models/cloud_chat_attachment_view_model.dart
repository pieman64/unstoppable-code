import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/view_models/composer_draft_binding.dart';
import 'package:mobile/ui/features/cloud/view_models/client_ids.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_attachment_uploader.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';

/// Creates the destination before uploading a draft's files and sending.
/// The screen supplies current presentation state; this coordinator owns the
/// retry identity, session binding, uploads, and attachment handoff.
final class CloudChatAttachmentViewModel {
  CloudChatAttachmentViewModel({
    required this.session,
    required this.list,
    required this.attachments,
    required this.drafts,
  });

  final CloudChatViewModel session;
  final CloudChatsViewModel list;
  final ChatAttachmentController attachments;
  final ComposerDraftBinding drafts;
  final Map<String, String> _createIdsByWorkspace = {};
  bool _disposed = false;

  /// Keep each project's retry identity even after switching projects or
  /// removing every file. An unresolved project has no pending create.
  bool hasPendingCreateFor(String? workspaceId) =>
      _createIdsByWorkspace.containsKey(workspaceId);

  /// Binds both picks already staged and future picks to the created chat.
  Future<void> bindAttachments(String chatId) => attachments.uploadStaged(
    CloudChatAttachmentUploader(session.repository, chatId),
  );

  /// A live chat must never silently omit a file that is still staged.
  bool send(CloudSendPayload payload) {
    if (_disposed ||
        payload.text.trim().isEmpty ||
        session.state == null ||
        attachments.drafts.any(
          (draft) => draft.status != ChatAttachmentStatus.ready,
        )) {
      return false;
    }
    final uploaded = [
      for (final draft in attachments.takeForSend()) ?draft.uploaded,
    ];
    session.send(
      clientRequestId: randomUuidV4(),
      payload: payload.withAttachments(uploaded),
      clearComposerDraft: true,
    );
    return true;
  }

  Future<void> createAndSend({
    required String workspaceId,
    required CloudSendPayload selection,
    required Map<String, Object?>? pluginSelections,
    required bool Function() canBind,
    required void Function(CloudChatSummary chat) onBound,
    required CloudSendPayload Function() currentPayload,
    required void Function() onSent,
  }) async {
    final scope = list.scopeGeneration;
    bool active() => !_disposed && list.scopeGeneration == scope && canBind();
    final chat = await list.createChat(
      workspaceId,
      externalId: _createIdsByWorkspace.putIfAbsent(workspaceId, randomUuidV4),
      modelDefinitionId: selection.modelDefinitionId,
      autoModel: selection.autoModel,
      pluginSelections: pluginSelections,
    );
    if (chat == null || !active()) return;
    final chatId = chat.externalId;
    session.open(chatId, cursorEpoch: chat.coreAgentSessionId);
    drafts.rebind(CloudChatDraftTarget(chatId));
    _createIdsByWorkspace.remove(workspaceId);
    onBound(chat);
    await bindAttachments(chatId);
    // Uploads may outlive the route, account, or selected conversation.
    if (!active() ||
        session.state?.chatId != chatId ||
        list.isSelectionSavePending(chatId)) {
      return;
    }
    if (send(currentPayload())) onSent();
  }

  void dispose() => _disposed = true;
}
