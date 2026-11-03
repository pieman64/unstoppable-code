import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/services/platform_attachment_picker.dart';

void main() {
  test('resolvePickedMediaType rejects an unknown filename extension even '
      'when the reported type is allowlisted', () {
    expect(
      resolvePickedMediaType(reported: 'image/jpeg', filename: 'x.bin'),
      isNull,
    );
  });

  test('the filename extension wins over the reported type when both are '
      'allowlisted', () {
    expect(
      resolvePickedMediaType(reported: 'text/plain', filename: 'notes.md'),
      'text/markdown',
    );
  });

  test('falls back to the extension when the reported type is missing or '
      'not allowlisted', () {
    expect(
      resolvePickedMediaType(reported: null, filename: 'notes.md'),
      'text/markdown',
    );
    expect(
      resolvePickedMediaType(
        reported: 'application/octet-stream',
        filename: 'a.pdf',
      ),
      'application/pdf',
    );
  });

  test('returns null for unsupported files', () {
    expect(
      resolvePickedMediaType(reported: 'image/heic', filename: 'IMG.HEIC'),
      isNull,
    );
  });

  test(
    'records document copies only after their streams finish reading',
    () async {
      var readFinished = false;
      final recorded = <String>[];
      Stream<List<int>> bytes() async* {
        yield [1, 2, 3];
        readFinished = true;
      }

      final picker = PlatformAttachmentPicker(
        onFilesRead: (paths) async {
          expect(readFinished, isTrue);
          recorded.addAll(paths);
        },
        filePicker: ({required type, required allowedExtensions}) async => [
          _ScriptedPlatformFile(
            name: 'a.png',
            path: '/cache/a.png',
            size: 3,
            readStream: bytes(),
          ),
          _ScriptedPlatformFile(
            name: 'overflow.png',
            path: '/cache/overflow.png',
            size: 3,
          ),
        ],
      );
      final result = await picker.pickFiles(maxFiles: 1);
      expect(result.files.single.bytes, [1, 2, 3]);
      expect(recorded, ['/cache/a.png', '/cache/overflow.png']);
    },
  );

  group('pickFiles', () {
    PlatformAttachmentPicker pickerReturning(List<PlatformFile> files) =>
        PlatformAttachmentPicker(
          filePicker: ({required type, required allowedExtensions}) async =>
              files,
        );

    test(
      'a pick whose files all lack bytes is unavailable, not empty',
      () async {
        // A provider that supplies neither bytes nor a stream could not make
        // the document available; reporting `picked` with nothing
        // in it would make the attach control look broken.
        final result = await pickerReturning([
          _ScriptedPlatformFile(name: 'a.pdf', size: 10),
        ]).pickFiles();
        expect(result.outcome, AttachmentPickerOutcome.unavailable);
        expect(result.files, isEmpty);
      },
    );

    test('keeps the files that did come back with bytes or streams', () async {
      final result = await pickerReturning([
        _ScriptedPlatformFile(name: 'a.pdf', size: 10),
        _ScriptedPlatformFile(
          name: 'b.png',
          size: 3,
          readStream: Stream.value([1, 2, 3]),
        ),
      ]).pickFiles();
      expect(result.outcome, AttachmentPickerOutcome.picked);
      expect(result.files.single.filename, 'b.png');
      expect(result.files.single.mediaType, 'image/png');
    });

    test('keeps reading after a selected document stream fails', () async {
      final result = await pickerReturning([
        _ScriptedPlatformFile(
          name: 'missing.pdf',
          size: 3,
          readStream: Stream<List<int>>.error(StateError('unavailable')),
        ),
        _ScriptedPlatformFile(
          name: 'available.png',
          size: 3,
          readStream: Stream.value([1, 2, 3]),
        ),
      ]).pickFiles();

      expect(result.outcome, AttachmentPickerOutcome.picked);
      expect(result.files.single.filename, 'available.png');
      expect(
        result.issues,
        contains(AttachmentPickerIssue.unavailable),
        reason: 'the unreadable document must not disappear silently',
      );
    });

    test('maps document stream failures to unavailable', () async {
      final result = await pickerReturning([
        _ScriptedPlatformFile(
          name: 'missing.pdf',
          size: 3,
          readStream: Stream<List<int>>.error(StateError('unavailable')),
        ),
      ]).pickFiles();

      expect(result.outcome, AttachmentPickerOutcome.unavailable);
      expect(result.files, isEmpty);
    });

    test('an empty pick is a cancellation', () async {
      final result = await pickerReturning(const []).pickFiles();
      expect(result.outcome, AttachmentPickerOutcome.cancelled);
    });

    test('maps a platform picker failure to unavailable', () async {
      final picker = PlatformAttachmentPicker(
        filePicker: ({required type, required allowedExtensions}) =>
            throw PlatformException(code: 'already_active'),
      );

      final result = await picker.pickFiles();

      expect(result.outcome, AttachmentPickerOutcome.unavailable);
    });

    test('requests the attachment extension allowlist', () async {
      final picker = PlatformAttachmentPicker(
        filePicker: ({required type, required allowedExtensions}) async {
          expect(type, FileType.custom);
          expect(allowedExtensions, kAttachmentPickerExtensions);
          return [];
        },
      );
      await picker.pickFiles();
    });

    test(
      'reads a document with unknown size through the bounded stream',
      () async {
        final result = await pickerReturning([
          _ScriptedPlatformFile(
            name: 'notes.txt',
            readStream: Stream.value([1, 2]),
          ),
        ]).pickFiles();
        expect(result.files.single.bytes, [1, 2]);
      },
    );

    test('rejects declared oversize before listening to its stream', () async {
      var listened = false;
      final result = await pickerReturning([
        _ScriptedPlatformFile(
          name: 'large.pdf',
          size: kChatAttachmentMaxBytes + 1,
          readStream: Stream<List<int>>.multi((controller) {
            listened = true;
            controller.add([1]);
            controller.close();
          }),
        ),
      ]).pickFiles();

      expect(result.files, isEmpty);
      expect(result.issues, contains(AttachmentPickerIssue.tooLarge));
      expect(listened, isFalse);
    });

    test('reports stream-detected oversize as too large', () async {
      final result = await pickerReturning([
        _ScriptedPlatformFile(
          name: 'stale-size.pdf',
          size: 1,
          readStream: Stream<List<int>>.fromIterable([
            Uint8List(kChatAttachmentMaxBytes),
            Uint8List(1),
          ]),
        ),
      ]).pickFiles();

      expect(result.outcome, AttachmentPickerOutcome.picked);
      expect(result.files, isEmpty);
      expect(result.issues, contains(AttachmentPickerIssue.tooLarge));
    });

    test('reads no more files than the remaining attachment slots', () async {
      var secondListened = false;
      final result = await pickerReturning([
        _ScriptedPlatformFile(
          name: 'first.pdf',
          size: 1,
          readStream: Stream.value([1]),
        ),
        _ScriptedPlatformFile(
          name: 'second.pdf',
          size: 1,
          readStream: Stream<List<int>>.multi((controller) {
            secondListened = true;
            controller.add([2]);
            controller.close();
          }),
        ),
      ]).pickFiles(maxFiles: 1);

      expect(result.files.single.filename, 'first.pdf');
      expect(result.issues, contains(AttachmentPickerIssue.tooMany));
      expect(secondListened, isFalse);
    });
  });

  group('image picks', () {
    test(
      'stops reading when camera bytes exceed the attachment limit',
      () async {
        final file = _ScriptedXFile(
          name: 'large.jpg',
          declaredLength: 1,
          chunks: [Uint8List(kChatAttachmentMaxBytes), Uint8List(1)],
        );
        final picker = PlatformAttachmentPicker(
          imagePicker: _ScriptedImagePicker(cameraFile: file),
        );

        final result = await picker.pickFromCamera();

        expect(result.outcome, AttachmentPickerOutcome.picked);
        expect(result.files, isEmpty);
        expect(result.issues, contains(AttachmentPickerIssue.tooLarge));
        expect(file.readAsBytesCalled, isFalse);
      },
    );

    test(
      'keeps reading gallery files after an ordinary read failure',
      () async {
        final failed = _ScriptedXFile(
          name: 'missing.jpg',
          declaredLength: 1,
          error: const FileSystemException('unavailable'),
        );
        final available = _ScriptedXFile(
          name: 'available.png',
          declaredLength: 3,
          chunks: [
            Uint8List.fromList([1, 2, 3]),
          ],
        );
        final picker = PlatformAttachmentPicker(
          imagePicker: _ScriptedImagePicker(galleryFiles: [failed, available]),
        );

        final result = await picker.pickFromPhotoLibrary();

        expect(result.outcome, AttachmentPickerOutcome.picked);
        expect(result.files.single.filename, 'available.png');
        expect(result.files.single.bytes, [1, 2, 3]);
        expect(
          result.issues,
          contains(AttachmentPickerIssue.unavailable),
          reason: 'the unreadable photo must not disappear silently',
        );
      },
    );

    test('reports gallery selections beyond the remaining slots', () async {
      final picker = PlatformAttachmentPicker(
        imagePicker: _ScriptedImagePicker(
          galleryFiles: [
            _ScriptedXFile(
              name: 'first.png',
              declaredLength: 1,
              chunks: [
                Uint8List.fromList([1]),
              ],
            ),
            _ScriptedXFile(
              name: 'second.png',
              declaredLength: 1,
              chunks: [
                Uint8List.fromList([2]),
              ],
            ),
          ],
        ),
      );

      final result = await picker.pickFromPhotoLibrary(maxFiles: 1);

      expect(result.files.single.filename, 'first.png');
      expect(result.issues, contains(AttachmentPickerIssue.tooMany));
    });

    test(
      'recovers lost Android image selections within the remaining slots',
      () async {
        final picker = PlatformAttachmentPicker(
          imagePicker: _ScriptedImagePicker(
            lostData: LostDataResponse(
              files: [
                _ScriptedXFile(
                  name: 'recovered.png',
                  declaredLength: 1,
                  chunks: [
                    Uint8List.fromList([1]),
                  ],
                ),
                _ScriptedXFile(
                  name: 'overflow.png',
                  declaredLength: 1,
                  chunks: [
                    Uint8List.fromList([2]),
                  ],
                ),
              ],
              type: RetrieveType.image,
            ),
          ),
        );

        final result = await picker.recoverLostMedia(maxFiles: 1);

        expect(result.outcome, AttachmentPickerOutcome.picked);
        expect(result.files.single.filename, 'recovered.png');
        expect(result.issues, contains(AttachmentPickerIssue.tooMany));
      },
    );

    test('applies the attachment byte limit to recovered images', () async {
      final file = _ScriptedXFile(
        name: 'large.jpg',
        declaredLength: 1,
        chunks: [Uint8List(kChatAttachmentMaxBytes), Uint8List(1)],
      );
      final picker = PlatformAttachmentPicker(
        imagePicker: _ScriptedImagePicker(
          lostData: LostDataResponse(file: file, type: RetrieveType.image),
        ),
      );

      final result = await picker.recoverLostMedia();

      expect(result.files, isEmpty);
      expect(result.issues, contains(AttachmentPickerIssue.tooLarge));
      expect(file.readAsBytesCalled, isFalse);
    });

    test('maps an ordinary camera read failure to unavailable', () async {
      final picker = PlatformAttachmentPicker(
        imagePicker: _ScriptedImagePicker(
          cameraFile: _ScriptedXFile(
            name: 'missing.jpg',
            declaredLength: 1,
            error: const FileSystemException('unavailable'),
          ),
        ),
      );

      final result = await picker.pickFromCamera();

      expect(result.outcome, AttachmentPickerOutcome.unavailable);
      expect(result.files, isEmpty);
    });
  });
}

final class _ScriptedImagePicker extends ImagePicker {
  _ScriptedImagePicker({
    this.cameraFile,
    this.galleryFiles = const [],
    LostDataResponse? lostData,
  }) : lostData = lostData ?? LostDataResponse.empty();

  final XFile? cameraFile;
  final List<XFile> galleryFiles;
  final LostDataResponse lostData;

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    CameraDevice preferredCameraDevice = CameraDevice.rear,
    bool requestFullMetadata = true,
  }) async => cameraFile;

  @override
  Future<List<XFile>> pickMultiImage({
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    int? limit,
    bool requestFullMetadata = true,
  }) async => galleryFiles;

  @override
  Future<LostDataResponse> retrieveLostData() async => lostData;
}

final class _ScriptedXFile extends XFile {
  _ScriptedXFile({
    required this.name,
    required this.declaredLength,
    this.chunks = const [],
    this.error,
  }) : super(name);

  @override
  final String name;
  final int declaredLength;
  final List<Uint8List> chunks;
  final Object? error;
  bool readAsBytesCalled = false;

  @override
  Future<int> length() async => declaredLength;

  @override
  Stream<Uint8List> openRead([int? start, int? end]) async* {
    if (error case final error?) throw error;
    yield* Stream.fromIterable(chunks);
  }

  @override
  Future<Uint8List> readAsBytes() async {
    readAsBytesCalled = true;
    if (error case final error?) throw error;
    return Uint8List.fromList(chunks.expand((chunk) => chunk).toList());
  }
}

final class _ScriptedPlatformFile extends PlatformFile {
  _ScriptedPlatformFile({
    required this.name,
    this.size,
    this.readStream,
    String? path,
  }) : uri = Uri.file(path ?? '/$name');
  @override
  final String name;
  final int? size;
  final Stream<List<int>>? readStream;
  @override
  final Uri uri;
  @override
  XFile get xFile => throw UnimplementedError();
  @override
  int? lengthSync() => size;
  @override
  Future<int?> length() async => size;
  @override
  Future<Uint8List> readAsBytes() =>
      throw StateError('Must stream attachments');
  @override
  Stream<Uint8List> readAsByteStream() =>
      (readStream ??
              Stream<List<int>>.error(const FileSystemException('unavailable')))
          .map(Uint8List.fromList);
}
