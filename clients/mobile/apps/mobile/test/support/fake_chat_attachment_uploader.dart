import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';

/// Records uploads and deletes; [uploadHandler] scripts a slow or refused
/// upload. Without a handler each upload succeeds as `fake-<n>`.
class FakeChatAttachmentUploader implements ChatAttachmentUploader {
  final List<({String filename, String mediaType, int size})> uploadCalls = [];
  final List<String> deleteAttachmentCalls = [];
  Future<ChatAttachmentRef> Function(String filename)? uploadHandler;

  @override
  Future<ChatAttachmentRef> upload({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    uploadCalls.add((
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
    ));
    final handler = uploadHandler;
    if (handler != null) return handler(filename);
    return ChatAttachmentRef(
      attachmentId: 'fake-${uploadCalls.length}',
      filename: filename,
      mediaType: mediaType,
      size: bytes.length,
      contentSha256: 'a' * 64,
      storageKind: 'blob',
      source: '/fake',
    );
  }

  @override
  Future<void> delete(String attachmentId) async {
    deleteAttachmentCalls.add(attachmentId);
  }
}
