/// Pure Dart attachment staging for the chat composers, so the
/// pick-validate-upload rules run and are tested without Flutter. The
/// `ChatAttachmentController` facade adapts it to widget notifications.
library;

import 'dart:async';
import 'dart:convert';

import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/services/attachment_picker.dart';

import 'chat_attachment_draft.dart';
import 'chat_attachment_uploader.dart';

export 'chat_attachment_draft.dart';
export 'chat_attachment_uploader.dart';

/// Something the user has to see about a pick that could not be staged.
enum ChatAttachmentIssue {
  permissionDenied,
  unavailable,
  tooLarge,
  unsupportedType,
  tooMany,
}

/// Stages files for the next message: picks, uploads them to the server,
/// and hands the ready refs to the send path.
///
/// Platform work reaches the stager through ports: [AttachmentPicker] for
/// the device pickers and [ChatAttachmentUploader] for the upload endpoint.
/// Every visible change is reported through [onChanged].
///
/// Without an uploader, picks stay [ChatAttachmentStatus.staged] on the
/// strip until [uploadStaged] names where they go.
///
/// Uploads run one at a time (the server caps in-flight uploads per user).
/// A failed upload stays on the strip with Retry; the message cannot be sent
/// while any draft is uploading or failed, so the user never sends less than
/// they chose.
final class ChatAttachmentStager {
  ChatAttachmentStager({
    required this._uploader,
    required this._picker,
    required this.onChanged,
    this.prepareUpload,
  });

  ChatAttachmentUploader? _uploader;
  final AttachmentPicker _picker;
  final void Function() onChanged;
  final Future<void> Function()? prepareUpload;

  final List<ChatAttachmentDraft> _drafts = [];
  List<ChatAttachmentDraft> get drafts => List.unmodifiable(_drafts);

  bool get isEmpty => _drafts.isEmpty;
  bool get hasUploadsInFlight =>
      _drafts.any((d) => d.status == ChatAttachmentStatus.uploading);
  bool get hasFailures =>
      _drafts.any((d) => d.status == ChatAttachmentStatus.failed);
  bool get canSend => !hasUploadsInFlight && !hasFailures;

  /// Whether a pick or lost-media recovery is under way; its files can
  /// still arrive while the strip is empty.
  bool get isPicking => _picks > 0;

  ChatAttachmentIssue? _issue;
  ChatAttachmentIssue? takeIssue() {
    final issue = _issue;
    _issue = null;
    return issue;
  }

  String? _uploadError;

  /// The message for the most recent upload failure, consumed once.
  ///
  /// The failed chip keeps the same text for as long as it is on the strip
  /// (see [ChatAttachmentDraft.error]); this is the one-shot the screen drains
  /// into a snackbar so a failure that happens while the strip is scrolled out
  /// of view still tells the user what went wrong.
  String? takeUploadError() {
    final error = _uploadError;
    _uploadError = null;
    return error;
  }

  int _seq = 0;
  Future<void> _queue = Future.value();
  bool _disposed = false;
  bool _recoveringLostMedia = false;
  int _picks = 0;

  String _nextLocalId() => 'att-${++_seq}';

  Future<void> addFromCamera() =>
      _add((remaining) => _picker.pickFromCamera(maxFiles: remaining));
  Future<void> addFromPhotoLibrary() =>
      _add((remaining) => _picker.pickFromPhotoLibrary(maxFiles: remaining));
  Future<void> addFiles() =>
      _add((remaining) => _picker.pickFiles(maxFiles: remaining));

  Future<void> recoverLostMedia() async {
    if (_recoveringLostMedia) return;
    final RecoverableAttachmentPicker picker;
    if (_picker case final RecoverableAttachmentPicker recoverable) {
      picker = recoverable;
    } else {
      return;
    }
    _recoveringLostMedia = true;
    try {
      await _add((remaining) => picker.recoverLostMedia(maxFiles: remaining));
    } finally {
      _recoveringLostMedia = false;
    }
  }

  Future<void> _add(
    Future<AttachmentPickResult> Function(int remaining) pick,
  ) async {
    final remaining = kChatAttachmentsMaxPerMessage - _drafts.length;
    if (remaining <= 0) {
      _issue = ChatAttachmentIssue.tooMany;
      _notify();
      return;
    }
    final AttachmentPickResult result;
    _picks++;
    try {
      result = await pick(remaining);
    } finally {
      _picks--;
    }
    if (_disposed) return;
    switch (result.outcome) {
      case AttachmentPickerOutcome.cancelled:
        return;
      case AttachmentPickerOutcome.permissionDenied:
        _issue = ChatAttachmentIssue.permissionDenied;
        _notify();
        return;
      case AttachmentPickerOutcome.unavailable:
        _issue = ChatAttachmentIssue.unavailable;
        _notify();
        return;
      case AttachmentPickerOutcome.picked:
        break;
    }
    if (result.issues.contains(AttachmentPickerIssue.unavailable)) {
      _issue = ChatAttachmentIssue.unavailable;
    } else if (result.issues.contains(AttachmentPickerIssue.tooMany)) {
      _issue = ChatAttachmentIssue.tooMany;
    } else if (result.issues.contains(AttachmentPickerIssue.tooLarge)) {
      _issue = ChatAttachmentIssue.tooLarge;
    }
    final pending = <ChatAttachmentDraft>[];
    for (final file in result.files) {
      if (_drafts.length + pending.length >= kChatAttachmentsMaxPerMessage) {
        _issue = ChatAttachmentIssue.tooMany;
        break;
      }
      if (file.mediaType.isEmpty ||
          !kChatAttachmentMediaTypes.contains(file.mediaType)) {
        _issue = ChatAttachmentIssue.unsupportedType;
        continue;
      }
      if (file.bytes.length > kChatAttachmentMaxBytes) {
        _issue = ChatAttachmentIssue.tooLarge;
        continue;
      }
      pending.add(
        ChatAttachmentDraft(
          localId: _nextLocalId(),
          filename: _safeFilename(file.filename),
          mediaType: file.mediaType,
          bytes: file.bytes,
          status: _uploader == null
              ? ChatAttachmentStatus.staged
              : ChatAttachmentStatus.uploading,
        ),
      );
    }
    _drafts.addAll(pending);
    _notify();
    if (_uploader == null) return;
    await Future.wait(pending.map((draft) => _enqueueUpload(draft.localId)));
  }

  /// Uploads the picks staged while there was no uploader to [uploader],
  /// which later uploads also use. Completes once each upload has settled;
  /// [canSend] then says whether every file is ready.
  Future<void> uploadStaged(ChatAttachmentUploader uploader) async {
    _uploader = uploader;
    final staged = <String>[];
    for (final (index, draft) in _drafts.indexed) {
      if (draft.status != ChatAttachmentStatus.staged) continue;
      _drafts[index] = draft.copyWith(status: ChatAttachmentStatus.uploading);
      staged.add(draft.localId);
    }
    if (staged.isEmpty) return;
    _notify();
    await Future.wait(staged.map(_enqueueUpload));
  }

  /// Characters Windows forbids in a filename, plus the C0 range and DEL.
  /// The desktop's `readRef` rejects a ref carrying any of them, so a name
  /// that survives the picker but not the parser has to be repaired here
  /// rather than failing the send at the other end.
  static final RegExp _unsafeFilenameCharacters = RegExp(
    r'[<>:"|?*\\/\u0000-\u001f\u007f]',
  );

  /// Windows reserved device stems, matched case-insensitively against the
  /// stem before the first dot (the desktop rejects `NUL`, `NUL.txt`, ...).
  static final RegExp _reservedDeviceStem = RegExp(
    r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$',
    caseSensitive: false,
  );

  /// Normalizes a picked filename into one the desktop parser accepts.
  ///
  /// Mirrors `readRef` in `portal-chat-attachments.ts`: forbidden and control
  /// characters become `_`, trailing dots and spaces are stripped (Windows
  /// silently drops them), a reserved device stem gets a portable prefix, and an
  /// over-long name is truncated through the stem so the extension — which
  /// the desktop cross-checks against the declared media type — survives.
  static String _safeFilename(String filename) {
    var named = filename.replaceAll(_unsafeFilenameCharacters, '_').trim();
    named = _stripTrailingDotsAndSpaces(named);
    if (named.isEmpty) named = 'attachment';
    final dot = named.indexOf('.');
    final stem = dot == -1 ? named : named.substring(0, dot);
    final normalizedStem = _normalizePortableStem(stem);
    if (_reservedDeviceStem.hasMatch(stem) ||
        _reservedDeviceStem.hasMatch(normalizedStem)) {
      named = 'file-$named';
    }
    named = _truncatePreservingExtension(named);
    named = _stripTrailingDotsAndSpaces(named);
    return named.isEmpty ? 'attachment' : named;
  }

  static String _stripTrailingDotsAndSpaces(String value) {
    var end = value.length;
    while (end > 0 && (value[end - 1] == '.' || value[end - 1] == ' ')) {
      end -= 1;
    }
    return value.substring(0, end);
  }

  /// Mirrors `normalizeCloudAttachmentFilenameStem` in the shared protocol.
  static String _normalizePortableStem(String value) {
    return value
        .trim()
        .toLowerCase()
        .replaceAll(RegExp('[^a-z0-9]+'), '-')
        .replaceAll(RegExp(r'(^-|-$)'), '');
  }

  static String _truncatePreservingExtension(String named) {
    const max = kChatAttachmentFilenameMaxBytes;
    if (utf8.encode(named).length <= max) return named;
    final dot = named.lastIndexOf('.');
    final extension = dot > 0 ? named.substring(dot) : '';
    final extensionBytes = utf8.encode(extension).length;
    // A pathological "extension" that would leave no stem is not worth
    // preserving; fall back to a plain head truncation.
    if (extension.isEmpty || extensionBytes >= max) {
      return _truncateUtf8(named, max);
    }
    return _truncateUtf8(named.substring(0, dot), max - extensionBytes) +
        extension;
  }

  static String _truncateUtf8(String value, int maxBytes) {
    var bytes = 0;
    final result = StringBuffer();
    for (final rune in value.runes) {
      final character = String.fromCharCode(rune);
      final characterBytes = utf8.encode(character).length;
      if (bytes + characterBytes > maxBytes) break;
      result.write(character);
      bytes += characterBytes;
    }
    return result.toString();
  }

  Future<void> _enqueueUpload(String localId) {
    final run = _queue.then((_) => _upload(localId));
    _queue = run.catchError((_) {});
    return run;
  }

  Future<void> _upload(String localId) async {
    final index = _drafts.indexWhere((d) => d.localId == localId);
    final uploader = _uploader;
    if (index == -1 || uploader == null) return;
    final draft = _drafts[index];
    try {
      await prepareUpload?.call();
      if (_disposed || _drafts.every((draft) => draft.localId != localId)) {
        return;
      }
      final uploaded = await uploader.upload(
        filename: draft.filename,
        mediaType: draft.mediaType,
        bytes: draft.bytes,
      );
      if (_drafts.every((draft) => draft.localId != localId)) {
        await _deleteAttachmentRef(uploader, uploaded);
        return;
      }
      _replace(
        localId,
        (d) => d.copyWith(
          status: ChatAttachmentStatus.ready,
          uploaded: uploaded,
          clearError: true,
        ),
      );
    } on ChatAttachmentUploadException catch (e) {
      _fail(localId, _uploadFailureMessage(e.reason, draft.filename));
    } catch (_) {
      _fail(localId, _uploadFailureMessage(null, draft.filename));
    }
  }

  void _fail(String localId, String message) {
    _uploadError = message;
    if (_disposed) return;
    final index = _drafts.indexWhere((d) => d.localId == localId);
    if (index != -1) {
      _drafts[index] = _drafts[index].copyWith(
        status: ChatAttachmentStatus.failed,
        error: message,
      );
    }
    // Notify even when the draft is gone (the user removed the chip while it
    // was uploading) so the one-shot still reaches the screen.
    _notify();
  }

  /// Turns a server refusal into copy that points at what the user can do.
  /// The reasons are matched on the server's wording rather than a code
  /// because the upload endpoint answers with a plain message.
  static String _uploadFailureMessage(String? reason, String filename) {
    final lowered = reason?.toLowerCase() ?? '';
    if (lowered.contains('too large')) {
      return 'Attach files of 10 MB or smaller.';
    }
    if (lowered.contains('media type')) {
      return 'Attach images, PDFs, Office documents, or text files.';
    }
    if (lowered.contains('too many attachment')) {
      return 'Wait for the current uploads to finish, then try again.';
    }
    return "Couldn't upload $filename. Retry or remove it.";
  }

  void _replace(
    String localId,
    ChatAttachmentDraft Function(ChatAttachmentDraft) update,
  ) {
    if (_disposed) return;
    final index = _drafts.indexWhere((d) => d.localId == localId);
    if (index == -1) return;
    _drafts[index] = update(_drafts[index]);
    _notify();
  }

  Future<void> retry(String localId) async {
    final index = _drafts.indexWhere((d) => d.localId == localId);
    if (index == -1 || _drafts[index].status != ChatAttachmentStatus.failed) {
      return;
    }
    _drafts[index] = _drafts[index].copyWith(
      status: ChatAttachmentStatus.uploading,
      clearError: true,
    );
    _notify();
    await _enqueueUpload(localId);
  }

  Future<void> remove(String localId) async {
    final index = _drafts.indexWhere((d) => d.localId == localId);
    if (index == -1) return;
    final draft = _drafts.removeAt(index);
    _notify();
    await _deleteUploaded(draft);
  }

  Future<void> _deleteUploaded(ChatAttachmentDraft draft) async {
    final uploaded = draft.uploaded;
    final uploader = _uploader;
    if (uploaded == null || uploader == null) return;
    await _deleteAttachmentRef(uploader, uploaded);
  }

  Future<void> _deleteAttachmentRef(
    ChatAttachmentUploader uploader,
    ChatAttachmentRef uploaded,
  ) async {
    try {
      await uploader.delete(uploaded.attachmentId);
    } catch (_) {
      // The server sweep reclaims orphans; a failed delete is not user-facing.
    }
  }

  /// Ready drafts for the outgoing message. Clears the strip; the caller
  /// [restore]s them if the send is rejected.
  List<ChatAttachmentDraft> takeForSend() {
    final ready = _drafts
        .where((d) => d.status == ChatAttachmentStatus.ready)
        .toList(growable: false);
    _drafts.removeWhere((d) => d.status == ChatAttachmentStatus.ready);
    _notify();
    return ready;
  }

  void restore(List<ChatAttachmentDraft> drafts) {
    _restore(drafts, reupload: false);
  }

  /// Restores a failed send after the Portal session changed.
  ///
  /// Attachment references are session-scoped, but the retained draft still
  /// owns the picked bytes. Clear the stale references and upload those bytes
  /// into the active session before allowing another send.
  Future<void> restoreForNewSession(List<ChatAttachmentDraft> drafts) async {
    final localIds = _restore(drafts, reupload: true);
    await Future.wait(localIds.map(_enqueueUpload));
  }

  List<String> _restore(
    List<ChatAttachmentDraft> drafts, {
    required bool reupload,
  }) {
    final restored = drafts
        .take(kChatAttachmentsMaxPerMessage)
        .map(
          (draft) => draft.copyWith(
            localId: _nextLocalId(),
            status: reupload ? ChatAttachmentStatus.uploading : null,
            clearUploaded: reupload,
            clearError: reupload,
          ),
        )
        .toList(growable: false);
    final currentCapacity = kChatAttachmentsMaxPerMessage - restored.length;
    final overflow = <ChatAttachmentDraft>[
      ...drafts.skip(kChatAttachmentsMaxPerMessage),
      if (_drafts.length > currentCapacity) ..._drafts.sublist(currentCapacity),
    ];
    if (_drafts.length > currentCapacity) {
      _drafts.removeRange(currentCapacity, _drafts.length);
    }
    _drafts.insertAll(0, restored);
    if (overflow.isNotEmpty) {
      _issue = ChatAttachmentIssue.tooMany;
      unawaited(Future.wait(overflow.map(_deleteUploaded)));
    }
    _notify();
    return reupload
        ? restored.map((draft) => draft.localId).toList(growable: false)
        : const [];
  }

  /// Keeps every file's bytes but drops its upload, after the Portal session
  /// changed or the desktop stopped announcing attachments: the old
  /// references must not be sent. Each uploading or ready draft becomes a
  /// failed chip with Retry under a new local id, so an upload still queued
  /// or running for it is skipped and its late reference is deleted.
  void invalidateUploads() {
    final stale = <ChatAttachmentDraft>[];
    for (final (index, draft) in _drafts.indexed) {
      if (draft.status == ChatAttachmentStatus.failed) continue;
      stale.add(draft);
      _drafts[index] = draft.copyWith(
        localId: _nextLocalId(),
        status: ChatAttachmentStatus.failed,
        error: _uploadFailureMessage(null, draft.filename),
        clearUploaded: true,
      );
    }
    if (stale.isEmpty) return;
    _notify();
    unawaited(Future.wait(stale.map(_deleteUploaded)));
  }

  /// Deletes every staged upload and empties the strip. Safe to call after
  /// [dispose]: the owning screen discards on the way out, and the blobs must
  /// still be reclaimed once the stager is gone.
  Future<void> discardAll() async {
    final drafts = List<ChatAttachmentDraft>.from(_drafts);
    _drafts.clear();
    _notify();
    for (final draft in drafts) {
      await _deleteUploaded(draft);
    }
  }

  /// Notifies unless already disposed. Uploads and deletes outlive the
  /// screen that staged them (see [discardAll]), so a late completion must
  /// not reach a listener that is gone.
  void _notify() {
    if (_disposed) return;
    onChanged();
  }

  /// Stops notifying and ignores late upload results. In-flight uploads and
  /// [discardAll] still run to completion so their blobs are reclaimed.
  void dispose() {
    _disposed = true;
  }
}
