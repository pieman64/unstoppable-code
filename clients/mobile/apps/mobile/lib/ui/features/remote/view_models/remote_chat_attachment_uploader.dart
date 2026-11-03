import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';

/// Uploads to the current Portal session's attachment store. The repository
/// resolves the session, so staged files follow the session it holds.
final class RemoteChatAttachmentUploader implements ChatAttachmentUploader {
  const RemoteChatAttachmentUploader(this._repository);

  final RemoteControlRepository _repository;

  @override
  Future<ChatAttachmentRef> upload({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    try {
      return await _repository.uploadChatAttachment(
        filename: filename,
        mediaType: mediaType,
        bytes: bytes,
      );
    } on RemoteControlException catch (e) {
      throw ChatAttachmentUploadException(e.message);
    }
  }

  @override
  Future<void> delete(String attachmentId) =>
      _repository.deleteChatAttachment(attachmentId);
}
