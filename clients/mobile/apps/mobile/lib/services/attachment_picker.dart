import 'dart:typed_data';

import 'package:mobile/data/models/chat_attachment.dart';

/// One file the user chose to attach, fully read into memory (uploads are
/// capped at 10 MiB, so buffering is acceptable).
class PickedAttachment {
  const PickedAttachment({
    required this.filename,
    required this.mediaType,
    required this.bytes,
  });

  final String filename;
  final String mediaType;
  final Uint8List bytes;
}

enum AttachmentPickerOutcome {
  picked,
  cancelled,
  permissionDenied,
  unavailable,
}

enum AttachmentPickerIssue { unavailable, tooLarge, tooMany }

class AttachmentPickResult {
  const AttachmentPickResult(
    this.outcome, [
    this.files = const [],
    this.issues = const {},
  ]);

  final AttachmentPickerOutcome outcome;
  final List<PickedAttachment> files;
  final Set<AttachmentPickerIssue> issues;

  static const cancelled = AttachmentPickResult(
    AttachmentPickerOutcome.cancelled,
  );
}

/// Platform-neutral file picking seam. The composer attaches through this
/// contract so `image_picker`/`file_picker` stay behind one adapter
/// (`PlatformAttachmentPicker`) and widget tests can script picks without a
/// platform channel — the same split as `SpeechRecognizer`.
abstract interface class AttachmentPicker {
  Future<AttachmentPickResult> pickFromCamera({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  });
  Future<AttachmentPickResult> pickFromPhotoLibrary({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  });
  Future<AttachmentPickResult> pickFiles({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  });
}

/// Optional Android recovery surface for picker results retained after the
/// activity was destroyed while a camera or gallery intent was open.
///
/// Kept separate from [AttachmentPicker] so non-platform test and host
/// implementations do not have to model an Android-only lifecycle concern.
abstract interface class RecoverableAttachmentPicker {
  Future<AttachmentPickResult> recoverLostMedia({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  });
}
