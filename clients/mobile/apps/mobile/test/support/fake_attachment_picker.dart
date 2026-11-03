import 'dart:async';
import 'dart:typed_data';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/services/attachment_picker.dart';

class FakeAttachmentPicker
    implements AttachmentPicker, RecoverableAttachmentPicker {
  AttachmentPickResult next = AttachmentPickResult.cancelled;
  AttachmentPickResult lost = AttachmentPickResult.cancelled;
  int cameraCalls = 0;
  int libraryCalls = 0;
  int filesCalls = 0;
  int recoverLostMediaCalls = 0;

  /// When set, the next pick or recovery waits for it instead of returning
  /// [next] or [lost], as the platform picker does while it reads files.
  Completer<AttachmentPickResult>? held;

  Future<AttachmentPickResult> _result(AttachmentPickResult value) {
    final pick = held;
    held = null;
    return pick?.future ?? Future.value(value);
  }

  /// A picked file whose bytes are zero-filled — decodable by nothing, which
  /// is what most of this suite wants. Pass [bytes] (for example
  /// `tinyPngBytes`) when the test needs the genuine decode path, such as the
  /// transcript's image preview.
  static PickedAttachment file(
    String name, {
    String mediaType = 'image/png',
    int size = 3,
    Uint8List? bytes,
  }) => PickedAttachment(
    filename: name,
    mediaType: mediaType,
    bytes: bytes ?? Uint8List(size),
  );

  @override
  Future<AttachmentPickResult> pickFromCamera({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    cameraCalls += 1;
    return _result(next);
  }

  @override
  Future<AttachmentPickResult> pickFromPhotoLibrary({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    libraryCalls += 1;
    return _result(next);
  }

  @override
  Future<AttachmentPickResult> pickFiles({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    filesCalls += 1;
    return _result(next);
  }

  @override
  Future<AttachmentPickResult> recoverLostMedia({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    recoverLostMediaCalls += 1;
    return _result(lost);
  }
}
