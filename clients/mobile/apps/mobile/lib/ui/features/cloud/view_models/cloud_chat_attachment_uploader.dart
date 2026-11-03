import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/services/cloud_api_service.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';

/// Uploads to one cloud chat's attachment store. A new chat's draft has no
/// chat yet, so its picks stay staged until the first send creates one.
final class CloudChatAttachmentUploader implements ChatAttachmentUploader {
  const CloudChatAttachmentUploader(this._repository, this.chatId);

  final CloudChatRepository _repository;
  final String chatId;

  @override
  Future<ChatAttachmentRef> upload({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    try {
      return await _repository.uploadChatAttachment(
        chatId,
        filename: filename,
        mediaType: mediaType,
        bytes: bytes,
      );
    } on CloudApiException catch (e) {
      throw ChatAttachmentUploadException(e.message);
    }
  }

  @override
  Future<void> delete(String attachmentId) =>
      _repository.deleteChatAttachment(chatId, attachmentId);
}
