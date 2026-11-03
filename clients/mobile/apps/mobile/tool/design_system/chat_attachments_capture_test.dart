// Chat attachments (Remote Control composer + transcript, CAN mobile
// attachments plan 3): captures the attach control, the staged strip's
// uploading/failed states, and the transcript's filename chips.
//
// Run: (cd apps/mobile && flutter test
// tool/design_system/chat_attachments_capture_test.dart --update-goldens)
//
// "Before" is `ChatInput` rendered WITHOUT a `ChatInputAttachments`
// — byte-identical to the pre-feature composer, since the attach control and
// staged strip only render when attachment presentation is supplied (see
// `ChatInput.build`, which guards both on `attachments != null`). "After" is
// the same widget WITH attachment presentation. Both are captured in the
// same run, so there is no stash/checkout step.
//
// Deterministic: every repository call goes through
// `FakeRemoteControlRepository` (no network) and every file pick goes
// through `FakeAttachmentPicker` (no platform channel). The "uploading"
// chip is held open with an explicit `Completer` that this test controls,
// and the "failed" chip comes from a scripted `uploadHandler` throw — both
// outcomes are deterministic, not timing-dependent. Fonts are loaded
// explicitly (`FontLoader('Inter')`/`'MaterialIcons'`) so glyphs and type
// render identically to a real device.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_attachment_uploader.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_strip.dart';

import '../../test/support/fake_attachment_picker.dart';
import '../../test/support/fake_remote_control_repository.dart';
import '../../test/support/tiny_png.dart';

Future<void> _loadFonts() async {
  await (FontLoader(
    'Inter',
  )..addFont(rootBundle.load('assets/fonts/inter/InterVariable.ttf'))).load();
  await (FontLoader(
    'MaterialIcons',
  )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
}

void _usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

// `Align` hands the composer loose constraints so it keeps its natural
// (mainAxisSize.min) height at the bottom of the screen, matching how it
// renders inside the real chat screen's Column, instead of Scaffold's tight
// body constraints stretching it to fill the whole viewport.
Widget _composerHost(ThemeData theme, Widget composer) => MaterialApp(
  theme: theme,
  home: Scaffold(
    body: Align(alignment: Alignment.bottomCenter, child: composer),
  ),
);

void main() {
  ChatInputAttachments attachmentConfig(ChatAttachmentController controller) =>
      ChatInputAttachments(
        listenable: controller,
        strip: AttachmentStrip(controller: controller),
        hasAttachments: () => controller.drafts.isNotEmpty,
        canAdd: () => controller.drafts.length < kChatAttachmentsMaxPerMessage,
        canSend: () => controller.canSend,
        onAttach: (_) {},
      );

  for (final dark in [false, true]) {
    final mode = dark ? 'dark' : 'light';
    final theme = dark ? AppTheme.dark : AppTheme.light;

    testWidgets('composer states $mode', (tester) async {
      _usePhoneViewport(tester);
      await _loadFonts();

      Future<void> capture(String name) => expectLater(
        find.byKey(const ValueKey('chat-composer')),
        matchesGoldenFile(
          '../../../../.playwright/mobile-attachments/$name-$mode.png',
        ),
      );

      // 1. composer-before: no `attachments` controller at all.
      await tester.pumpWidget(
        _composerHost(
          theme,
          ChatInput(
            controller: TextEditingController(),
            sending: false,
            onSend: () {},
          ),
        ),
      );
      await tester.pump();
      await capture('composer-before');

      // 2. composer-idle-after: a controller is supplied but has no staged
      // drafts yet — the attach button appears, the strip stays hidden.
      final repository = FakeRemoteControlRepository();
      final picker = FakeAttachmentPicker();
      final attachments = ChatAttachmentController(
        uploader: RemoteChatAttachmentUploader(repository),
        picker: picker,
      );
      addTearDown(attachments.dispose);
      await tester.pumpWidget(
        _composerHost(
          theme,
          ChatInput(
            controller: TextEditingController(),
            sending: false,
            onSend: () {},
            attachments: attachmentConfig(attachments),
          ),
        ),
      );
      await tester.pump();
      await capture('composer-idle-after');

      // 3. composer-staged-after: one failed draft (Retry visible) and one
      // still uploading (gated by `uploadGate`, never resolves during the
      // capture). The failed pick runs first and is awaited fully since its
      // handler throws synchronously; the gated pick is fired-and-not
      // awaited so the test can pump to the "uploading" frame deterministically
      // without depending on real timing.
      final uploadGate = Completer<ChatAttachmentRef>();
      repository.uploadHandler = (filename) {
        if (filename == 'notes.pdf') {
          throw const RemoteControlException(
            'Attach files of 10 MB or smaller.',
          );
        }
        return uploadGate.future;
      };

      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file(
          'notes.pdf',
          mediaType: 'application/pdf',
          size: 8,
        ),
      ]);
      await attachments.addFiles();
      await tester.pump();

      picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        PickedAttachment(
          filename: 'screenshot.png',
          mediaType: 'image/png',
          bytes: tinyPngBytes,
        ),
      ]);
      unawaited(attachments.addFiles());
      await tester.pump();
      // Advance the indeterminate spinner by a fixed, deterministic duration
      // so the "uploading" ring reads clearly instead of its t=0 stub frame.
      await tester.pump(const Duration(milliseconds: 300));
      await capture('composer-staged-after');

      // Resolve the gated upload so nothing outlives the test.
      uploadGate.complete(
        const ChatAttachmentRef(
          attachmentId: 'att-screenshot',
          filename: 'screenshot.png',
          mediaType: 'image/png',
          size: 42,
          contentSha256:
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          storageKind: 'blob',
          source: '/fake',
        ),
      );
      await tester.pump();
    });

    testWidgets('transcript chips $mode', (tester) async {
      _usePhoneViewport(tester);
      await _loadFonts();

      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: const [],
          worktrees: const [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: const [],
          chatSummaries: const [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
          ],
          chatMessages: const [
            RemoteChatMessage(
              messageId: 'u-1',
              chatId: 'chat-a',
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              text: 'Here are the two files from the design review.',
              attachments: [
                ChatMessageAttachment(
                  attachmentId: 'att-1',
                  filename: 'design-notes.pdf',
                  mediaType: 'application/pdf',
                  size: 20480,
                ),
                ChatMessageAttachment(
                  attachmentId: 'att-2',
                  filename: 'homescreen.png',
                  mediaType: 'image/png',
                  size: 10240,
                ),
              ],
            ),
            RemoteChatMessage(
              messageId: 'u-2',
              chatId: 'chat-a',
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              text: '',
              attachments: [
                ChatMessageAttachment(
                  attachmentId: 'att-3',
                  filename: 'crash-log.txt',
                  mediaType: 'text/plain',
                  size: 512,
                ),
              ],
            ),
          ],
        );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<RemoteControlViewModel>(
              create: (_) => viewModel,
            ),
            ChangeNotifierProvider<TurnFeedbackController>(
              create: (_) => TurnFeedbackController(
                repository: MockTurnFeedbackRepository(),
              ),
            ),
          ],
          child: MaterialApp(
            theme: theme,
            home: RemoteChatScreen.worktree(worktree: worktree),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await expectLater(
        find.byType(RemoteChatScreen),
        matchesGoldenFile(
          '../../../../.playwright/mobile-attachments/transcript-chips-after-$mode.png',
        ),
      );
      expect(tester.takeException(), isNull);

      // Flush the hydration/turn timers the screen armed so none outlive
      // the test. `ChangeNotifierProvider.create` owns the view model, so
      // it is disposed when the widget tree tears down at test end.
      await tester.pump(const Duration(minutes: 2));
    });
  }
}
