import 'dart:async';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';

/// The composer presentation of [controller]: its strip, the per-message
/// limit, the send gate, and the `+` sheet's pick sources.
ChatInputAttachments chatInputAttachmentsFor(
  ChatAttachmentController controller,
) => ChatInputAttachments(
  listenable: controller,
  strip: AttachmentStrip(controller: controller),
  hasAttachments: () => controller.drafts.isNotEmpty,
  canAdd: () => controller.drafts.length < kChatAttachmentsMaxPerMessage,
  canSend: () => controller.canSend,
  onAttach: (source) => unawaited(switch (source) {
    ChatAttachmentSource.camera => controller.addFromCamera(),
    ChatAttachmentSource.photoLibrary => controller.addFromPhotoLibrary(),
    ChatAttachmentSource.files => controller.addFiles(),
  }),
);

/// The snackbar for a pick that could not be staged. Each line points at
/// what the user can do rather than restating the refusal; [tooMany] lets a
/// surface that also counts file mentions say so.
String chatAttachmentIssueMessage(
  ChatAttachmentIssue issue, {
  String tooMany = 'Attach up to 8 files per message.',
}) => switch (issue) {
  ChatAttachmentIssue.permissionDenied =>
    'Allow camera and photo access in Settings to attach files.',
  ChatAttachmentIssue.unavailable => "This device can't pick files right now.",
  ChatAttachmentIssue.tooLarge => 'Attach files of 10 MB or smaller.',
  ChatAttachmentIssue.unsupportedType =>
    'Attach images, PDFs, Office documents, or text files.',
  ChatAttachmentIssue.tooMany => tooMany,
};
