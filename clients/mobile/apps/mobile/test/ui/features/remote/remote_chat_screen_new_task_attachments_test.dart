// CAN-4533: a new task in a worktree project stages attachments while its
// worktree is created, and uploads them only once the worktree and the chat
// the first message goes to exist.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_draft_first_send.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/composer_driver.dart';
import '../../../support/fake_attachment_picker.dart';
import '../../../support/fake_remote_control_repository.dart';

const _workspace = RemoteWorkspace(
  localId: 'ws-app',
  order: 0,
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
);

const _existing = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-app',
  branch: 'feature/oauth',
);

const _created = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-app',
  branch: 'canopy/otter',
);

/// A tree workspace whose worktree create the test releases through
/// [createResult].
final class _Fixture {
  _Fixture({bool attachments = true}) {
    repository
      ..supportsChatAttachments = attachments
      ..createWorktreeHandler = (() => createResult.future)
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [_workspace],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
  }

  final repository = FakeRemoteControlRepository();
  final worktrees = <RemoteWorktree>[_existing];
  var createResult = Completer<RemoteWorktreeCreateResult>();
  final picker = FakeAttachmentPicker()
    ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
    ]);

  /// The desktop reserves [_created], optionally with git setup running.
  void reserve({bool gitPending = false}) {
    worktrees.add(
      gitPending
          ? const RemoteWorktree(
              localId: 'wt-2',
              workspaceLocalId: 'ws-app',
              branch: 'canopy/otter',
              setupPhase: RemoteWorktreeSetupPhase.gitPending,
            )
          : _created,
    );
    createResult.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
  }

  /// The desktop lists [chatId] as a tab of [_created].
  void projectChat(
    String chatId, {
    int cursor = 10,
    bool active = true,
    String title = 'New chat',
  }) {
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateDeltaEvent(
            chatSummaries: [
              RemoteChatSummary(
                chatId: chatId,
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-app',
                worktreeLocalId: 'wt-2',
                title: title,
                active: active,
              ),
            ],
          ),
        ],
        nextCursor: cursor,
      ),
    );
  }

  /// The desktop rejects the chat tab create command at [index].
  void rejectChat(int index, {int cursor = 20}) {
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            message: 'The tab could not be created.',
            commandId: repository.createChatTabCommandIds[index],
          ),
        ],
        nextCursor: cursor,
      ),
    );
  }
}

void main() {
  void usePhoneViewport(WidgetTester tester) {
    // 390 logical pixels wide, as on a phone.
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
  }

  Future<RemoteControlViewModel> connect(
    WidgetTester tester,
    _Fixture fixture,
  ) async {
    final viewModel = RemoteControlViewModel(
      repository: fixture.repository,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: Duration.zero,
    );
    await tester.runAsync(() => viewModel.connect('123456'));
    return viewModel;
  }

  Widget subject(
    RemoteControlViewModel viewModel,
    _Fixture fixture, {
    Widget? home,
  }) => MultiProvider(
    providers: [
      ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
      ChangeNotifierProvider<TurnFeedbackController>(
        create: (_) =>
            TurnFeedbackController(repository: MockTurnFeedbackRepository()),
      ),
    ],
    child: MaterialApp(
      theme: AppTheme.light,
      darkTheme: AppTheme.dark,
      home:
          home ??
          RemoteChatScreen.create(
            workspace: _workspace,
            attachmentPicker: fixture.picker,
          ),
    ),
  );

  Future<void> tearDownScreen(
    WidgetTester tester,
    RemoteControlViewModel viewModel,
    _Fixture fixture,
  ) async {
    await tester.pumpWidget(const SizedBox());
    // Flush hydration watchdogs the bound worktree may have started.
    await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    viewModel.dispose();
    await fixture.repository.eventsController.close();
  }

  /// Held files and the worktree create show looping spinners, so the
  /// screen does not settle while the first chat is prepared.
  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// Lets a failure snackbar that covers the composer go away.
  Future<void> waitOutSnackBar(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 4));
    await settle(tester);
  }

  /// Disconnects as the real repository does: the desktop's capabilities
  /// clear with the session.
  Future<void> disconnect(
    WidgetTester tester,
    RemoteControlViewModel viewModel,
    _Fixture fixture,
  ) async {
    fixture.repository.supportsChatAttachments = false;
    await tester.runAsync(viewModel.disconnect);
  }

  /// Pairs again with a desktop that announces attachments. The pairing
  /// runs on the test's clock, so a controller the screen creates for it
  /// also queues its uploads there.
  Future<void> reconnect(
    WidgetTester tester,
    RemoteControlViewModel viewModel,
    _Fixture fixture,
  ) async {
    fixture.repository.supportsChatAttachments = true;
    final connected = viewModel.connect('654321');
    await settle(tester);
    await connected;
  }

  Future<void> attachFiles(WidgetTester tester) async {
    await openComposerActions(tester);
    await tester.tap(
      find.byKey(const ValueKey('composer-action-attach-files')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  VoidCallback? sendAction(WidgetTester tester) => tester
      .widget<CanopyComposerAction>(find.byKey(const ValueKey('composer-send')))
      .onPressed;

  String draftText(WidgetTester tester) =>
      tester
          .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
          .controller
          ?.text ??
      '';

  /// The Retry control of the one failed chip, whatever its local id.
  final retryControl = find.byWidgetPredicate(
    (widget) =>
        widget.key is ValueKey<String> &&
        (widget.key! as ValueKey<String>).value.startsWith('attachment-retry-'),
  );

  group('CAN-4533 new task attachments', () {
    for (final fails in [false, true]) {
      testWidgets(
        'automatic first send waits for attachment upload and retry ($fails)',
        (tester) async {
          usePhoneViewport(tester);
          final fixture = _Fixture();
          final upload = Completer<ChatAttachmentRef>();
          fixture.repository.uploadHandler = (_) => upload.future;
          final viewModel = await connect(tester, fixture);
          final firstSend = RemoteDraftFirstSend();
          await tester.pumpWidget(
            subject(
              viewModel,
              fixture,
              home: RemoteChatScreen.create(
                workspace: _workspace,
                attachmentPicker: fixture.picker,
                firstSend: firstSend,
              ),
            ),
          );
          await tester.pump();
          await tester.pump();
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Include my file',
          );
          await attachFiles(tester);
          fixture.reserve();
          await settle(tester);
          final chatId = fixture.repository.createChatTabTargets.single.chatId!;
          fixture.projectChat(chatId);
          await settle(tester);
          expect(fixture.repository.uploadCalls, hasLength(1));
          expect(fixture.repository.sendChatMessageCalls, isEmpty);
          expect(sendAction(tester), isNull);
          final ref = ChatAttachmentRef(
            attachmentId: 'uploaded-file',
            filename: 'notes.txt',
            mediaType: 'text/plain',
            size: 4,
            contentSha256: 'a' * 64,
            storageKind: 'blob',
            source: '/fake',
          );
          if (fails) {
            upload.completeError(const RemoteControlException('Upload failed'));
            await settle(tester);
            expect(fixture.repository.sendChatMessageCalls, isEmpty);
            expect(sendAction(tester), isNull);
            await waitOutSnackBar(tester);
            fixture.repository.uploadHandler = (_) async => ref;
            await tester.tap(retryControl);
          } else {
            upload.complete(ref);
          }
          await settle(tester);
          final sent = fixture.repository.sendChatMessageCalls.single;
          expect(sent.text, 'Include my file');
          expect(
            sent.options?.attachments?.single.attachmentId,
            'uploaded-file',
          );
          expect(tester.takeException(), isNull);
          firstSend.dispose();
          await tearDownScreen(tester, viewModel, fixture);
        },
      );
    }

    testWidgets('a ready push opens the composer before the recovery timer', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      // Keep the production three-second recovery interval. No clock advance
      // should be needed between the desktop's ready push and the composer.
      final viewModel = RemoteControlViewModel(
        repository: fixture.repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      expect(fixture.repository.createWorktreeCalls, hasLength(1));
      expect(fixture.repository.requestOverviewStateCalls, 0);

      fixture.reserve(gitPending: true);
      await tester.pump();
      await tester.pump();
      expect(find.text('Setting up worktree…'), findsOneWidget);
      fixture.repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteStateDeltaEvent(worktrees: [_created]),
          ],
          nextCursor: 1,
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Fix login',
      );
      await tester.pump();
      expect(find.text('Setting up worktree…'), findsNothing);
      expect(sendAction(tester), isNotNull);
      expect(fixture.repository.requestOverviewStateCalls, 0);
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets('a lost create response releases the composer for retry', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = RemoteControlViewModel(
        repository: fixture.repository,
        stateRefreshDebounce: Duration.zero,
        // The fixture sends no worktree delta, so a recovery round reads it.
        worktreeCreateRecoveryInterval: const Duration(seconds: 3),
        worktreeCreateTimeout: const Duration(seconds: 4),
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Keep me',
      );
      await attachFiles(tester);
      fixture.createResult.completeError(
        const RemoteWorktreeCreateOutcomeUnknownException('Response lost.'),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 4));
      await tester.pump();
      expect(viewModel.isCreatingWorktree, isFalse);
      expect(find.textContaining('Check your desktop'), findsWidgets);
      expect(draftText(tester), 'Keep me');
      expect(fixture.repository.sendChatMessageCalls, isEmpty);

      fixture.createResult = Completer<RemoteWorktreeCreateResult>();
      await tester.tap(find.byKey(const ValueKey('attachment-retry-att-1')));
      await tester.pump();
      await tester.pump();
      expect(fixture.repository.createWorktreeCalls, hasLength(2));
      fixture.reserve();
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      await settle(tester);
      final chatId = fixture.repository.createChatTabTargets.single.chatId!;
      fixture.projectChat(chatId);
      await settle(tester);
      expect(fixture.repository.uploadCalls, hasLength(1));
      expect(draftText(tester), 'Keep me');
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    for (final announced in [true, false]) {
      testWidgets('CAN-4533 a new task follows chat_attachments ($announced) '
          'before its worktree exists', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture(attachments: announced);
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();

        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(find.text('Creating worktree…'), findsOneWidget);
        expect(sendAction(tester), isNull);
        expect(
          await composerAttachRowEnabled(tester),
          announced ? isTrue : isNull,
        );
        expect(tester.takeException(), isNull);
        fixture.createResult.completeError(
          const RemoteControlException('stop'),
        );
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    testWidgets(
      'CAN-4533 staged files wait for the worktree and its first chat',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        fixture.picker.next =
            AttachmentPickResult(AttachmentPickerOutcome.picked, [
              FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
              FakeAttachmentPicker.file('diagram.png'),
            ]);
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login redirect',
        );
        await attachFiles(tester);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(find.text('diagram.png'), findsOneWidget);
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(sendAction(tester), isNull);

        // Reserved, git setup still running: not a usable worktree yet.
        fixture.reserve(gitPending: true);
        await tester.pump();
        await tester.pump();
        expect(find.text('Setting up worktree…'), findsOneWidget);
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(sendAction(tester), isNull);

        // Git setup finishes; the worktree has no chat, so one is asked for.
        // Its acknowledgement alone does not prove the chat exists.
        fixture.worktrees[1] = _created;
        await settle(tester);
        expect(find.text('canopy/otter'), findsOneWidget);
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        final chatTarget = fixture.repository.createChatTabTargets.single;
        expect(chatTarget.workspaceLocalId, 'ws-app');
        expect(chatTarget.worktreeLocalId, 'wt-2');
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(sendAction(tester), isNull);

        // The desktop lists the chat: both files upload, one at a time.
        fixture.projectChat(chatTarget.chatId!);
        await settle(tester);
        expect(fixture.repository.uploadCalls.map((call) => call.filename), [
          'notes.txt',
          'diagram.png',
        ]);
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(draftText(tester), 'Fix the login redirect');
        expect(sendAction(tester), isNotNull);

        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target, isA<RemoteWorktreeChatTarget>());
        expect(
          (sent.target as RemoteWorktreeChatTarget).worktreeLocalId,
          'wt-2',
        );
        expect(sent.target.chatId, chatTarget.chatId);
        expect(sent.text, 'Fix the login redirect');
        expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
          'fake-1',
          'fake-2',
        ]);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(fixture.repository.deleteAttachmentCalls, isEmpty);
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    testWidgets("CAN-4533 a staged file goes to the desktop's own first chat", (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await attachFiles(tester);

      // The desktop opens a chat in the new worktree on its own.
      fixture.reserve();
      fixture.projectChat('chat-desktop');
      await settle(tester);
      expect(fixture.repository.createChatTabTargets, isEmpty);
      expect(fixture.repository.uploadCalls, hasLength(1));

      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      final sent = fixture.repository.sendChatMessageCalls.single;
      expect(sent.target.chatId, 'chat-desktop');
      expect(sent.text, '');
      expect(sent.options?.attachments?.single.filename, 'notes.txt');
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets('CAN-4533 a recovered photo goes to the first chat', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      fixture.picker.lost = AttachmentPickResult(
        AttachmentPickerOutcome.picked,
        [FakeAttachmentPicker.file('lost.png')],
      );
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      expect(fixture.picker.recoverLostMediaCalls, 1);
      expect(find.text('lost.png'), findsOneWidget);

      fixture.reserve();
      fixture.projectChat('chat-desktop');
      await settle(tester);
      expect(fixture.repository.uploadCalls, hasLength(1));
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      final sent = fixture.repository.sendChatMessageCalls.single;
      expect(sent.target.chatId, 'chat-desktop');
      expect(sent.options?.attachments?.single.filename, 'lost.png');
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets(
      'CAN-4533 a rejected worktree keeps the draft and file for Retry',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);

        fixture.createResult.completeError(
          const RemoteControlException('The desktop could not create it.'),
        );
        await settle(tester);
        expect(find.text('The desktop could not create it.'), findsWidgets);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('attachment-retry-att-1')),
          findsOneWidget,
        );
        expect(draftText(tester), 'Keep me');
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);

        // Retrying the file retries the same worktree create.
        fixture.createResult = Completer<RemoteWorktreeCreateResult>();
        await tester.tap(find.byKey(const ValueKey('attachment-retry-att-1')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.createWorktreeCalls, hasLength(2));
        expect(find.text('Creating worktree…'), findsOneWidget);
        expect(fixture.repository.uploadCalls, isEmpty);

        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        fixture.projectChat(chatId);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));
        await waitOutSnackBar(tester);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, chatId);
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    testWidgets('CAN-4533 a rejected first chat keeps the file for Retry', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Keep me',
      );
      await attachFiles(tester);
      fixture.reserve();
      await settle(tester);
      expect(fixture.repository.createChatTabTargets, hasLength(1));

      fixture.rejectChat(0);
      await settle(tester);
      expect(fixture.repository.uploadCalls, isEmpty);
      expect(fixture.repository.sendChatMessageCalls, isEmpty);
      expect(find.text('notes.txt'), findsOneWidget);
      expect(draftText(tester), 'Keep me');

      await tester.tap(find.byKey(const ValueKey('attachment-retry-att-1')));
      await settle(tester);
      expect(fixture.repository.createChatTabTargets, hasLength(2));
      final chatId = fixture.repository.createChatTabTargets.last.chatId!;
      expect(fixture.repository.uploadCalls, isEmpty);
      fixture.projectChat(chatId, cursor: 30);
      await settle(tester);
      expect(fixture.repository.uploadCalls, hasLength(1));

      await waitOutSnackBar(tester);
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      final sent = fixture.repository.sendChatMessageCalls.single;
      expect(sent.target.chatId, chatId);
      expect(sent.text, 'Keep me');
      expect(fixture.repository.createWorktreeCalls, hasLength(1));
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets(
      'CAN-4533 a replaced session never uploads the held file into it',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final oldChatId =
            fixture.repository.createChatTabTargets.single.chatId!;

        // The pairing is replaced while the first chat is unconfirmed; the
        // old session's projection then arrives.
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();
        fixture.projectChat(oldChatId);
        await settle(tester);

        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');

        // Retry uploads the kept file in the new session, then it sends.
        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.uploadCalls, hasLength(1));
        await waitOutSnackBar(tester);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, oldChatId);
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    testWidgets(
      'CAN-4533 a session replaced during the worktree create uploads nothing',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);

        // The old session's create answers after the pairing is replaced.
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();
        fixture.reserve();
        await settle(tester);

        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    testWidgets('CAN-4533 a same-pairing refresh keeps the held file going', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      var heartbeat = 0;
      fixture.repository
        ..connectedSessionId = 'session-1'
        ..sessionMetadataBuilder = () => RemoteConnection(
          deviceLabel: 'Test Desktop',
          pairedAt: DateTime(2026),
          sessionId: 'session-1',
          lastSeenAt: DateTime.utc(2026, 10, 5, 12, 0, ++heartbeat),
        );
      final viewModel = await connect(tester, fixture);
      final generation = viewModel.sessionGeneration;
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await attachFiles(tester);

      // Home, then back: the pairing's metadata is read again.
      viewModel.onAppBackgrounded();
      await tester.pump();
      await tester.runAsync(viewModel.onAppForegrounded);
      await tester.pump();
      expect(viewModel.sessionGeneration, generation);

      fixture.reserve();
      await settle(tester);
      final chatId = fixture.repository.createChatTabTargets.single.chatId!;
      fixture.projectChat(chatId);
      await settle(tester);
      expect(fixture.repository.uploadCalls, hasLength(1));
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      expect(
        fixture.repository.sendChatMessageCalls.single.target.chatId,
        chatId,
      );
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets('CAN-4533 a file removed while it waits is never uploaded', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await attachFiles(tester);
      await tester.tap(find.byKey(const ValueKey('attachment-remove-att-1')));
      await tester.pump();
      expect(find.text('notes.txt'), findsNothing);

      // The preparation already under way still gives the worktree its
      // first chat; the removed file is skipped.
      fixture.reserve();
      await settle(tester);
      final chatId = fixture.repository.createChatTabTargets.single.chatId!;
      fixture.projectChat(chatId);
      await settle(tester);
      expect(fixture.repository.uploadCalls, isEmpty);
      expect(fixture.repository.deleteAttachmentCalls, isEmpty);
      expect(fixture.repository.sendChatMessageCalls, isEmpty);
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets('CAN-4533 leaving during creation uploads and sends nothing', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      await attachFiles(tester);
      expect(find.text('notes.txt'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      fixture.reserve();
      await settle(tester);
      expect(fixture.repository.createChatTabTargets, isEmpty);
      expect(fixture.repository.uploadCalls, isEmpty);
      expect(fixture.repository.sendChatMessageCalls, isEmpty);
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });

    testWidgets(
      'CAN-4533 a replacement that has not announced attachments keeps the file',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);

        // The new pairing has not announced its capabilities yet.
        await tester.runAsync(viewModel.disconnect);
        fixture.repository.supportsChatAttachments = false;
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();
        fixture.reserve();
        // The old session's create answers; its upload failure is announced.
        await settle(tester);
        await waitOutSnackBar(tester);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');
        expect(await composerAttachRowEnabled(tester), isFalse);
        await openComposerActions(tester);
        expect(find.text(kAttachmentsNeedReconnect), findsOneWidget);
        await closeComposerActions(tester);

        // The desktop announces attachments: the file waits for Retry.
        fixture.repository.supportsChatAttachments = true;
        await tester.runAsync(viewModel.refresh);
        await settle(tester);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');
        expect(await composerAttachRowEnabled(tester), isTrue);
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    testWidgets(
      'CAN-4533 a file uploaded before a replacement uploads again for it',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        fixture.projectChat(chatId);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));

        // The old session's reference must not reach the new session.
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();
        fixture.projectChat(chatId, cursor: 30);
        await settle(tester);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');
        // The file needs Retry, so Send waits.
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(sendAction(tester), isNull);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(fixture.repository.uploadCalls, hasLength(1));

        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(2));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, chatId);
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
          'fake-2',
        ]);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    // The replacement may be another desktop that reuses the same workspace,
    // worktree and chat local ids, or the same server session paired again.
    // Either way only its own listing confirms the task's chat.
    for (final (:name, :sessionIds) in [
      (
        name: 'another desktop with the same local ids',
        sessionIds: ('session-a', 'session-b'),
      ),
      (
        name: 'the same server session paired again',
        sessionIds: ('session-1', 'session-1'),
      ),
    ]) {
      testWidgets('CAN-4533 Retry after a replacement by $name waits for '
          'the current session to list the chat', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        fixture.repository.connectedSessionId = sessionIds.$1;
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        fixture.projectChat(chatId);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));
        final generation = viewModel.sessionGeneration;

        // The old pairing ends; its late projection lands nowhere. The new
        // pairing lists the same workspace and worktree, but not the chat.
        await tester.runAsync(viewModel.disconnect);
        fixture.projectChat(chatId, cursor: 25);
        fixture.repository.connectedSessionId = sessionIds.$2;
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        expect(viewModel.sessionGeneration, isNot(generation));
        expect(
          viewModel.worktreesFor('ws-app').map((w) => w.localId),
          contains('wt-2'),
        );

        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.uploadCalls, hasLength(1));
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');

        // The current session lists the chat: Retry uploads, Send sends.
        fixture.projectChat(chatId, cursor: 30);
        await settle(tester);
        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(2));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(
          sent.target,
          isA<RemoteWorktreeChatTarget>()
              .having((t) => t.worktreeLocalId, 'worktree', 'wt-2')
              .having((t) => t.chatId, 'chat', chatId),
        );
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
          'fake-2',
        ]);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // The replacement lists another chat of the same worktree first. Its
    // tab must not take over the files staged for the task's own chat.
    // Either session may be another desktop or the same server session
    // paired again.
    for (final (:otherActive, :sessionIds) in [
      for (final otherActive in [false, true])
        for (final sessionIds in [
          ('session-a', 'session-b'),
          ('session-1', 'session-1'),
        ])
          (otherActive: otherActive, sessionIds: sessionIds),
    ]) {
      testWidgets('CAN-4533 a replacement listing only another chat keeps the '
          "task's files for its own chat (other active later: $otherActive, "
          'sessions: $sessionIds)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        fixture.repository.connectedSessionId = sessionIds.$1;
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        fixture.projectChat(chatId);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));

        final generation = viewModel.sessionGeneration;

        // The old pairing's late projection lands nowhere. The new pairing
        // lists the worktree with only another chat.
        await tester.runAsync(viewModel.disconnect);
        fixture.projectChat(chatId, cursor: 25);
        fixture.repository.connectedSessionId = sessionIds.$2;
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        expect(viewModel.sessionGeneration, isNot(generation));
        fixture.projectChat('chat-other', cursor: 27, title: 'Other chat');
        await settle(tester);
        expect(
          viewModel
              .chatSummariesFor(
                workspaceLocalId: 'ws-app',
                worktreeLocalId: 'wt-2',
              )
              .map((summary) => summary.chatId),
          ['chat-other'],
        );

        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.uploadCalls, hasLength(1));
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');

        // The current session lists the task's chat: Retry uploads once and
        // Send goes to that chat, even when the other chat is active.
        fixture
          ..projectChat(chatId, cursor: 30, active: !otherActive)
          ..projectChat(
            'chat-other',
            cursor: 31,
            active: otherActive,
            title: 'Other chat',
          );
        await settle(tester);
        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(2));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(
          sent.target,
          isA<RemoteWorktreeChatTarget>()
              .having((t) => t.worktreeLocalId, 'worktree', 'wt-2')
              .having((t) => t.chatId, 'chat', chatId),
        );
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
          'fake-2',
        ]);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(fixture.repository.createChatTabTargets, hasLength(1));

        // Once the first message is sent, files staged in another chat
        // upload for that chat as usual.
        await settle(tester);
        await tester.selectTabFromSheet('Other chat');
        await settle(tester);
        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(3));
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // A rejected first chat leaves the task's files without a chat. A
    // replacement that lists only another chat of the worktree must not
    // become their target, even after several replacements. Removing them
    // and attaching again starts a batch for the chat then shown.
    for (final (:replacements, :sessionIds) in [
      (replacements: 1, sessionIds: ('session-a', 'session-b')),
      (replacements: 1, sessionIds: ('session-1', 'session-1')),
      (replacements: 2, sessionIds: ('session-a', 'session-b')),
    ]) {
      testWidgets('CAN-4533 files whose first chat was rejected never go to '
          "a replacement's other chat (replacements: $replacements, "
          'sessions: $sessionIds)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        fixture.repository.connectedSessionId = sessionIds.$1;
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        fixture.rejectChat(0);
        await settle(tester);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(fixture.repository.uploadCalls, isEmpty);

        var cursor = 30;
        for (var i = 0; i < replacements; i++) {
          final generation = viewModel.sessionGeneration;
          await tester.runAsync(viewModel.disconnect);
          fixture.repository.connectedSessionId = sessionIds.$2;
          await tester.runAsync(() => viewModel.connect('654321'));
          await settle(tester);
          expect(viewModel.sessionGeneration, isNot(generation));
          fixture.projectChat('chat-other', cursor: cursor++, title: 'Other');
          await settle(tester);
          expect(
            viewModel
                .chatSummariesFor(
                  workspaceLocalId: 'ws-app',
                  worktreeLocalId: 'wt-2',
                )
                .map((summary) => summary.chatId),
            ['chat-other'],
          );

          await waitOutSnackBar(tester);
          await tester.tap(retryControl);
          await settle(tester);
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          expect(fixture.repository.uploadCalls, isEmpty);
          expect(fixture.repository.createChatTabTargets, hasLength(1));
          expect(fixture.repository.sendChatMessageCalls, isEmpty);
          expect(find.text('notes.txt'), findsOneWidget);
          expect(draftText(tester), 'Keep me');
        }

        // Removing the kept file ends its batch; a new one is for the chat
        // shown now.
        await waitOutSnackBar(tester);
        await tester.tap(
          find.byWidgetPredicate(
            (widget) =>
                widget.key is ValueKey<String> &&
                (widget.key! as ValueKey<String>).value.startsWith(
                  'attachment-remove-',
                ),
          ),
        );
        await settle(tester);
        expect(find.text('notes.txt'), findsNothing);
        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, 'chat-other');
        expect(sent.text, 'Keep me');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // Files removed before the first send end their batch, whether their
    // chat was already listed or is listed only afterwards. A new batch
    // after a replacement goes to the chat the user chose there.
    for (final listedBeforeRemoval in [true, false]) {
      testWidgets('CAN-4533 a removed batch leaves no hold for the next one '
          '(chat listed before removal: $listedBeforeRemoval)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        if (listedBeforeRemoval) {
          fixture.projectChat(chatId);
          await settle(tester);
          expect(fixture.repository.uploadCalls, hasLength(1));
        }
        await tester.tap(
          find.byWidgetPredicate(
            (widget) =>
                widget.key is ValueKey<String> &&
                (widget.key! as ValueKey<String>).value.startsWith(
                  'attachment-remove-',
                ),
          ),
        );
        await settle(tester);
        expect(find.text('notes.txt'), findsNothing);
        if (!listedBeforeRemoval) {
          // The preparation under way completes after the removal.
          fixture.projectChat(chatId);
          await settle(tester);
        }

        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        fixture.projectChat('chat-other', cursor: 30, title: 'Other chat');
        await settle(tester);
        await tester.selectTabFromSheet('Other chat');
        await settle(tester);

        await attachFiles(tester);
        await settle(tester);
        final uploads = listedBeforeRemoval ? 2 : 1;
        expect(fixture.repository.uploadCalls, hasLength(uploads));
        expect(find.text('notes.txt'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, 'chat-other');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-$uploads');
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // Review finding: a batch staged in the first chat waits in the upload
    // queue behind a removed file's held upload, so its preparation starts
    // only after a replacement that lists another chat. The batch still
    // belongs to the pairing and chat it was staged in.
    for (final recovery in ['chat listed again', 'files removed']) {
      testWidgets('CAN-4533 a batch queued before a replacement stays with '
          'its own chat (recovery: $recovery)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        final chatId = fixture.repository.createChatTabTargets.single.chatId!;
        final held = Completer<ChatAttachmentRef>();
        fixture.repository.uploadHandler = (_) => held.future;
        fixture.projectChat(chatId);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));

        // Remove the uploading file and attach another in the same chat.
        await tester.tap(
          find.byWidgetPredicate(
            (widget) =>
                widget.key is ValueKey<String> &&
                (widget.key! as ValueKey<String>).value.startsWith(
                  'attachment-remove-',
                ),
          ),
        );
        await settle(tester);
        expect(find.text('notes.txt'), findsNothing);
        fixture.picker.next = AttachmentPickResult(
          AttachmentPickerOutcome.picked,
          [FakeAttachmentPicker.file('second.txt', mediaType: 'text/plain')],
        );
        await attachFiles(tester);
        await settle(tester);
        expect(find.text('second.txt'), findsOneWidget);
        expect(fixture.repository.uploadCalls, hasLength(1));

        // A replacement lists only another chat; then the removed file's
        // upload completes and the queue moves on.
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        fixture.projectChat('chat-other', cursor: 30, title: 'Other chat');
        await settle(tester);
        fixture.repository.uploadHandler = null;
        held.complete(
          ChatAttachmentRef(
            attachmentId: 'held-1',
            filename: 'notes.txt',
            mediaType: 'text/plain',
            size: 1,
            contentSha256: 'a' * 64,
            storageKind: 'blob',
            source: '/fake',
          ),
        );
        await settle(tester);
        expect(fixture.repository.deleteAttachmentCalls, contains('held-1'));

        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.uploadCalls, hasLength(1));
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('second.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');

        if (recovery == 'chat listed again') {
          // The current pairing lists the batch's chat: Retry uploads and
          // Send goes there.
          fixture.projectChat(chatId, cursor: 31);
          await settle(tester);
          await waitOutSnackBar(tester);
          await tester.tap(retryControl);
          await settle(tester);
          expect(fixture.repository.uploadCalls, hasLength(2));
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          final sent = fixture.repository.sendChatMessageCalls.single;
          expect(sent.target.chatId, chatId);
          expect(sent.text, 'Keep me');
          expect(sent.options?.attachments?.single.attachmentId, 'fake-2');
        } else {
          // Removing the batch ends it; a new one goes to the chat chosen.
          await waitOutSnackBar(tester);
          await tester.tap(
            find.byWidgetPredicate(
              (widget) =>
                  widget.key is ValueKey<String> &&
                  (widget.key! as ValueKey<String>).value.startsWith(
                    'attachment-remove-',
                  ),
            ),
          );
          await settle(tester);
          await tester.selectTabFromSheet('Other chat');
          await settle(tester);
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'For the other chat',
          );
          await attachFiles(tester);
          await settle(tester);
          expect(fixture.repository.uploadCalls, hasLength(2));
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          final sent = fixture.repository.sendChatMessageCalls.single;
          expect(sent.target.chatId, 'chat-other');
          expect(sent.text, 'For the other chat');
          expect(sent.options?.attachments?.single.attachmentId, 'fake-2');
        }
        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    testWidgets(
      'CAN-4533 a chat unconfirmed before a replacement is not created in it',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep me',
        );
        await attachFiles(tester);
        fixture.reserve();
        await settle(tester);
        expect(fixture.repository.createChatTabTargets, hasLength(1));

        // The pairing is replaced before the desktop lists the first chat.
        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        await waitOutSnackBar(tester);
        await tester.tap(retryControl);
        await settle(tester);

        expect(fixture.repository.createChatTabTargets, hasLength(1));
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(draftText(tester), 'Keep me');
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    // Review finding: the platform picker can still be reading the chosen
    // files when the pairing is replaced and the app resumes. The pending
    // pick keeps the pairing and chat it started in, whatever the resume's
    // lost-media recovery returns, and nothing goes to the replacement's
    // chat until the user removes the files and attaches again there.
    for (final (:name, :recovered) in [
      (name: 'cancelled', recovered: AttachmentPickResult.cancelled),
      (
        name: 'unavailable',
        recovered: const AttachmentPickResult(
          AttachmentPickerOutcome.unavailable,
          [],
        ),
      ),
      (
        name: 'a lost photo',
        recovered: AttachmentPickResult(AttachmentPickerOutcome.picked, [
          FakeAttachmentPicker.file('lost.png'),
        ]),
      ),
    ]) {
      testWidgets('CAN-4533 a pick pending across a replacement and resume '
          'keeps its own chat (recovery: $name)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        // The worktree and its first chat exist before anything is staged.
        fixture.reserve();
        fixture.projectChat('chat-a', title: 'Chat A');
        await settle(tester);
        expect(find.text('Chat A'), findsOneWidget);
        final pick = fixture.picker.held = Completer<AttachmentPickResult>();
        await attachFiles(tester);
        expect(fixture.picker.filesCalls, 1);
        for (final state in [
          AppLifecycleState.inactive,
          AppLifecycleState.hidden,
          AppLifecycleState.paused,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }

        // The pairing is replaced while the picker is open. The replacement
        // lists the worktree with only another chat, which the screen shows.
        // A real disconnect clears the desktop's capabilities until the
        // replacement announces them.
        await disconnect(tester, viewModel, fixture);
        await settle(tester);
        await reconnect(tester, viewModel, fixture);
        await settle(tester);
        fixture.projectChat('chat-b', cursor: 30, title: 'Chat B');
        await settle(tester);
        fixture.picker.lost = recovered;
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        await settle(tester);
        expect(fixture.picker.recoverLostMediaCalls, 2);
        expect(find.text('Chat B'), findsOneWidget);

        // The original pick returns only now.
        pick.complete(
          AttachmentPickResult(AttachmentPickerOutcome.picked, [
            FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
          ]),
        );
        await settle(tester);
        await waitOutSnackBar(tester);
        // Retry cannot move the files to the chat shown.
        if (retryControl.evaluate().isNotEmpty) {
          await tester.tap(retryControl.first);
          await settle(tester);
        }
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(fixture.repository.sendChatMessageCalls, isEmpty);
        expect(find.text('notes.txt'), findsOneWidget);

        // Removing the files ends their batch; a new one is for the chat
        // shown now.
        await waitOutSnackBar(tester);
        final removeControl = find.byWidgetPredicate(
          (widget) =>
              widget.key is ValueKey<String> &&
              (widget.key! as ValueKey<String>).value.startsWith(
                'attachment-remove-',
              ),
        );
        while (removeControl.evaluate().isNotEmpty) {
          await tester.tap(removeControl.first);
          await settle(tester);
        }
        expect(find.text('notes.txt'), findsNothing);
        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, 'chat-b');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // A pick that returns no files across a replacement and resume leaves
    // no hold: the next attachment goes to the chat shown then.
    for (final (:name, :returned) in [
      (name: 'cancelled', returned: AttachmentPickResult.cancelled),
      (
        name: 'unavailable',
        returned: const AttachmentPickResult(
          AttachmentPickerOutcome.unavailable,
          [],
        ),
      ),
    ]) {
      testWidgets('CAN-4533 a pending pick that returns $name leaves no hold '
          'after a replacement and resume', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        fixture.reserve();
        fixture.projectChat('chat-a', title: 'Chat A');
        await settle(tester);
        final pick = fixture.picker.held = Completer<AttachmentPickResult>();
        await attachFiles(tester);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);

        // A real disconnect clears the desktop's capabilities until the
        // replacement announces them.
        await disconnect(tester, viewModel, fixture);
        await settle(tester);
        await reconnect(tester, viewModel, fixture);
        await settle(tester);
        fixture.projectChat('chat-b', cursor: 30, title: 'Chat B');
        await settle(tester);
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        await settle(tester);
        pick.complete(returned);
        await settle(tester);
        await waitOutSnackBar(tester);

        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        final sent = fixture.repository.sendChatMessageCalls.single;
        expect(sent.target.chatId, 'chat-b');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(fixture.repository.createChatTabTargets, isEmpty);
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // Review finding: a disconnect clears the desktop's capabilities. A pick
    // still under way then keeps its files for Retry in their own chat, and
    // one that returns nothing leaves no attach control behind.
    for (final returnsFiles in [true, false]) {
      testWidgets(
        'CAN-4533 a pick that returns ${returnsFiles ? 'files' : 'nothing'} '
        'while disconnected keeps them for its own chat',
        (tester) async {
          usePhoneViewport(tester);
          final fixture = _Fixture();
          final viewModel = await connect(tester, fixture);
          await tester.pumpWidget(subject(viewModel, fixture));
          await tester.pump();
          await tester.pump();
          fixture.reserve();
          fixture.projectChat('chat-a', title: 'Chat A');
          await settle(tester);
          final pick = fixture.picker.held = Completer<AttachmentPickResult>();
          await attachFiles(tester);

          await disconnect(tester, viewModel, fixture);
          await settle(tester);
          pick.complete(
            returnsFiles
                ? AttachmentPickResult(AttachmentPickerOutcome.picked, [
                    FakeAttachmentPicker.file(
                      'notes.txt',
                      mediaType: 'text/plain',
                    ),
                  ])
                : AttachmentPickResult.cancelled,
          );
          await settle(tester);
          await waitOutSnackBar(tester);
          expect(fixture.repository.uploadCalls, isEmpty);
          if (!returnsFiles) {
            expect(find.text('notes.txt'), findsNothing);
            expect(await composerAttachRowEnabled(tester), isNull);
          } else {
            expect(find.text('notes.txt'), findsOneWidget);
            expect(retryControl, findsOneWidget);
          }

          // The same desktop pairs again and lists the chat the files are for.
          await reconnect(tester, viewModel, fixture);
          await settle(tester);
          fixture.projectChat('chat-a', cursor: 30, title: 'Chat A');
          await settle(tester);
          if (returnsFiles) {
            await tester.tap(retryControl);
          } else {
            await attachFiles(tester);
          }
          await settle(tester);
          expect(fixture.repository.uploadCalls, hasLength(1));
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          final sent = fixture.repository.sendChatMessageCalls.single;
          expect(sent.target.chatId, 'chat-a');
          expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
          expect(fixture.repository.createChatTabTargets, isEmpty);
          expect(tester.takeException(), isNull);
          await tearDownScreen(tester, viewModel, fixture);
        },
      );
    }

    testWidgets(
      'CAN-4533 eight staged files fill the message before creation',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        fixture.picker.next = AttachmentPickResult(
          AttachmentPickerOutcome.picked,
          [
            for (var i = 0; i < 9; i++)
              FakeAttachmentPicker.file('file-$i.txt', mediaType: 'text/plain'),
          ],
        );
        final viewModel = await connect(tester, fixture);
        await tester.pumpWidget(subject(viewModel, fixture));
        await tester.pump();
        await tester.pump();
        await attachFiles(tester);
        await tester.pump();

        expect(
          find.text('Attach or mention up to 8 files per message.'),
          findsOneWidget,
        );
        await waitOutSnackBar(tester);
        expect(await composerAttachRowEnabled(tester), isFalse);
        expect(fixture.repository.uploadCalls, isEmpty);
        expect(tester.takeException(), isNull);
        fixture.createResult.completeError(
          const RemoteControlException('stop'),
        );
        await tearDownScreen(tester, viewModel, fixture);
      },
    );

    for (final removeFile in [false, true]) {
      final after = removeFile ? 'removing the file' : 'Retry';
      testWidgets('CAN-4533 an existing chat holds no tab for its files across '
          'a replacement listing only another chat ($after)', (tester) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        void projectChats(List<(String, String, bool)> chats, int cursor) {
          fixture.repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateDeltaEvent(
                  chatSummaries: [
                    for (final (chatId, title, active) in chats)
                      RemoteChatSummary(
                        chatId: chatId,
                        scope: RemoteChatScope.worktree,
                        workspaceLocalId: 'ws-app',
                        worktreeLocalId: 'wt-1',
                        title: title,
                        active: active,
                      ),
                  ],
                ),
              ],
              nextCursor: cursor,
            ),
          );
        }

        final viewModel = await connect(tester, fixture);
        projectChats([
          ('chat-x', 'Chat X', true),
          ('chat-y', 'Chat Y', false),
        ], 10);
        await tester.pumpWidget(
          subject(
            viewModel,
            fixture,
            home: RemoteChatScreen.worktree(
              worktree: _existing,
              initialChatId: 'chat-x',
              attachmentPicker: fixture.picker,
            ),
          ),
        );
        await settle(tester);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Hello',
        );
        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));

        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await settle(tester);
        projectChats([('chat-y', 'Chat Y', true)], 30);
        await settle(tester);

        // As before CAN-4533: the screen follows the chat the pairing lists.
        expect(find.text('Chat Y'), findsOneWidget);
        expect(find.text('New chat'), findsNothing);
        expect(find.text('notes.txt'), findsOneWidget);
        if (removeFile) {
          await tester.tap(
            find.byWidgetPredicate(
              (widget) =>
                  widget.key is ValueKey<String> &&
                  (widget.key! as ValueKey<String>).value.startsWith(
                    'attachment-remove-',
                  ),
            ),
          );
          await settle(tester);
          expect(find.text('Chat Y'), findsOneWidget);
          expect(find.text('New chat'), findsNothing);
        } else {
          await waitOutSnackBar(tester);
          if (retryControl.evaluate().isNotEmpty) {
            await tester.tap(retryControl);
            await settle(tester);
          }
        }
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        await settle(tester);

        final sentTo = [
          for (final call in fixture.repository.sendChatMessageCalls)
            switch (call.target) {
              RemoteWorktreeChatTarget(:final chatId) => chatId,
              final other => '$other',
            },
        ];
        expect(sentTo, removeFile ? isEmpty : ['chat-y']);
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    // A pick still reading its files keeps the strip's controller across a
    // replacement, while a send that took the ready files is in flight. The
    // send then fails with an unknown outcome, which the replacement cannot
    // reconcile; the files it took must not come back with the old pairing's
    // upload references.
    for (final (change, disconnects, reconnects) in [
      ('a replacement pairing', true, true),
      ('a disconnect', true, false),
      ('the same pairing', false, false),
    ]) {
      testWidgets('CAN-4533 a send that fails after $change restores its '
          'files with upload references from the current pairing', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final fixture = _Fixture();
        void projectChatX(int cursor) =>
            fixture.repository.eventsController.add(
              RemotePortalEventBatch(
                events: [
                  RemoteStateDeltaEvent(
                    chatSummaries: [
                      const RemoteChatSummary(
                        chatId: 'chat-x',
                        scope: RemoteChatScope.worktree,
                        workspaceLocalId: 'ws-app',
                        worktreeLocalId: 'wt-1',
                        title: 'Chat X',
                        active: true,
                      ),
                    ],
                  ),
                ],
                nextCursor: cursor,
              ),
            );

        final viewModel = await connect(tester, fixture);
        projectChatX(10);
        await tester.pumpWidget(
          subject(
            viewModel,
            fixture,
            home: RemoteChatScreen.worktree(
              worktree: _existing,
              initialChatId: 'chat-x',
              attachmentPicker: fixture.picker,
            ),
          ),
        );
        await settle(tester);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Hello',
        );
        await attachFiles(tester);
        await settle(tester);
        expect(fixture.repository.uploadCalls, hasLength(1));

        // The second pick is still reading its file when Send is tapped.
        final pick = fixture.picker.held = Completer<AttachmentPickResult>();
        await attachFiles(tester);
        final send = Completer<RemoteChatSendResult>();
        fixture.repository.sendChatMessageHandler = () => send.future;
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.sendChatMessageCalls, hasLength(1));

        if (disconnects) {
          await disconnect(tester, viewModel, fixture);
          await settle(tester);
        }
        if (reconnects) {
          await reconnect(tester, viewModel, fixture);
          projectChatX(30);
          await settle(tester);
        }
        send.completeError(
          const RemoteChatSendOutcomeUnknownException('The send timed out.'),
        );
        await settle(tester);
        await waitOutSnackBar(tester);
        pick.complete(AttachmentPickResult.cancelled);
        await settle(tester);

        // The bytes stay; only the current pairing's upload is sent.
        expect(find.text('notes.txt'), findsOneWidget);
        if (disconnects && !reconnects) {
          // Nothing can upload until a desktop pairs again.
          expect(retryControl, findsOneWidget);
          expect(sendAction(tester), isNull);
          await reconnect(tester, viewModel, fixture);
          projectChatX(30);
          await settle(tester);
          await tester.tap(retryControl);
          await settle(tester);
        }
        expect(retryControl, findsNothing);
        expect(draftText(tester), 'Hello');
        fixture.repository.sendChatMessageHandler = null;
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        await tester.pump();
        await settle(tester);

        final calls = fixture.repository.sendChatMessageCalls;
        expect(calls, hasLength(2));
        expect(
          calls.last.options?.attachments?.map((ref) => ref.attachmentId),
          [disconnects ? 'fake-2' : 'fake-1'],
        );
        expect(fixture.repository.uploadCalls, hasLength(disconnects ? 2 : 1));
        expect(tester.takeException(), isNull);
        await tearDownScreen(tester, viewModel, fixture);
      });
    }

    testWidgets('CAN-4533 a first send that fails after a replacement pairing '
        'uploads its files again for the first chat', (tester) async {
      usePhoneViewport(tester);
      final fixture = _Fixture();
      final viewModel = await connect(tester, fixture);
      await tester.pumpWidget(subject(viewModel, fixture));
      await tester.pump();
      await tester.pump();
      fixture.reserve();
      await settle(tester);
      fixture.projectChat('chat-a', title: 'Chat A');
      await settle(tester);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Hello',
      );
      await attachFiles(tester);
      await settle(tester);
      expect(fixture.repository.uploadCalls, hasLength(1));

      final pick = fixture.picker.held = Completer<AttachmentPickResult>();
      await attachFiles(tester);
      final send = Completer<RemoteChatSendResult>();
      fixture.repository.sendChatMessageHandler = () => send.future;
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      await disconnect(tester, viewModel, fixture);
      await settle(tester);
      await reconnect(tester, viewModel, fixture);
      fixture.projectChat('chat-a', cursor: 30, title: 'Chat A');
      await settle(tester);
      send.completeError(
        const RemoteChatSendOutcomeUnknownException('The send timed out.'),
      );
      await settle(tester);
      await waitOutSnackBar(tester);
      pick.complete(AttachmentPickResult.cancelled);
      await settle(tester);

      expect(find.text('notes.txt'), findsOneWidget);
      expect(retryControl, findsNothing);
      expect(draftText(tester), 'Hello');
      fixture.repository.sendChatMessageHandler = null;
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.pump();
      await settle(tester);

      final sent = fixture.repository.sendChatMessageCalls.last;
      expect(sent.target.chatId, 'chat-a');
      expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
        'fake-2',
      ]);
      expect(fixture.repository.uploadCalls, hasLength(2));
      expect(fixture.repository.createChatTabTargets, isEmpty);
      expect(tester.takeException(), isNull);
      await tearDownScreen(tester, viewModel, fixture);
    });
  });
}
