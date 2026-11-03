// CAN-4533 device acceptance: a new task in a worktree project stages files
// while its worktree is created, with the real platform keyboard. The files
// upload once the worktree and its first chat exist and go with the first
// message. Run from apps/mobile:
//
//   flutter test integration_test/can_4533_new_task_attachments_device_test.dart \
//     -d <device-id>
//
// Synthetic fixtures only: no account, desktop, or network.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:provider/provider.dart';

import '../test/support/chat_tabs_sheet_driver.dart';
import '../test/support/fake_attachment_picker.dart';
import '../test/support/fake_remote_control_repository.dart';
import '../test/support/tiny_png.dart';

const _workspace = RemoteWorkspace(
  localId: 'ws-app',
  order: 0,
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
);

const _created = RemoteWorktree(
  localId: 'wt-2',
  workspaceLocalId: 'ws-app',
  branch: 'canopy/otter',
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final draft = find.byKey(const ValueKey('composer-draft'));

  double keyboard(WidgetTester tester) => tester.view.viewInsets.bottom;

  /// Pumps for [frames] tenths of a second. The worktree create shows a
  /// looping spinner, so the screen never settles while it runs.
  Future<void> settle(WidgetTester tester, {int frames = 15}) async {
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  /// Waits for the platform keyboard to finish opening or closing.
  Future<void> settleKeyboard(WidgetTester tester) =>
      settle(tester, frames: 25);

  String draftText(WidgetTester tester) =>
      tester.widget<TextField>(draft).controller!.text;

  VoidCallback? sendAction(WidgetTester tester) => tester
      .widget<CanopyComposerAction>(find.byKey(const ValueKey('composer-send')))
      .onPressed;

  /// A tree workspace's new-task screen whose worktree create waits for the
  /// returned completer; completing it with null rejects the create. The
  /// rejection is thrown inside the create call rather than delivered as a
  /// completer error, which a later test's zone would report as uncaught.
  Future<
    ({
      FakeRemoteControlRepository repository,
      RemoteControlViewModel viewModel,
      List<RemoteWorktree> worktrees,
      Completer<RemoteWorktreeCreateResult?> create,
    })
  >
  pumpNewTask(
    WidgetTester tester,
    FakeAttachmentPicker? picker, {
    AttachmentCache? attachmentCache,
  }) async {
    final worktrees = <RemoteWorktree>[
      const RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-app',
        branch: 'feature/oauth',
      ),
    ];
    final create = Completer<RemoteWorktreeCreateResult?>();
    final repository = FakeRemoteControlRepository()
      ..supportsChatAttachments = true
      ..createWorktreeHandler = (() async =>
          await create.future ??
          (throw const RemoteControlException(
            'The desktop could not create it.',
          )))
      ..snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [_workspace],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
    final viewModel = RemoteControlViewModel(
      repository: repository,
      attachmentCache: attachmentCache,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          navigatorObservers: [appRouteObserver],
          theme: AppTheme.light,
          home: RemoteChatScreen.create(
            workspace: _workspace,
            attachmentPicker: picker,
          ),
        ),
      ),
    );
    await settle(tester);
    return (
      repository: repository,
      viewModel: viewModel,
      worktrees: worktrees,
      create: create,
    );
  }

  void projectChat(
    FakeRemoteControlRepository repository,
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

  final retryControl = find.byWidgetPredicate(
    (widget) =>
        widget.key is ValueKey<String> &&
        (widget.key! as ValueKey<String>).value.startsWith('attachment-retry-'),
  );

  final removeControl = find.byWidgetPredicate(
    (widget) =>
        widget.key is ValueKey<String> &&
        (widget.key! as ValueKey<String>).value.startsWith(
          'attachment-remove-',
        ),
  );

  /// Reserves the new task's worktree, so the desktop is asked for its
  /// first chat.
  Future<String> reserve(
    WidgetTester tester,
    ({
      FakeRemoteControlRepository repository,
      RemoteControlViewModel viewModel,
      List<RemoteWorktree> worktrees,
      Completer<RemoteWorktreeCreateResult?> create,
    })
    task,
  ) async {
    task.worktrees.add(_created);
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    return task.repository.createChatTabTargets.single.chatId!;
  }

  /// Replaces the pairing with one that lists only another chat.
  Future<void> replaceWithOtherChat(
    WidgetTester tester,
    FakeRemoteControlRepository repository,
    RemoteControlViewModel viewModel,
  ) async {
    // A real disconnect clears the desktop's capabilities until the
    // replacement announces them.
    repository.supportsChatAttachments = false;
    await viewModel.disconnect();
    await settle(tester);
    repository.supportsChatAttachments = true;
    await viewModel.connect('654321');
    await settle(tester, frames: 50);
    projectChat(repository, 'chat-other', cursor: 30, title: 'Other chat');
    await settle(tester, frames: 50);
  }

  /// Picks files again from the `+` sheet.
  Future<void> attachAgain(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(
      find.byKey(const ValueKey('composer-action-attach-files')),
    );
    await settle(tester, frames: 30);
  }

  /// Types with the platform keyboard, then picks files from the `+` sheet.
  Future<void> typeAndAttach(WidgetTester tester, String text) async {
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, text);
    await settle(tester);
    expect(keyboard(tester), greaterThan(0));

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);
    for (final key in const [
      'composer-action-attach-camera',
      'composer-action-attach-library',
      'composer-action-attach-files',
    ]) {
      expect(tester.widget<ListTile>(find.byKey(ValueKey(key))).enabled, true);
    }
    await tester.tap(
      find.byKey(const ValueKey('composer-action-attach-files')),
    );
    await settle(tester);
  }

  testWidgets('CAN-4533 a staged file goes with the first message once the '
      'worktree and its chat exist', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
        FakeAttachmentPicker.file('notes.txt', mediaType: 'text/plain'),
      ]);
    final task = await pumpNewTask(tester, picker);
    expect(find.text('Creating worktree…'), findsOneWidget);

    await typeAndAttach(tester, 'Fix the login redirect');
    expect(find.text('plan.png'), findsOneWidget);
    expect(find.text('notes.txt'), findsOneWidget);
    expect(task.repository.uploadCalls, isEmpty);
    expect(sendAction(tester), isNull);

    task.worktrees.add(
      const RemoteWorktree(
        localId: 'wt-2',
        workspaceLocalId: 'ws-app',
        branch: 'canopy/otter',
        setupPhase: RemoteWorktreeSetupPhase.gitPending,
      ),
    );
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(task.repository.uploadCalls, isEmpty);
    expect(task.repository.createChatTabTargets, isEmpty);

    task.worktrees[1] = _created;
    await settle(tester);
    expect(find.text('canopy/otter'), findsOneWidget);
    final chatId = task.repository.createChatTabTargets.single.chatId!;
    expect(task.repository.uploadCalls, isEmpty);
    expect(sendAction(tester), isNull);

    projectChat(task.repository, chatId);
    await settle(tester);
    expect(task.repository.uploadCalls.map((call) => call.filename), [
      'plan.png',
      'notes.txt',
    ]);
    expect(draftText(tester), 'Fix the login redirect');

    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, chatId);
    expect(
      (sent.target as RemoteWorktreeChatTarget).worktreeLocalId,
      _created.localId,
    );
    expect(sent.text, 'Fix the login redirect');
    expect(sent.options?.attachments?.map((ref) => ref.filename), [
      'plan.png',
      'notes.txt',
    ]);
    expect(task.repository.createWorktreeCalls, hasLength(1));
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 a rejected worktree keeps the draft and file, and '
      'Retry sends them', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');

    task.create.complete(null);
    await settle(tester);
    expect(find.text('plan.png'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');
    expect(task.repository.uploadCalls, isEmpty);

    final retried = Completer<RemoteWorktreeCreateResult>();
    task.repository.createWorktreeHandler = () => retried.future;
    await tester.tap(find.byKey(const ValueKey('attachment-retry-att-1')));
    await settle(tester);
    task.worktrees.add(_created);
    retried.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create-2',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    final chatId = task.repository.createChatTabTargets.single.chatId!;
    projectChat(task.repository, chatId);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));

    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, chatId);
    expect(sent.text, 'Keep this draft');
    expect(sent.options?.attachments?.single.filename, 'plan.png');
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 a replaced pairing keeps the file and uploads it again '
      'only on Retry', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');
    task.worktrees.add(_created);
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    final chatId = task.repository.createChatTabTargets.single.chatId!;

    // The new pairing has not announced attachments when it connects.
    await task.viewModel.disconnect();
    task.repository.supportsChatAttachments = false;
    await task.viewModel.connect('654321');
    await settle(tester);
    projectChat(task.repository, chatId);
    await settle(tester);

    expect(task.repository.uploadCalls, isEmpty);
    expect(task.repository.sendChatMessageCalls, isEmpty);
    expect(find.text('plan.png'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');

    // Attachments are announced again; Retry uploads in the new session.
    task.repository.supportsChatAttachments = true;
    await task.viewModel.refresh();
    await settle(tester, frames: 50);
    expect(find.text('plan.png'), findsOneWidget);
    expect(task.repository.uploadCalls, isEmpty);
    await tester.tap(retryControl);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));
    await settle(tester, frames: 50);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, chatId);
    expect(sent.text, 'Keep this draft');
    expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 after a replaced pairing, Retry waits until the '
      'current session lists the task chat, not another one', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');
    task.worktrees.add(_created);
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    final chatId = task.repository.createChatTabTargets.single.chatId!;
    projectChat(task.repository, chatId);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));

    // The old pairing's late projection lands nowhere. The new pairing
    // lists the same worktree ids, then only another chat.
    await task.viewModel.disconnect();
    projectChat(task.repository, chatId, cursor: 15);
    await task.viewModel.connect('654321');
    await settle(tester, frames: 50);
    projectChat(task.repository, 'chat-other', cursor: 17);
    await settle(tester, frames: 50);
    expect(draftText(tester), 'Keep this draft');
    expect(find.text('plan.png'), findsOneWidget);
    await tester.tap(retryControl);
    await settle(tester, frames: 50);
    expect(task.repository.uploadCalls, hasLength(1));
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(sendAction(tester), isNull);
    expect(task.repository.sendChatMessageCalls, isEmpty);
    expect(find.text('plan.png'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');

    // The current session lists the task chat while the other one is
    // active: Retry uploads, and Send goes to the task chat.
    projectChat(task.repository, chatId, cursor: 20, active: false);
    projectChat(task.repository, 'chat-other', cursor: 21);
    await settle(tester);
    await tester.tap(retryControl);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(2));
    await settle(tester, frames: 50);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, chatId);
    expect(sent.text, 'Keep this draft');
    expect(sent.options?.attachments?.single.attachmentId, 'fake-2');
    expect(task.repository.createWorktreeCalls, hasLength(1));
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 files whose first chat was rejected never go to a '
      "replacement's other chat", (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');
    await reserve(tester, task);
    task.repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            message: 'The tab could not be created.',
            commandId: task.repository.createChatTabCommandIds.single,
          ),
        ],
        nextCursor: 20,
      ),
    );
    await settle(tester, frames: 50);
    expect(task.repository.uploadCalls, isEmpty);

    await replaceWithOtherChat(tester, task.repository, task.viewModel);
    await tester.tap(retryControl);
    await settle(tester, frames: 50);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    expect(task.repository.uploadCalls, isEmpty);
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(task.repository.sendChatMessageCalls, isEmpty);
    expect(find.text('plan.png'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');

    // Removing the file ends its batch; files attached now are for the
    // chat shown.
    await tester.tap(removeControl);
    await settle(tester);
    expect(find.text('plan.png'), findsNothing);
    await attachAgain(tester);
    expect(task.repository.uploadCalls, hasLength(1));
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, 'chat-other');
    expect(sent.text, 'Keep this draft');
    expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 files removed before the first send leave no hold '
      'on a new batch after a replaced pairing', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');
    final chatId = await reserve(tester, task);
    projectChat(task.repository, chatId);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));
    await tester.tap(removeControl);
    await settle(tester);
    expect(find.text('plan.png'), findsNothing);

    await replaceWithOtherChat(tester, task.repository, task.viewModel);
    await tester.selectTabFromSheet('Other chat');
    await settle(tester);
    // Each chat keeps its own draft, so the other chat starts empty.
    expect(draftText(tester), isEmpty);
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, 'For the other chat');
    await settle(tester);
    await attachAgain(tester);
    expect(task.repository.uploadCalls, hasLength(2));
    expect(find.text('plan.png'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, 'chat-other');
    expect(sent.text, 'For the other chat');
    expect(sent.options?.attachments?.single.attachmentId, 'fake-2');
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 a pick still reading its file across a replaced '
      'pairing and resume keeps it from the other chat', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('second.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    // The worktree and the desktop's own first chat exist before any file.
    task.worktrees.add(_created);
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    projectChat(task.repository, 'chat-a', title: 'Chat A');
    await settle(tester);
    expect(find.text('Chat A'), findsOneWidget);

    final pick = picker.held = Completer<AttachmentPickResult>();
    await attachAgain(tester);
    expect(picker.filesCalls, 1);
    await replaceWithOtherChat(tester, task.repository, task.viewModel);
    // The app resumes while the picker still reads the file.
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await settle(tester);
    expect(picker.recoverLostMediaCalls, 2);
    expect(find.text('Other chat'), findsOneWidget);

    pick.complete(
      AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]),
    );
    await settle(tester, frames: 30);
    expect(find.text('plan.png'), findsOneWidget);
    if (retryControl.evaluate().isNotEmpty) {
      await tester.tap(retryControl.first);
      await settle(tester, frames: 30);
    }
    expect(sendAction(tester), isNull);
    expect(task.repository.uploadCalls, isEmpty);
    expect(task.repository.createChatTabTargets, isEmpty);
    expect(task.repository.sendChatMessageCalls, isEmpty);

    // Removing the file ends its batch; a new one is for the chat shown.
    // The failure snackbar goes away first.
    await settle(tester, frames: 40);
    await tester.tap(removeControl);
    await settle(tester);
    expect(find.text('plan.png'), findsNothing);
    await attachAgain(tester);
    expect(task.repository.uploadCalls, hasLength(1));
    expect(find.text('second.png'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, 'chat-other');
    expect(sent.options?.attachments?.single.filename, 'second.png');
    expect(task.repository.createChatTabTargets, isEmpty);
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  // Review finding: a send that took the ready file is in flight while the
  // picker still reads another, and the pairing is replaced. The send's
  // outcome is then unknown and cannot be reconciled in the new pairing.
  // The file comes back with an upload from the current pairing only.
  testWidgets('CAN-4533 a first send that fails after a replaced pairing '
      'uploads its file again for the first chat', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    task.worktrees.add(_created);
    task.create.complete(
      const RemoteWorktreeCreateResult(
        commandId: 'cmd-create',
        worktreeLocalId: 'wt-2',
      ),
    );
    await settle(tester);
    projectChat(task.repository, 'chat-a', title: 'Chat A');
    await settle(tester);
    await typeAndAttach(tester, 'Fix the login redirect');
    await settle(tester, frames: 30);
    expect(task.repository.uploadCalls, hasLength(1));

    final pick = picker.held = Completer<AttachmentPickResult>();
    await attachAgain(tester);
    final send = Completer<RemoteChatSendResult>();
    task.repository.sendChatMessageHandler = () => send.future;
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    expect(task.repository.sendChatMessageCalls, hasLength(1));
    task.repository.supportsChatAttachments = false;
    await task.viewModel.disconnect();
    await settle(tester);
    task.repository.supportsChatAttachments = true;
    await task.viewModel.connect('654321');
    await settle(tester, frames: 50);
    projectChat(task.repository, 'chat-a', cursor: 30, title: 'Chat A');
    await settle(tester, frames: 50);
    send.completeError(
      const RemoteChatSendOutcomeUnknownException('The send timed out.'),
    );
    await settle(tester, frames: 50);
    pick.complete(AttachmentPickResult.cancelled);
    await settle(tester, frames: 30);

    expect(find.text('plan.png'), findsOneWidget);
    expect(retryControl, findsNothing);
    expect(draftText(tester), 'Fix the login redirect');
    expect(task.repository.uploadCalls, hasLength(2));
    task.repository.sendChatMessageHandler = null;
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.last;
    expect(sent.target.chatId, 'chat-a');
    expect(sent.options?.attachments?.map((ref) => ref.attachmentId), [
      'fake-2',
    ]);
    expect(task.repository.createChatTabTargets, isEmpty);
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 a batch queued behind a removed upload stays with '
      'its chat through a replaced pairing', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final task = await pumpNewTask(tester, picker);
    await typeAndAttach(tester, 'Keep this draft');
    final chatId = await reserve(tester, task);
    final held = Completer<ChatAttachmentRef>();
    task.repository.uploadHandler = (_) => held.future;
    projectChat(task.repository, chatId);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));

    // The removed file's upload still blocks the queue when the next batch
    // is attached in the same chat.
    await tester.tap(removeControl);
    await settle(tester);
    picker.next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
      FakeAttachmentPicker.file('second.png'),
    ]);
    await attachAgain(tester);
    expect(find.text('second.png'), findsOneWidget);
    expect(task.repository.uploadCalls, hasLength(1));

    await replaceWithOtherChat(tester, task.repository, task.viewModel);
    task.repository.uploadHandler = null;
    held.complete(
      ChatAttachmentRef(
        attachmentId: 'held-1',
        filename: 'plan.png',
        mediaType: 'image/png',
        size: 3,
        contentSha256: 'a' * 64,
        storageKind: 'blob',
        source: '/fake',
      ),
    );
    await settle(tester);
    expect(task.repository.deleteAttachmentCalls, contains('held-1'));
    await tester.tap(retryControl);
    await settle(tester, frames: 50);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(1));
    expect(task.repository.sendChatMessageCalls, isEmpty);
    expect(find.text('second.png'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');

    // The current pairing lists the batch's chat: Retry uploads and Send
    // goes there.
    projectChat(task.repository, chatId, cursor: 31);
    await settle(tester, frames: 50);
    await tester.tap(retryControl);
    await settle(tester);
    expect(task.repository.uploadCalls, hasLength(2));
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = task.repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, chatId);
    expect(sent.text, 'Keep this draft');
    expect(sent.options?.attachments?.single.attachmentId, 'fake-2');
    expect(task.repository.createChatTabTargets, hasLength(1));
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });

  testWidgets('CAN-4533 an existing chat follows a replaced pairing that '
      'lists only another chat', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    const existing = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-app',
      branch: 'feature/oauth',
    );
    final repository = FakeRemoteControlRepository()
      ..supportsChatAttachments = true
      ..snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [_workspace],
        worktrees: [existing],
        standaloneChats: [],
      );
    void projectChats(List<(String, String, bool)> chats, int cursor) {
      repository.eventsController.add(
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

    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
      worktreeCreateRecoveryInterval: Duration.zero,
    );
    await viewModel.connect('123456');
    projectChats([
      ('chat-x', 'Chat X', true),
      ('chat-other', 'Other chat', false),
    ], 10);
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          navigatorObservers: [appRouteObserver],
          theme: AppTheme.light,
          home: RemoteChatScreen.worktree(
            worktree: existing,
            initialChatId: 'chat-x',
            attachmentPicker: picker,
          ),
        ),
      ),
    );
    await settle(tester);
    await typeAndAttach(tester, 'Hello');
    expect(repository.uploadCalls, hasLength(1));

    await viewModel.disconnect();
    await viewModel.connect('654321');
    await settle(tester, frames: 50);
    projectChats([('chat-other', 'Other chat', true)], 30);
    await settle(tester, frames: 50);
    // As before CAN-4533: the screen follows the chat the pairing lists.
    expect(find.text('Other chat'), findsOneWidget);
    expect(find.text('New chat'), findsNothing);
    expect(find.text('plan.png'), findsOneWidget);

    await tester.tap(removeControl);
    await settle(tester);
    expect(find.text('Other chat'), findsOneWidget);
    expect(find.text('New chat'), findsNothing);
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, 'For the other chat');
    await settle(tester);
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await settle(tester);
    final sent = repository.sendChatMessageCalls.single;
    expect(sent.target.chatId, 'chat-other');
    expect(sent.text, 'For the other chat');
    expect(tester.takeException(), isNull);
    viewModel.dispose();
  });

  // Review finding: the platform picker's copy of a new task's photo is
  // recorded once its worktree exists, so archiving the worktree reclaims
  // it from the app's real temporary directory. Only the system camera
  // screen is replaced: its channel returns a copy the test wrote there.
  testWidgets('CAN-4533 a camera copy taken while the worktree is created '
      'is reclaimed with it', (tester) async {
    final copy = File(
      p.join(
        (await getTemporaryDirectory()).path,
        'can-4533-camera-${DateTime.now().microsecondsSinceEpoch}.png',
      ),
    );
    await copy.writeAsBytes(tinyPngBytes);
    addTearDown(() async {
      if (await copy.exists()) await copy.delete();
    });
    const pickImages =
        'dev.flutter.pigeon.image_picker_android.ImagePickerApi.pickImages';
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMessageHandler(
      pickImages,
      (_) async => const StandardMessageCodec().encodeMessage(<Object?>[
        <Object?>[copy.path],
      ]),
    );
    addTearDown(() => messenger.setMockMessageHandler(pickImages, null));
    final cache = AttachmentCache();
    final task = await pumpNewTask(tester, null, attachmentCache: cache);

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(
      find.byKey(const ValueKey('composer-action-attach-camera')),
    );
    await settle(tester, frames: 30);
    expect(find.text('Creating worktree…'), findsOneWidget);
    expect(task.repository.uploadCalls, isEmpty);

    final chatId = await reserve(tester, task);
    projectChat(task.repository, chatId);
    await settle(tester, frames: 30);
    expect(task.repository.uploadCalls.single.filename, p.basename(copy.path));
    expect(await copy.exists(), isTrue);

    // Archiving the worktree reclaims the copy.
    await cache.clear('ws-app', 'wt-2');
    expect(await copy.exists(), isFalse);
    expect(tester.takeException(), isNull);
    task.viewModel.dispose();
  });
}
