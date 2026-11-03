import 'package:flutter/foundation.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

import 'chat_attachment_stager.dart';

export 'chat_attachment_draft.dart';
export 'chat_attachment_stager.dart' show ChatAttachmentIssue;
export 'chat_attachment_uploader.dart';

/// Flutter facade over [ChatAttachmentStager]: the composer listens to it so
/// `ChatInput` stays stateless, mirroring the `VoiceDictationController`
/// split. The staging rules live in the pure Dart stager.
class ChatAttachmentController extends ChangeNotifier with DisposeSafeNotifier {
  ChatAttachmentController({
    required this._uploader,
    required this._picker,
    this.prepareUpload,
  });

  /// Null stages picks until [uploadStaged]; see [ChatAttachmentStager].
  final ChatAttachmentUploader? _uploader;
  final AttachmentPicker _picker;
  final Future<void> Function()? prepareUpload;

  late final _stager = ChatAttachmentStager(
    uploader: _uploader,
    picker: _picker,
    onChanged: notifyListenersSafe,
    prepareUpload: prepareUpload,
  );

  List<ChatAttachmentDraft> get drafts => _stager.drafts;
  bool get isEmpty => _stager.isEmpty;
  bool get hasUploadsInFlight => _stager.hasUploadsInFlight;
  bool get hasFailures => _stager.hasFailures;
  bool get canSend => _stager.canSend;
  bool get isPicking => _stager.isPicking;

  ChatAttachmentIssue? takeIssue() => _stager.takeIssue();

  /// See [ChatAttachmentStager.takeUploadError].
  String? takeUploadError() => _stager.takeUploadError();

  Future<void> addFromCamera() => _stager.addFromCamera();
  Future<void> addFromPhotoLibrary() => _stager.addFromPhotoLibrary();
  Future<void> addFiles() => _stager.addFiles();
  Future<void> recoverLostMedia() => _stager.recoverLostMedia();

  /// See [ChatAttachmentStager.uploadStaged].
  Future<void> uploadStaged(ChatAttachmentUploader uploader) =>
      _stager.uploadStaged(uploader);

  Future<void> retry(String localId) => _stager.retry(localId);
  Future<void> remove(String localId) => _stager.remove(localId);

  /// See [ChatAttachmentStager.takeForSend].
  List<ChatAttachmentDraft> takeForSend() => _stager.takeForSend();
  void restore(List<ChatAttachmentDraft> drafts) => _stager.restore(drafts);

  /// See [ChatAttachmentStager.restoreForNewSession].
  Future<void> restoreForNewSession(List<ChatAttachmentDraft> drafts) =>
      _stager.restoreForNewSession(drafts);

  /// See [ChatAttachmentStager.invalidateUploads].
  void invalidateUploads() => _stager.invalidateUploads();

  /// See [ChatAttachmentStager.discardAll]; safe to call after [dispose].
  Future<void> discardAll() => _stager.discardAll();

  @override
  void dispose() {
    _stager.dispose();
    super.dispose();
  }
}
