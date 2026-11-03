import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';

import '../../../../support/fake_attachment_picker.dart';
import '../../../../support/fake_chat_attachment_uploader.dart';

void main() {
  late FakeChatAttachmentUploader uploader;
  late FakeAttachmentPicker picker;
  late ChatAttachmentController controller;

  setUp(() {
    uploader = FakeChatAttachmentUploader();
    picker = FakeAttachmentPicker();
    controller = ChatAttachmentController(uploader: uploader, picker: picker);
  });

  test(
    'does not open a picker when the attachment limit is already full',
    () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        for (var i = 0; i < kChatAttachmentsMaxPerMessage; i++)
          FakeAttachmentPicker.file('$i.png'),
      ]);
      await controller.addFiles();
      final callsAtLimit = picker.filesCalls;

      await controller.addFiles();

      expect(picker.filesCalls, callsAtLimit);
      expect(controller.takeIssue(), ChatAttachmentIssue.tooMany);
    },
  );

  test('a picked file uploads and becomes ready', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    await controller.addFromPhotoLibrary();
    expect(controller.drafts.single.status, ChatAttachmentStatus.ready);
    expect(controller.drafts.single.uploaded?.filename, 'p.png');
    expect(uploader.uploadCalls.single.mediaType, 'image/png');
    expect(controller.canSend, isTrue);
  });

  test('exposes uploading while the request is in flight', () async {
    final gate = Completer<ChatAttachmentRef>();
    uploader.uploadHandler = (_) => gate.future;
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    final adding = controller.addFromCamera();
    await Future<void>.delayed(Duration.zero);
    expect(controller.hasUploadsInFlight, isTrue);
    expect(controller.canSend, isFalse);
    gate.complete(
      const ChatAttachmentRef(
        attachmentId: 'a',
        filename: 'p.png',
        mediaType: 'image/png',
        size: 3,
        contentSha256: 'x',
        storageKind: 'blob',
        source: '/s',
      ),
    );
    await adding;
    expect(controller.hasUploadsInFlight, isFalse);
  });

  test(
    'a failed upload is retryable and blocks send until fixed or removed',
    () async {
      uploader.uploadHandler = (_) =>
          throw const ChatAttachmentUploadException('Attachment is too large');
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);
      await controller.addFiles();
      expect(controller.drafts.single.status, ChatAttachmentStatus.failed);
      expect(
        controller.drafts.single.error,
        'Attach files of 10 MB or smaller.',
      );
      expect(controller.canSend, isFalse);
      uploader.uploadHandler = null;
      await controller.retry(controller.drafts.single.localId);
      expect(controller.drafts.single.status, ChatAttachmentStatus.ready);
    },
  );

  test('remove deletes a ready upload on the server', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    await controller.addFiles();
    await controller.remove(controller.drafts.single.localId);
    expect(controller.isEmpty, isTrue);
    expect(uploader.deleteAttachmentCalls, ['fake-1']);
  });

  test(
    'remove deletes an upload that completes after its draft is gone',
    () async {
      final gate = Completer<ChatAttachmentRef>();
      uploader.uploadHandler = (_) => gate.future;
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);

      final adding = controller.addFiles();
      await Future<void>.delayed(Duration.zero);
      await controller.remove(controller.drafts.single.localId);
      gate.complete(
        const ChatAttachmentRef(
          attachmentId: 'late-upload',
          filename: 'p.png',
          mediaType: 'image/png',
          size: 3,
          contentSha256: 'x',
          storageKind: 'blob',
          source: '/s',
        ),
      );
      await adding;

      expect(controller.isEmpty, isTrue);
      expect(uploader.deleteAttachmentCalls, ['late-upload']);
    },
  );

  test(
    'rejects oversized, unsupported, and over-count picks with an issue and no upload',
    () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('big.png', size: kChatAttachmentMaxBytes + 1),
      ]);
      await controller.addFiles();
      expect(controller.takeIssue(), ChatAttachmentIssue.tooLarge);
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('x.heic', mediaType: ''),
      ]);
      await controller.addFiles();
      expect(controller.takeIssue(), ChatAttachmentIssue.unsupportedType);
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        for (var i = 0; i < kChatAttachmentsMaxPerMessage + 1; i++)
          FakeAttachmentPicker.file('$i.png'),
      ]);
      await controller.addFiles();
      expect(controller.takeIssue(), ChatAttachmentIssue.tooMany);
      expect(controller.drafts, hasLength(kChatAttachmentsMaxPerMessage));
      expect(uploader.uploadCalls, hasLength(kChatAttachmentsMaxPerMessage));
    },
  );

  test('surfaces permission and unavailable outcomes once', () async {
    picker.next = const AttachmentPickResult(
      AttachmentPickerOutcome.permissionDenied,
    );
    await controller.addFromCamera();
    expect(controller.takeIssue(), ChatAttachmentIssue.permissionDenied);
    expect(controller.takeIssue(), isNull);
  });

  test(
    'surfaces a partial read failure while staging readable files',
    () async {
      picker.next = AttachmentPickResult(
        AttachmentPickerOutcome.picked,
        [FakeAttachmentPicker.file('available.png')],
        const {AttachmentPickerIssue.unavailable},
      );

      await controller.addFiles();

      expect(controller.takeIssue(), ChatAttachmentIssue.unavailable);
      expect(controller.drafts.single.filename, 'available.png');
      expect(uploader.uploadCalls, hasLength(1));
    },
  );

  test(
    'takeForSend hands over ready drafts and clears; restore puts them back',
    () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);
      await controller.addFiles();
      final taken = controller.takeForSend();
      expect(taken, hasLength(1));
      expect(controller.isEmpty, isTrue);
      controller.restore(taken);
      expect(controller.drafts.single.status, ChatAttachmentStatus.ready);
    },
  );

  test(
    'restore into a new controller remints local ids before another pick',
    () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('old.png'),
      ]);
      await controller.addFiles();
      final taken = controller.takeForSend();
      final recreated = ChatAttachmentController(
        uploader: uploader,
        picker: picker,
      );
      recreated.restore(taken);

      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('new.png'),
      ]);
      await recreated.addFiles();

      expect(
        recreated.drafts.map((draft) => draft.localId).toSet(),
        hasLength(2),
      );
      expect(recreated.drafts.map((draft) => draft.filename), [
        'old.png',
        'new.png',
      ]);
      expect(
        recreated.drafts.map((draft) => draft.status),
        everyElement(ChatAttachmentStatus.ready),
      );
      expect(recreated.drafts.map((draft) => draft.uploaded?.attachmentId), [
        'fake-1',
        'fake-2',
      ]);
    },
  );

  test(
    'restore keeps the failed batch and deletes newer uploads that no longer fit',
    () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        for (var i = 0; i < kChatAttachmentsMaxPerMessage; i++)
          FakeAttachmentPicker.file('old-$i.png'),
      ]);
      await controller.addFiles();
      final taken = controller.takeForSend();

      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('new-1.png'),
        FakeAttachmentPicker.file('new-2.png'),
      ]);
      await controller.addFiles();
      controller.restore(taken);
      await Future<void>.delayed(Duration.zero);

      expect(controller.drafts, hasLength(kChatAttachmentsMaxPerMessage));
      expect(controller.drafts.map((draft) => draft.filename), [
        for (var i = 0; i < kChatAttachmentsMaxPerMessage; i++) 'old-$i.png',
      ]);
      expect(controller.takeIssue(), ChatAttachmentIssue.tooMany);
      expect(uploader.deleteAttachmentCalls, ['fake-9', 'fake-10']);
    },
  );

  test('restoreForNewSession re-uploads retained bytes', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    await controller.addFiles();
    final taken = controller.takeForSend();

    await controller.restoreForNewSession(taken);

    expect(uploader.uploadCalls, hasLength(2));
    expect(controller.drafts.single.status, ChatAttachmentStatus.ready);
    expect(controller.drafts.single.uploaded?.attachmentId, 'fake-2');
  });

  test('discardAll after dispose still deletes uploaded blobs', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('a.png'),
    ]);
    await controller.addFiles();
    controller.dispose();
    await controller.discardAll();
    expect(uploader.deleteAttachmentCalls, ['fake-1']);
  });

  test('discardAll deletes every ready upload best-effort', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('a.png'),
      FakeAttachmentPicker.file('b.png'),
    ]);
    await controller.addFiles();
    await controller.discardAll();
    expect(uploader.deleteAttachmentCalls, ['fake-1', 'fake-2']);
    expect(controller.isEmpty, isTrue);
  });

  group('upload failures', () {
    Future<void> failWith(String? message) async {
      uploader.uploadHandler = (_) => message == null
          ? throw StateError('socket closed')
          : throw ChatAttachmentUploadException(message);
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('photo.png'),
      ]);
      await controller.addFiles();
    }

    test('takeUploadError is a one-shot set on failure', () async {
      expect(controller.takeUploadError(), isNull);
      await failWith('attachment is too large');
      expect(controller.takeUploadError(), 'Attach files of 10 MB or smaller.');
      expect(controller.takeUploadError(), isNull);
      // The chip keeps the reason after the one-shot is drained.
      expect(
        controller.drafts.single.error,
        'Attach files of 10 MB or smaller.',
      );
    });

    test('maps known server reasons to house copy', () async {
      await failWith('attachment media type is not supported');
      expect(
        controller.takeUploadError(),
        'Attach images, PDFs, Office documents, or text files.',
      );
      await controller.discardAll();

      await failWith('too many attachment uploads are in progress');
      expect(
        controller.takeUploadError(),
        'Wait for the current uploads to finish, then try again.',
      );
      await controller.discardAll();

      await failWith('desktop said no');
      expect(
        controller.takeUploadError(),
        "Couldn't upload photo.png. Retry or remove it.",
      );
      await controller.discardAll();

      await failWith(null);
      expect(
        controller.takeUploadError(),
        "Couldn't upload photo.png. Retry or remove it.",
      );
    });

    test('a failure notifies listeners so the screen can drain it', () async {
      var notifications = 0;
      controller.addListener(() => notifications += 1);
      await failWith('desktop said no');
      expect(notifications, greaterThan(0));
    });
  });

  group('filename sanitizing', () {
    Future<String> stage(
      String filename, {
      String mediaType = 'image/png',
    }) async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file(filename, mediaType: mediaType),
      ]);
      await controller.addFiles();
      return uploader.uploadCalls.last.filename;
    }

    test('replaces characters the desktop parser rejects', () async {
      expect(
        await stage(
          'Q3: results.xlsx',
          mediaType: kChatAttachmentXlsxMediaType,
        ),
        'Q3_ results.xlsx',
      );
      expect(await stage('a<b>c|d?e*f".png'), 'a_b_c_d_e_f_.png');
      expect(await stage('tab\there.png'), 'tab_here.png');
      expect(await stage('a/b\\c.png'), 'a_b_c.png');
    });

    test('repairs a Windows reserved device stem', () async {
      expect(await stage('NUL.txt', mediaType: 'text/plain'), 'file-NUL.txt');
      expect(await stage('com1.png'), 'file-com1.png');
      expect(
        await stage('COM1-.txt', mediaType: 'text/plain'),
        'file-COM1-.txt',
      );
      expect(await stage('NUL_.txt', mediaType: 'text/plain'), 'file-NUL_.txt');
      expect(await stage('NUL?.txt', mediaType: 'text/plain'), 'file-NUL_.txt');
      // Only the reserved stems, not every name that starts with one.
      expect(await stage('console.png'), 'console.png');
    });

    test('strips trailing dots and spaces', () async {
      expect(await stage('notes.txt ', mediaType: 'text/plain'), 'notes.txt');
      expect(await stage('notes.txt...', mediaType: 'text/plain'), 'notes.txt');
    });

    test('truncates the stem and keeps the extension', () async {
      final long = '${'é' * 600}.pdf';
      final uploaded = await stage(long, mediaType: 'application/pdf');
      expect(uploaded, endsWith('.pdf'));
      expect(
        utf8.encode(uploaded).length,
        lessThanOrEqualTo(kChatAttachmentFilenameMaxBytes),
      );
      expect(
        utf8.encode('é$uploaded').length,
        greaterThan(kChatAttachmentFilenameMaxBytes),
      );
      expect(uploaded.startsWith('éééé'), isTrue);
    });

    test('falls back to a name when nothing survives', () async {
      expect(await stage('   ...   '), 'attachment');
    });
  });

  test('uploads run one at a time', () async {
    final gate = Completer<ChatAttachmentRef>();
    var call = 0;
    uploader.uploadHandler = (_) {
      call += 1;
      return call == 1
          ? gate.future
          : Future.value(
              const ChatAttachmentRef(
                attachmentId: 'second',
                filename: 'b.png',
                mediaType: 'image/png',
                size: 3,
                contentSha256: 'x',
                storageKind: 'blob',
                source: '/s',
              ),
            );
    };
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('a.png'),
      FakeAttachmentPicker.file('b.png'),
    ]);
    final adding = controller.addFiles();
    await Future<void>.delayed(Duration.zero);
    // The second upload must wait: the server caps in-flight uploads per user.
    expect(uploader.uploadCalls, hasLength(1));
    gate.complete(
      const ChatAttachmentRef(
        attachmentId: 'first',
        filename: 'a.png',
        mediaType: 'image/png',
        size: 3,
        contentSha256: 'x',
        storageKind: 'blob',
        source: '/s',
      ),
    );
    await adding;
    expect(uploader.uploadCalls, hasLength(2));
  });
}
