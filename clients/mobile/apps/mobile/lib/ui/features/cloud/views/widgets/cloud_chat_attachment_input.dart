import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/chat_attachment_input.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';

/// Cloud requires text even when a message carries attachments.
ChatInputAttachments cloudChatInputAttachmentsFor(
  ChatAttachmentController controller,
) {
  final shared = chatInputAttachmentsFor(controller);
  return ChatInputAttachments(
    listenable: shared.listenable,
    strip: shared.strip,
    hasAttachments: shared.hasAttachments,
    hasSendableAttachments: () => false,
    canAdd: shared.canAdd,
    canSend: shared.canSend,
    onAttach: shared.onAttach,
  );
}
