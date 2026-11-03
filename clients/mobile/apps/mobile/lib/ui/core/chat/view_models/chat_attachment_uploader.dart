/// The upload endpoint behind [ChatAttachmentStager]. Each chat feature
/// adapts its own transport to it, so the staging rules stay shared.
library;

import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';

/// Uploads staged files to one chat's attachment store and removes uploads
/// that were never sent.
abstract interface class ChatAttachmentUploader {
  /// Returns the ready ref to send as `cloudAttachments`. Throws
  /// [ChatAttachmentUploadException] when the server refuses the file.
  Future<ChatAttachmentRef> upload({
    required String filename,
    required String mediaType,
    required Uint8List bytes,
  });

  /// Removes a not-yet-sent upload. Callers treat failures as best-effort:
  /// the server sweep reclaims orphans.
  Future<void> delete(String attachmentId);
}

/// An upload the server refused. [reason] is its message, which the stager
/// turns into copy that points at what the user can do.
class ChatAttachmentUploadException implements Exception {
  const ChatAttachmentUploadException(this.reason);

  final String? reason;

  @override
  String toString() => 'ChatAttachmentUploadException: $reason';
}
