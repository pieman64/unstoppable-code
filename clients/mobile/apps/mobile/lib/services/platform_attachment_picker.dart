import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart'
    show MissingPluginException, PlatformException;
import 'package:image_picker/image_picker.dart';
import 'package:mobile/data/models/chat_attachment.dart';

import 'attachment_picker.dart';

/// Resolves the allowlisted media type for a picked file.
///
/// The desktop rejects a ref whose `mediaType` differs from the media type
/// derived from the filename extension, so an unrecognized extension must be
/// rejected even when the platform reports an otherwise allowlisted type.
String? resolvePickedMediaType({String? reported, required String filename}) {
  return chatAttachmentMediaTypeForFilename(filename);
}

/// Extensions offered in the document picker; the media-type allowlist the
/// controller enforces is the authority, this only narrows the browser.
const List<String> kAttachmentPickerExtensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'pdf',
  'docx',
  'xlsx',
  'txt',
  'md',
  'csv',
  'html',
  'json',
];

/// The `FilePicker.pickFiles` surface this adapter depends on.
typedef FilePickerDelegate =
    Future<List<PlatformFile>> Function({
      required FileType type,
      required List<String>? allowedExtensions,
    });

Future<List<PlatformFile>> _pickFilesWithFilePicker({
  required FileType type,
  required List<String>? allowedExtensions,
}) => FilePicker.pickFiles(type: type, allowedExtensions: allowedExtensions);

/// `image_picker` for camera and photo library, `file_picker` for documents.
///
/// No `imageQuality` is passed: any value below 100 makes Android re-encode
/// the pick as JPEG (PNG only when it has alpha) while keeping the original
/// `.png`/`.webp`/`.gif` name, so the bytes and the extension would disagree
/// and the desktop — which cross-checks the declared media type against the
/// filename extension — would reject the ref. The adapter checks metadata
/// before reading and enforces the same 10 MiB cap again while buffering.
///
/// Files with a media type outside the allowlist are returned with
/// [AttachmentPickerOutcome.picked] and an empty list is NOT used to hide
/// them: the controller reports them so the user learns why (design: an
/// unsupported HEIC must not vanish silently). Unsupported files carry
/// `mediaType == ''` and the controller rejects them with a message.
final class PlatformAttachmentPicker
    implements AttachmentPicker, RecoverableAttachmentPicker {
  PlatformAttachmentPicker({
    ImagePicker? imagePicker,
    FilePickerDelegate? filePicker,
    this.onFilesRead,
  }) : _imagePicker = imagePicker ?? ImagePicker(),
       _filePicker = filePicker ?? _pickFilesWithFilePicker;

  final ImagePicker _imagePicker;

  /// Called after reading finishes, including rejected/overflow picker copies.
  final Future<void> Function(Iterable<String> paths)? onFilesRead;

  Future<void> _recordFiles(Iterable<String> paths) async {
    try {
      await onFilesRead?.call(paths);
    } catch (_) {
      // Cache bookkeeping must not prevent attaching a successfully read file.
    }
  }

  /// `FilePicker.pickFiles` is static, so the document path is injected the
  /// same way `ImagePicker` is: tests script it without a platform channel.
  final FilePickerDelegate _filePicker;

  Future<({PickedAttachment? attachment, bool tooLarge, bool unavailable})>
  _fromXFile(XFile file) async {
    final filename = file.name.isEmpty ? 'photo.jpg' : file.name;
    try {
      if (await file.length() > kChatAttachmentMaxBytes) {
        return (attachment: null, tooLarge: true, unavailable: false);
      }
      final read = await _readBoundedBytes(
        file.openRead(0, kChatAttachmentMaxBytes + 1),
      );
      if (read.tooLarge) {
        return (attachment: null, tooLarge: true, unavailable: false);
      }
      return (
        attachment: PickedAttachment(
          filename: filename,
          mediaType:
              resolvePickedMediaType(
                reported: file.mimeType,
                filename: filename,
              ) ??
              '',
          bytes: read.bytes,
        ),
        tooLarge: false,
        unavailable: false,
      );
    } on Exception {
      return (attachment: null, tooLarge: false, unavailable: true);
    }
  }

  @override
  Future<AttachmentPickResult> pickFromCamera({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    if (maxFiles <= 0) return _tooManyResult;
    try {
      final file = await _imagePicker.pickImage(
        source: ImageSource.camera,
        requestFullMetadata: false,
      );
      if (file == null) return AttachmentPickResult.cancelled;
      final read = await _fromXFile(file);
      await _recordFiles([file.path]);
      if (read.unavailable) {
        return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
      }
      return AttachmentPickResult(
        AttachmentPickerOutcome.picked,
        [?read.attachment],
        {if (read.tooLarge) AttachmentPickerIssue.tooLarge},
      );
    } on PlatformException catch (e) {
      return AttachmentPickResult(_outcomeForPlatformError(e.code));
    } on MissingPluginException {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    }
  }

  @override
  Future<AttachmentPickResult> pickFromPhotoLibrary({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    if (maxFiles <= 0) return _tooManyResult;
    try {
      final files = await _imagePicker.pickMultiImage(
        requestFullMetadata: false,
        limit: maxFiles,
      );
      return await _resultFromXFiles(files, maxFiles: maxFiles);
    } on PlatformException catch (e) {
      return AttachmentPickResult(_outcomeForPlatformError(e.code));
    } on MissingPluginException {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    }
  }

  @override
  Future<AttachmentPickResult> recoverLostMedia({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    if (maxFiles <= 0) return _tooManyResult;
    try {
      final response = await _imagePicker.retrieveLostData();
      if (response.isEmpty) return AttachmentPickResult.cancelled;
      if (response.exception case final exception?) {
        return AttachmentPickResult(_outcomeForPlatformError(exception.code));
      }
      if (response.type == RetrieveType.video) {
        return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
      }
      final files = response.files ?? [?response.file];
      return await _resultFromXFiles(files, maxFiles: maxFiles);
    } on PlatformException catch (e) {
      return AttachmentPickResult(_outcomeForPlatformError(e.code));
    } on MissingPluginException {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    } on UnimplementedError {
      // `retrieveLostData` is Android-only. Other platforms have no retained
      // activity result to recover.
      return AttachmentPickResult.cancelled;
    }
  }

  Future<AttachmentPickResult> _resultFromXFiles(
    List<XFile> files, {
    required int maxFiles,
  }) async {
    if (files.isEmpty) return AttachmentPickResult.cancelled;
    final picked = <PickedAttachment>[];
    var tooLarge = false;
    var unavailable = false;
    for (final file in files.take(maxFiles)) {
      final read = await _fromXFile(file);
      if (read.tooLarge) {
        tooLarge = true;
      } else if (read.unavailable) {
        unavailable = true;
      } else if (read.attachment case final attachment?) {
        picked.add(attachment);
      }
    }
    await _recordFiles(files.map((file) => file.path));
    if (picked.isEmpty && unavailable && !tooLarge) {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    }
    return AttachmentPickResult(AttachmentPickerOutcome.picked, picked, {
      if (unavailable) AttachmentPickerIssue.unavailable,
      if (files.length > maxFiles) AttachmentPickerIssue.tooMany,
      if (tooLarge) AttachmentPickerIssue.tooLarge,
    });
  }

  @override
  Future<AttachmentPickResult> pickFiles({
    int maxFiles = kChatAttachmentsMaxPerMessage,
  }) async {
    if (maxFiles <= 0) return _tooManyResult;
    final List<PlatformFile> result;
    try {
      result = await _filePicker(
        type: FileType.custom,
        allowedExtensions: kAttachmentPickerExtensions,
      );
    } on PlatformException catch (e) {
      return AttachmentPickResult(_outcomeForPlatformError(e.code));
    } on MissingPluginException {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    }
    if (result.isEmpty) {
      return AttachmentPickResult.cancelled;
    }
    final picked = <PickedAttachment>[];
    var tooLarge = false;
    var unavailable = false;
    for (final file in result.take(maxFiles)) {
      if ((file.lengthSync() ?? 0) > kChatAttachmentMaxBytes) {
        tooLarge = true;
        continue;
      }
      final Uint8List? bytes;
      try {
        final read = await _readPlatformFile(file);
        if (read.tooLarge) {
          tooLarge = true;
          continue;
        }
        bytes = read.bytes;
      } catch (_) {
        unavailable = true;
        continue;
      }
      if (bytes == null) {
        unavailable = true;
        continue;
      }
      if (bytes.length > kChatAttachmentMaxBytes) {
        tooLarge = true;
        continue;
      }
      picked.add(
        PickedAttachment(
          filename: file.name,
          mediaType:
              resolvePickedMediaType(reported: null, filename: file.name) ?? '',
          bytes: bytes,
        ),
      );
    }
    await _recordFiles(result.map((file) => file.path).whereType<String>());
    if (picked.isEmpty && unavailable && !tooLarge) {
      return const AttachmentPickResult(AttachmentPickerOutcome.unavailable);
    }
    return AttachmentPickResult(AttachmentPickerOutcome.picked, picked, {
      if (unavailable) AttachmentPickerIssue.unavailable,
      if (tooLarge) AttachmentPickerIssue.tooLarge,
      if (result.length > maxFiles) AttachmentPickerIssue.tooMany,
    });
  }

  static const _tooManyResult = AttachmentPickResult(
    AttachmentPickerOutcome.picked,
    [],
    {AttachmentPickerIssue.tooMany},
  );

  Future<({Uint8List? bytes, bool tooLarge})> _readPlatformFile(
    PlatformFile file,
  ) async {
    final read = await _readBoundedBytes(file.readAsByteStream());
    return (bytes: read.bytes, tooLarge: read.tooLarge);
  }

  Future<({Uint8List bytes, bool tooLarge})> _readBoundedBytes(
    Stream<List<int>> stream,
  ) async {
    final builder = BytesBuilder(copy: false);
    var length = 0;
    await for (final chunk in stream) {
      length += chunk.length;
      if (length > kChatAttachmentMaxBytes) {
        return (bytes: Uint8List(0), tooLarge: true);
      }
      builder.add(chunk);
    }
    return (bytes: builder.takeBytes(), tooLarge: false);
  }

  AttachmentPickerOutcome _outcomeForPlatformError(String code) {
    return switch (code) {
      'camera_access_denied' ||
      'photo_access_denied' => AttachmentPickerOutcome.permissionDenied,
      _ => AttachmentPickerOutcome.unavailable,
    };
  }
}
