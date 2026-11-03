import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_attachment.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';

import '../../../../support/fake_attachment_picker.dart';
import '../../../../support/fake_chat_attachment_uploader.dart';
import '../../../../support/tiny_png.dart';

void main() {
  testWidgets('renders a chip per draft with progress, retry, and remove', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final uploader = FakeChatAttachmentUploader();
    final picker = FakeAttachmentPicker();
    final controller = ChatAttachmentController(
      uploader: uploader,
      picker: picker,
    );
    addTearDown(controller.dispose);
    final gate = Completer<ChatAttachmentRef>();
    // Uploads run one at a time on a single queue, so the first pick
    // (bad.png) settles to `failed` before the second (slow.png) even
    // starts its request and sits `uploading` on the still-pending gate.
    uploader.uploadHandler = (name) => name == 'slow.png'
        ? gate.future
        : Future.error(
            const ChatAttachmentUploadException('Attachment is too large'),
          );
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('bad.png'),
      FakeAttachmentPicker.file('slow.png'),
    ]);
    unawaited(controller.addFiles());

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: AttachmentStrip(controller: controller)),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
    expect(find.text('slow.png'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      find.byKey(const ValueKey('attachment-retry-att-1')),
      findsOneWidget,
    );
    final retry = find.byKey(const ValueKey('attachment-retry-att-1'));
    final remove = find.byKey(const ValueKey('attachment-remove-att-1'));
    expect(tester.getSize(retry).width, greaterThanOrEqualTo(44));
    expect(tester.getSize(retry).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(remove).width, greaterThanOrEqualTo(44));
    expect(tester.getSize(remove).height, greaterThanOrEqualTo(44));

    await tester.tap(remove);
    await tester.pump();
    expect(find.text('bad.png'), findsNothing);
    expect(tester.takeException(), isNull);

    gate.complete(
      const ChatAttachmentRef(
        attachmentId: 'a',
        filename: 'slow.png',
        mediaType: 'image/png',
        size: 3,
        contentSha256: 'x',
        storageKind: 'blob',
        source: '/s',
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('renders the real image preview for a decodable attachment', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final uploader = FakeChatAttachmentUploader();
    final picker = FakeAttachmentPicker();
    final controller = ChatAttachmentController(
      uploader: uploader,
      picker: picker,
    );
    addTearDown(controller.dispose);

    // Every other fixture in this suite uses zero-filled, undecodable
    // bytes and only ever exercises `Image.memory`'s `errorBuilder`
    // fallback. This fixture is a genuinely decodable 1x1 PNG so the real
    // preview path (and its declared 32x32 size) gets covered too.
    final bytes = tinyPngBytes;
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      PickedAttachment(filename: 'p.png', mediaType: 'image/png', bytes: bytes),
    ]);
    await controller.addFiles();
    expect(controller.drafts.single.status, ChatAttachmentStatus.ready);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: AttachmentStrip(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();

    final chip = find.byKey(const ValueKey('attachment-chip-att-1'));
    expect(chip, findsOneWidget);
    final imageFinder = find.descendant(of: chip, matching: find.byType(Image));
    expect(imageFinder, findsOneWidget);
    final imageWidget = tester.widget<Image>(imageFinder);
    expect(imageWidget.width, 32);
    expect(imageWidget.height, 32);
    expect(imageWidget.image, isA<ResizeImage>());
    final resized = imageWidget.image as ResizeImage;
    expect(resized.width, 96);
    expect(resized.height, 96);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed chip carries the reason as a tooltip and a hint', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final uploader = FakeChatAttachmentUploader();
    final picker = FakeAttachmentPicker();
    final controller = ChatAttachmentController(
      uploader: uploader,
      picker: picker,
    );
    addTearDown(controller.dispose);
    uploader.uploadHandler = (_) => Future.error(
      const ChatAttachmentUploadException('attachment is too large'),
    );
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('bad.png'),
    ]);
    await controller.addFiles();
    expect(controller.drafts.single.status, ChatAttachmentStatus.failed);

    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(body: AttachmentStrip(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();

    // The snackbar is one-shot; the chip is where the reason stays.
    final tooltip = tester.widget<Tooltip>(
      find.byKey(const ValueKey('attachment-error-att-1')),
    );
    expect(tooltip.message, 'Attach files of 10 MB or smaller.');
    final chipSemantics = tester.getSemantics(
      find.byKey(const ValueKey('attachment-chip-att-1')),
    );
    expect(chipSemantics.label, contains('bad.png, upload failed'));
    expect(chipSemantics.hint, contains('Attach files of 10 MB or smaller.'));
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });
}
