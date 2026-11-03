/// A file staged for a chat send, and its upload state. Pure Dart, so the
/// Remote Control engine can retain drafts across a send without depending
/// on the Flutter picker controller that stages them.
library;

import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';

/// [staged] holds a pick that waits for an uploader: a new chat's draft has
/// no chat to upload to until its first send creates one.
enum ChatAttachmentStatus { staged, uploading, ready, failed }

class ChatAttachmentDraft {
  const ChatAttachmentDraft({
    required this.localId,
    required this.filename,
    required this.mediaType,
    required this.bytes,
    required this.status,
    this.uploaded,
    this.error,
  });

  final String localId;
  final String filename;
  final String mediaType;
  final Uint8List bytes;
  final ChatAttachmentStatus status;
  final ChatAttachmentRef? uploaded;
  final String? error;

  bool get isImage => mediaType.startsWith('image/');

  ChatAttachmentDraft copyWith({
    String? localId,
    ChatAttachmentStatus? status,
    ChatAttachmentRef? uploaded,
    String? error,
    bool clearError = false,
    bool clearUploaded = false,
  }) => ChatAttachmentDraft(
    localId: localId ?? this.localId,
    filename: filename,
    mediaType: mediaType,
    bytes: bytes,
    status: status ?? this.status,
    uploaded: clearUploaded ? null : (uploaded ?? this.uploaded),
    error: clearError ? null : (error ?? this.error),
  );
}
