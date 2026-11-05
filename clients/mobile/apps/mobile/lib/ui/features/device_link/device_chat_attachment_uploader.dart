import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/device_link/chats/attachments.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_uploader.dart';

/// Stores staged files in [scope]'s attachments folder on the computer. The
/// ref's [ChatAttachmentRef.attachmentId] is the computer's path, which the
/// send names in `attachmentPaths`.
final class DeviceChatAttachmentUploader implements ChatAttachmentUploader {
  const DeviceChatAttachmentUploader(this._attachments, this._scope);

  final DeviceChatAttachments _attachments;
  final DeviceChatRef _scope;

  @override
  Future<ChatAttachmentRef> upload({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  }) async {
    final DeviceChatAttachment stored;
    try {
      stored = await _attachments.import(_scope, filename, bytes);
    } on DeviceLinkException catch (e) {
      throw ChatAttachmentUploadException(e.message);
    }
    return ChatAttachmentRef(
      attachmentId: stored.path,
      filename: stored.filename,
      mediaType: mediaType,
      size: stored.size,
      contentSha256: '',
      storageKind: 'path',
      source: 'computer',
    );
  }

  /// The stored name is the last segment of the computer's path.
  @override
  Future<void> delete(String attachmentId) =>
      _attachments.delete(_scope, attachmentId.split(RegExp(r'[/\\]')).last);
}
