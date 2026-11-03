import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/view_models/voice_dictation_controller.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/core/chat/widgets/voice_dictation_button.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';

import '../../../../../support/composer_driver.dart';
import '../../../../../support/fake_attachment_picker.dart';
import '../../../../../support/fake_chat_attachment_uploader.dart';
import '../../../../../support/fake_speech_recognizer.dart';

void main() {
  testWidgets('header transitions retain draft focus and selection', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final draft = TextEditingController(text: 'Keep typing');
    addTearDown(draft.dispose);
    Widget? header;
    var attached = false;
    late StateSetter update;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: StatefulBuilder(
              builder: (context, setState) {
                update = setState;
                return ChatInput(
                  controller: draft,
                  sending: false,
                  onSend: () {},
                  header: attached ? null : header,
                  attachedHeader: attached ? header : null,
                );
              },
            ),
          ),
        ),
      ),
    );
    final field = find.byKey(const ValueKey('composer-draft'));
    await tester.tap(field);
    await tester.pump();
    draft.selection = const TextSelection.collapsed(offset: 4);
    final focus = FocusManager.instance.primaryFocus;
    for (final useAttached in [false, true]) {
      for (final next in [
        const SizedBox(height: 48),
        const SizedBox.shrink(),
        null,
      ]) {
        update(() {
          attached = useAttached;
          header = next;
        });
        await tester.pump();
        expect(FocusManager.instance.primaryFocus, same(focus));
        expect(focus?.hasFocus, isTrue);
        expect(draft.selection.baseOffset, 4);
      }
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'empty header has identical composer geometry in a shallow pane',
    (tester) async {
      final draft = TextEditingController();
      addTearDown(draft.dispose);
      Future<Rect> measure(Widget? header, {bool attached = false}) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: AppTheme.light,
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: SizedBox(
                  height: 140,
                  child: ChatInput(
                    controller: draft,
                    sending: false,
                    onSend: () {},
                    header: attached ? null : header,
                    attachedHeader: attached ? header : null,
                  ),
                ),
              ),
            ),
          ),
        );
        return tester.getRect(find.byKey(const ValueKey('chat-composer')));
      }

      final plain = await measure(null);
      final empty = await measure(const SizedBox.shrink());
      final emptyAttached = await measure(
        const SizedBox.shrink(),
        attached: true,
      );
      expect(empty, plain);
      expect(emptyAttached, plain);
      expect(tester.takeException(), isNull);
    },
  );

  ChatInputAttachments attachmentConfig(
    ChatAttachmentController controller,
    ValueChanged<ChatAttachmentSource> onAttach,
  ) => ChatInputAttachments(
    listenable: controller,
    strip: AttachmentStrip(controller: controller),
    hasAttachments: () => controller.drafts.isNotEmpty,
    canAdd: () => controller.drafts.length < kChatAttachmentsMaxPerMessage,
    canSend: () => controller.canSend,
    onAttach: onAttach,
  );

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    testWidgets('Plan is selected from + and dismissed beside attachments '
        'in ${theme.brightness.name} mode at phone width', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final semantics = tester.ensureSemantics();
      final draft = TextEditingController(text: 'Review this change');
      addTearDown(draft.dispose);
      final attachments = ChatAttachmentController(
        uploader: FakeChatAttachmentUploader(),
        picker: FakeAttachmentPicker()
          ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file(
              'design.pdf',
              mediaType: 'application/pdf',
            ),
            FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
          ]),
      );
      addTearDown(attachments.dispose);
      var selected = false;
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                return ChatInput(
                  controller: draft,
                  sending: false,
                  onSend: () {},
                  attachments: attachmentConfig(attachments, (_) {}),
                  planMode: PlanModeControl(
                    enabled: selected,
                    onToggle: () => setState(() => selected = !selected),
                  ),
                );
              },
            ),
          ),
        ),
      );
      final chip = find.byKey(const ValueKey('composer-plan'));
      final row = find.byKey(const ValueKey('composer-context-row'));
      expect(chip, findsNothing);
      expect(row, findsNothing);
      await openComposerActions(tester);
      await tester.tap(find.byKey(const ValueKey('composer-action-plan')));
      await tester.pumpAndSettle();
      expect(find.text('Plan'), findsOneWidget);
      expect(tester.getSemantics(chip).label, 'Disable plan mode');
      expect(
        tester.getRect(chip).bottom,
        lessThanOrEqualTo(tester.getRect(find.byType(TextField)).top),
      );
      // Staging files updates the row without rebuilding the host.
      await attachments.addFiles();
      await tester.pumpAndSettle();
      final strip = find.byKey(const ValueKey('attachment-strip'));
      expect(tester.getRect(chip).right, lessThan(tester.getRect(strip).left));
      expect(
        tester.getRect(chip).center.dy,
        closeTo(tester.getRect(strip).center.dy, 0.01),
      );
      await tester.drag(strip, const Offset(-240, 0));
      await tester.pumpAndSettle();
      expect(find.text('notes.txt').hitTestable(), findsOneWidget);
      expect(chip.hitTestable(), findsOneWidget);
      await tester.tap(chip);
      await tester.pumpAndSettle();
      expect(selected, isFalse);
      expect(chip, findsNothing);
      expect(attachments.drafts, hasLength(2));
      expect(draft.text, 'Review this change');
      for (final file in attachments.drafts.toList()) {
        await attachments.remove(file.localId);
      }
      await tester.pumpAndSettle();
      expect(row, findsNothing);
      expect(tester.takeException(), isNull);
      semantics.dispose();
    });
  }

  testWidgets('offers the attachment sources only with a controller, and '
      'hides the + with nothing to offer', (tester) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);

    final uploader = FakeChatAttachmentUploader();
    final picker = FakeAttachmentPicker();
    final attachments = ChatAttachmentController(
      uploader: uploader,
      picker: picker,
    );
    addTearDown(attachments.dispose);
    final draftController = TextEditingController(text: 'hello');
    addTearDown(draftController.dispose);
    final sources = <ChatAttachmentSource>[];

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: ChatInput(
            controller: draftController,
            sending: false,
            onSend: () {},
            attachments: attachmentConfig(attachments, sources.add),
          ),
        ),
      ),
    );
    await tester.pump();

    final plusSize = tester.getSize(
      find.byKey(const ValueKey('composer-actions')),
    );
    // The `+` lays out on its 32px visible surface, matching Send, so the
    // composer row reads as one tight cluster instead of separating on
    // inflated touch-target padding.
    expect(plusSize.width, CanopyComposerAction.diameter);
    expect(plusSize.height, CanopyComposerAction.diameter);
    // Each source is a row of the `+` sheet itself, with no second sheet.
    for (final key in composerAttachRowKeys) {
      await openComposerActions(tester);
      await tester.tap(find.byKey(ValueKey(key)));
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
    }
    expect(sources, ChatAttachmentSource.values);
    expect(draftController.text, 'hello');

    // Without a controller nothing applies, as in an App Advisor chat, so
    // the `+` is not shown at all rather than disabled.
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: ChatInput(
            controller: draftController,
            sending: false,
            onSend: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('composer-actions')), findsNothing);
    expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'lays the + action out on the same grid as the mic and send actions',
    (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final uploader = FakeChatAttachmentUploader();
      final attachments = ChatAttachmentController(
        uploader: uploader,
        picker: FakeAttachmentPicker(),
      );
      addTearDown(attachments.dispose);
      final draftController = TextEditingController(text: 'hello');
      addTearDown(draftController.dispose);
      final voice = VoiceDictationController(
        draft: draftController,
        recognizer: FakeSpeechRecognizer(),
      );
      addTearDown(voice.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: ChatInput(
              controller: draftController,
              sending: false,
              onSend: () {},
              voice: voice,
              attachments: attachmentConfig(attachments, (_) {}),
            ),
          ),
        ),
      );
      await tester.pump();

      final plus = tester.getRect(
        find.byKey(const ValueKey('composer-actions')),
      );
      final mic = tester.getRect(find.byKey(const ValueKey('composer-mic')));
      final send = tester.getRect(find.byKey(const ValueKey('composer-send')));

      // All three actions lay out on their 32px visible surface with no
      // touch-target inflation, so the gap between them is the composer row's
      // own spacing -- the same tight rhythm the Plan and Fast chips use.
      for (final rect in [plus, mic, send]) {
        expect(rect.width, CanopyComposerAction.diameter);
        expect(rect.height, CanopyComposerAction.diameter);
      }
      expect(plus.size, mic.size);
      expect(plus.size, send.size);
      expect(plus.left, lessThan(mic.left));
      expect(send.left - mic.right, closeTo(4, 0.01));
      expect(plus.top, mic.top);
      expect(plus.bottom, mic.bottom);

      IconButton actionButton(Key key) => tester.widget<IconButton>(
        find.descendant(of: find.byKey(key), matching: find.byType(IconButton)),
      );
      final micButton = actionButton(const ValueKey('composer-mic'));
      final sendButton = actionButton(const ValueKey('composer-send'));
      expect(
        micButton.style?.fixedSize?.resolve({}),
        const Size.square(VoiceDictationButton.dimension),
      );
      expect(
        sendButton.style?.fixedSize?.resolve({}),
        const Size.square(CanopyComposerAction.diameter),
      );
      expect(micButton.style?.tapTargetSize, MaterialTapTargetSize.shrinkWrap);
      expect(sendButton.style?.tapTargetSize, MaterialTapTargetSize.shrinkWrap);
    },
  );

  testWidgets(
    'disables send while an attachment is uploading and re-enables on its '
    'own once the upload resolves',
    (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final uploader = FakeChatAttachmentUploader();
      final picker = FakeAttachmentPicker();
      final attachments = ChatAttachmentController(
        uploader: uploader,
        picker: picker,
      );
      addTearDown(attachments.dispose);
      final draftController = TextEditingController(text: 'hello');
      addTearDown(draftController.dispose);

      final gate = Completer<ChatAttachmentRef>();
      uploader.uploadHandler = (_) => gate.future;
      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('p.png'),
      ]);
      unawaited(attachments.addFiles());

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: ChatInput(
              controller: draftController,
              sending: false,
              onSend: () {},
              attachments: attachmentConfig(attachments, (_) {}),
            ),
          ),
        ),
      );
      // Let addFiles()'s microtasks run so the draft actually reaches
      // `uploading` before we assert on it.
      await tester.pump();
      await tester.pump();

      CanopyComposerAction sendButton() => tester.widget<CanopyComposerAction>(
        find.byKey(const ValueKey('composer-send')),
      );

      expect(attachments.hasUploadsInFlight, isTrue);
      expect(sendButton().onPressed, isNull);
      expect(tester.takeException(), isNull);

      // Resolve the upload without rebuilding the widget from the outside
      // (no further pumpWidget): the send button can only flip back to
      // enabled if ChatInput's own `ListenableBuilder` is actually
      // subscribed to `attachments` and rebuilds on its notification.
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
      await tester.pump();

      expect(attachments.hasUploadsInFlight, isFalse);
      expect(sendButton().onPressed, isNotNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'CAN-3922 offers Plan mode without composer controls, such as before '
    'the first chat',
    (tester) async {
      final draftController = TextEditingController(text: 'hello');
      addTearDown(draftController.dispose);
      var toggles = 0;

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: ChatInput(
              controller: draftController,
              sending: false,
              onSend: () {},
              planMode: PlanModeControl(
                enabled: false,
                onToggle: () => toggles++,
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byTooltip('Add files and more'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('composer-action-plan')));
      await tester.pumpAndSettle();

      expect(toggles, 1);
      expect(draftController.text, 'hello');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('enables send for a ready attachment without draft text', (
    tester,
  ) async {
    final uploader = FakeChatAttachmentUploader();
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('photo.png'),
      ]);
    final attachments = ChatAttachmentController(
      uploader: uploader,
      picker: picker,
    );
    addTearDown(attachments.dispose);
    await attachments.addFiles();
    final draftController = TextEditingController();
    addTearDown(draftController.dispose);
    var sendTaps = 0;

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: Scaffold(
          body: ChatInput(
            controller: draftController,
            sending: false,
            onSend: () => sendTaps += 1,
            attachments: attachmentConfig(attachments, (_) {}),
          ),
        ),
      ),
    );
    await tester.pump();

    final send = tester.widget<CanopyComposerAction>(
      find.byKey(const ValueKey('composer-send')),
    );
    expect(send.onPressed, isNotNull);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    expect(sendTaps, 1);
  });

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    testWidgets('the + action is a 32px circle with a 1px border and no fill '
        'in ${theme.brightness.name} mode', (tester) async {
      final draftController = TextEditingController();
      addTearDown(draftController.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: theme,
          home: Scaffold(
            body: ChatInput(
              controller: draftController,
              sending: false,
              onSend: () {},
              attachmentsUnavailableReason: 'Unavailable',
            ),
          ),
        ),
      );
      await tester.pump();

      final plus = find.byKey(const ValueKey('composer-actions'));
      expect(
        tester.getSize(plus),
        const Size.square(CanopyComposerAction.diameter),
      );
      final style = tester
          .widget<IconButton>(
            find.descendant(of: plus, matching: find.byType(IconButton)),
          )
          .style!;
      final colors = AppColors.of(tester.element(plus));
      for (final states in [
        <WidgetState>{},
        {WidgetState.disabled},
      ]) {
        expect(style.shape?.resolve(states), isA<CircleBorder>());
        expect(
          style.side?.resolve(states),
          BorderSide(color: colors.border, width: 1),
        );
        expect(style.backgroundColor?.resolve(states), Colors.transparent);
      }
      expect(tester.takeException(), isNull);
    });
  }
}
