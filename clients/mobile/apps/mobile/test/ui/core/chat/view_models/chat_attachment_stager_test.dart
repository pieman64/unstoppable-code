import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_stager.dart';

import '../../../../support/fake_attachment_picker.dart';
import '../../../../support/fake_chat_attachment_uploader.dart';

// Behaviour is covered through the Flutter facade in
// `chat_attachment_controller_test.dart`; these pin the stager's own port.
void main() {
  late FakeChatAttachmentUploader uploader;
  late FakeAttachmentPicker picker;
  late int changes;
  late ChatAttachmentStager stager;

  setUp(() {
    uploader = FakeChatAttachmentUploader();
    picker = FakeAttachmentPicker();
    changes = 0;
    stager = ChatAttachmentStager(
      uploader: uploader,
      picker: picker,
      onChanged: () => changes += 1,
    );
  });

  test('reports staging and upload completion through onChanged', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);

    await stager.addFiles();

    expect(stager.drafts.single.status, ChatAttachmentStatus.ready);
    // Once when the draft is staged as uploading, once when it is ready.
    expect(changes, 2);
  });

  test('dispose stops notifying about a late upload result', () async {
    final gate = Completer<ChatAttachmentRef>();
    uploader.uploadHandler = (_) => gate.future;
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    final adding = stager.addFiles();
    await Future<void>.delayed(Duration.zero);
    final changesBeforeDispose = changes;

    stager.dispose();
    gate.complete(
      const ChatAttachmentRef(
        attachmentId: 'late',
        filename: 'p.png',
        mediaType: 'image/png',
        size: 3,
        contentSha256: 'x',
        storageKind: 'blob',
        source: '/s',
      ),
    );
    await adding;

    expect(changes, changesBeforeDispose);
  });

  test('discardAll after dispose still deletes ready uploads', () async {
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('p.png'),
    ]);
    await stager.addFiles();
    final changesBeforeDispose = changes;

    stager.dispose();
    await stager.discardAll();

    expect(changes, changesBeforeDispose);
    expect(stager.isEmpty, isTrue);
    expect(uploader.deleteAttachmentCalls, ['fake-1']);
  });

  // CAN-4533: a replaced session or lost capability invalidates uploads. Each
  // sequence interleaves the invalidation with a held preparation and held
  // uploads of two files. Once everything settles, both files keep their
  // bytes with Retry, no draft keeps a reference, nothing uploads after the
  // invalidation, and every reference made for the old drafts is deleted.
  // A pick or lost-media recovery under way still adds to the batch, even
  // while the strip is empty.
  test('isPicking holds until every pick and recovery settles', () async {
    final pick = picker.held = Completer<AttachmentPickResult>();
    final adding = stager.addFiles();
    expect(stager.isPicking, isTrue);
    final recovery = picker.held = Completer<AttachmentPickResult>();
    final recovering = stager.recoverLostMedia();

    pick.complete(AttachmentPickResult.cancelled);
    await adding;
    expect(stager.isEmpty, isTrue);
    expect(stager.isPicking, isTrue);

    recovery.complete(
      AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('lost.png'),
      ]),
    );
    await recovering;
    expect(stager.drafts.single.filename, 'lost.png');
    expect(stager.isPicking, isFalse);
  });

  for (final (:name, :settle) in [
    (
      name: 'returns unavailable',
      settle: (Completer<AttachmentPickResult> pick) => pick.complete(
        const AttachmentPickResult(AttachmentPickerOutcome.unavailable, []),
      ),
    ),
    (
      name: 'throws',
      settle: (Completer<AttachmentPickResult> pick) =>
          pick.completeError(StateError('picker failed')),
    ),
  ]) {
    test('isPicking ends when the picker $name', () async {
      final pick = picker.held = Completer<AttachmentPickResult>();
      final adding = stager.addFiles();
      expect(stager.isPicking, isTrue);

      settle(pick);
      await adding.catchError((Object _) {});
      expect(stager.isPicking, isFalse);
      expect(stager.isEmpty, isTrue);
    });
  }

  group('invalidateUploads', () {
    const sequences = [
      ['invalidate', 'prepare', 'upload'],
      ['invalidate', 'upload', 'prepare'],
      ['prepare', 'invalidate', 'upload'],
      ['prepare', 'upload', 'invalidate'],
      ['upload', 'invalidate', 'prepare'],
      ['upload', 'prepare', 'invalidate'],
    ];
    for (final sequence in sequences) {
      test(sequence.join(' > '), () async {
        final prepare = Completer<void>();
        final uploads = <Completer<ChatAttachmentRef>>[];
        var uploadsAnswered = false;
        ChatAttachmentRef ref(String filename) => ChatAttachmentRef(
          attachmentId: 'ref-${uploader.uploadCalls.length}',
          filename: filename,
          mediaType: 'image/png',
          size: 3,
          contentSha256: 'x',
          storageKind: 'blob',
          source: '/s',
        );
        uploader.uploadHandler = (filename) {
          if (uploadsAnswered) return Future.value(ref(filename));
          final upload = Completer<ChatAttachmentRef>();
          uploads.add(upload);
          final answer = ref(filename);
          return upload.future.then((_) => answer);
        };
        stager = ChatAttachmentStager(
          uploader: uploader,
          picker: picker,
          onChanged: () => changes += 1,
          prepareUpload: () => prepare.future,
        );
        final picked = [
          FakeAttachmentPicker.file(
            'a.png',
            bytes: Uint8List.fromList([1, 2, 3]),
          ),
          FakeAttachmentPicker.file(
            'b.png',
            bytes: Uint8List.fromList([4, 5, 6]),
          ),
        ];
        picker.next = AttachmentPickResult(
          AttachmentPickerOutcome.picked,
          picked,
        );
        final adding = stager.addFiles();
        await pumpEventQueue();

        var uploadsBeforeInvalidation = -1;
        for (final step in sequence) {
          switch (step) {
            case 'invalidate':
              uploadsBeforeInvalidation = uploader.uploadCalls.length;
              stager.invalidateUploads();
            case 'prepare':
              prepare.complete();
            case 'upload':
              uploadsAnswered = true;
              for (final upload in uploads) {
                upload.complete(ref('unused'));
              }
          }
          await pumpEventQueue();
        }
        await adding;
        await pumpEventQueue();

        expect(stager.drafts.map((draft) => draft.filename), [
          'a.png',
          'b.png',
        ]);
        for (final (index, draft) in stager.drafts.indexed) {
          expect(draft.bytes, picked[index].bytes);
          expect(draft.status, ChatAttachmentStatus.failed);
          expect(draft.uploaded, isNull);
        }
        expect(stager.canSend, isFalse);
        expect(uploader.uploadCalls, hasLength(uploadsBeforeInvalidation));
        expect(uploader.deleteAttachmentCalls, [
          for (var i = 1; i <= uploadsBeforeInvalidation; i++) 'ref-$i',
        ]);

        // Retry uploads the kept bytes again.
        for (final draft in stager.drafts) {
          await stager.retry(draft.localId);
        }
        expect(
          stager.drafts.map((draft) => draft.status),
          everyElement(ChatAttachmentStatus.ready),
        );
        expect(
          uploader.uploadCalls
              .skip(uploadsBeforeInvalidation)
              .map((call) => call.filename),
          ['a.png', 'b.png'],
        );
      });
    }
  });

  group('without an uploader', () {
    late ChatAttachmentStager draft;

    setUp(() {
      draft = ChatAttachmentStager(
        uploader: null,
        picker: picker,
        onChanged: () => changes += 1,
      );
    });

    test('stages picks without uploading and still allows send', () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
        FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
      ]);

      await draft.addFiles();

      expect(draft.drafts.map((d) => d.status), [
        ChatAttachmentStatus.staged,
        ChatAttachmentStatus.staged,
      ]);
      expect(draft.canSend, isTrue);
      expect(draft.takeForSend(), isEmpty);
      expect(uploader.uploadCalls, isEmpty);
    });

    test('uploadStaged uploads every staged pick to the uploader', () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
        FakeAttachmentPicker.file('q.png'),
      ]);
      await draft.addFiles();

      await draft.uploadStaged(uploader);

      expect(uploader.uploadCalls.map((c) => c.filename), ['p.png', 'q.png']);
      expect(draft.drafts.map((d) => d.status), [
        ChatAttachmentStatus.ready,
        ChatAttachmentStatus.ready,
      ]);
      expect(draft.takeForSend().map((d) => d.uploaded?.attachmentId), [
        'fake-1',
        'fake-2',
      ]);
    });

    test('a refused staged upload fails with Retry on the uploader', () async {
      uploader.uploadHandler = (_) =>
          throw const ChatAttachmentUploadException('Attachment is too large');
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);
      await draft.addFiles();

      await draft.uploadStaged(uploader);

      expect(draft.drafts.single.status, ChatAttachmentStatus.failed);
      expect(draft.canSend, isFalse);

      uploader.uploadHandler = null;
      await draft.retry(draft.drafts.single.localId);

      expect(draft.drafts.single.status, ChatAttachmentStatus.ready);
      expect(uploader.uploadCalls, hasLength(2));
    });

    test('picks after uploadStaged upload at once', () async {
      await draft.uploadStaged(uploader);
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);

      await draft.addFiles();

      expect(draft.drafts.single.status, ChatAttachmentStatus.ready);
      expect(uploader.uploadCalls, hasLength(1));
    });

    test('removing a staged pick deletes nothing', () async {
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);
      await draft.addFiles();

      await draft.remove(draft.drafts.single.localId);
      await draft.discardAll();

      expect(draft.isEmpty, isTrue);
      expect(uploader.deleteAttachmentCalls, isEmpty);
    });
  });
}
