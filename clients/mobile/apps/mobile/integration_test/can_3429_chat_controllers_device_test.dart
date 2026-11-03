// CAN-3429 — device regression flows for the Remote chat controllers. Run
// from apps/mobile with an explicit Android device:
//
//   flutter test integration_test/can_3429_chat_controllers_device_test.dart \
//     -d <device-id>
//
// The real RemoteChatScreen and RemoteControlViewModel run against the
// synthetic repository in test/support/chat_controllers_fixture.dart: no
// desktop, account, or network. The flows cover provisional tab creates and
// closes settled by command outcomes, composer overrides released by
// projections, late outcomes and transport failures from a replaced
// session, the draft through a close that fails before the next frame,
// standalone send options, retry attachments that outlive the screen and
// the attachment capability, the PR poll's visibility gating, and the
// transcript's scroll position. Screenshots live in the separate capture
// harness.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/chat/widgets/composer_controls.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/chat_controllers_fixture.dart';
import '../test/support/composer_driver.dart';
import '../test/support/fake_attachment_picker.dart';

const _sheetAnimation = Duration(milliseconds: 400);
const _draftKey = ValueKey('composer-draft');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<RemoteControlViewModel> open(
    WidgetTester tester,
    ChatControllersRepository repository, {
    AttachmentPicker? picker,
    GlobalKey<NavigatorState>? navigatorKey,
    String? standaloneChatId,
  }) async {
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(
      chatControllersHost(
        viewModel,
        themeMode: ThemeMode.light,
        attachmentPicker: picker,
        navigatorKey: navigatorKey,
        standaloneChat: standaloneChatId == null
            ? null
            : viewModel.standaloneChatById(standaloneChatId),
      ),
    );
    await tester.pumpAndSettle();
    return viewModel;
  }

  Future<void> close(WidgetTester tester, RemoteControlViewModel vm) async {
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    vm.dispose();
  }

  Future<void> openSheet(WidgetTester tester) async {
    await tester.pump(_sheetAnimation);
    await tester.tap(find.byKey(const ValueKey('chat-tabs-fab')));
    await tester.pumpAndSettle();
  }

  Future<void> dismissSheet(WidgetTester tester) async {
    Navigator.of(
      tester.element(find.byKey(const ValueKey('new-chat-button'))),
    ).pop();
    await tester.pumpAndSettle();
  }

  Future<String> newChat(
    WidgetTester tester,
    ChatControllersRepository repository,
  ) async {
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('new-chat-button')));
    await tester.pumpAndSettle();
    return repository.createChatTabTargets.last.chatId!;
  }

  Future<void> selectTab(WidgetTester tester, String chatId) async {
    await openSheet(tester);
    await tester.tap(find.byKey(ValueKey('chat-tab-$chatId')));
    await tester.pumpAndSettle();
  }

  Finder row(String chatId) => find.byKey(ValueKey('chat-tab-$chatId'));
  bool isSelected(WidgetTester tester, String chatId) =>
      tester.widget<ListTile>(row(chatId)).selected;
  String draftText(WidgetTester tester) =>
      tester.widget<TextField>(find.byKey(_draftKey)).controller!.text;
  ComposerControlsData controls(WidgetTester tester) =>
      tester.widget<ChatInput>(find.byType(ChatInput)).controls!;
  bool? planEnabled(WidgetTester tester) => controls(tester).planMode?.enabled;
  Finder transcript() => find.byKey(const ValueKey('remote-chat-transcript'));

  testWidgets('tab creates and closes settle from command outcomes', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final vm = await open(tester, repository);
    expect(find.textContaining('Release checklist'), findsOneWidget);
    await tester.enterText(find.byKey(_draftKey), 'Keep this draft');
    await tester.pumpAndSettle();

    // D-01: two provisional tabs appear at once; the newer is selected.
    final older = await newChat(tester, repository);
    final newer = await newChat(tester, repository);
    await openSheet(tester);
    expect(row(older), findsOneWidget);
    expect(row(newer), findsOneWidget);
    expect(isSelected(tester, newer), isTrue);
    await dismissSheet(tester);

    // D-02: the older create fails; the newer is projected and stays shown.
    repository.createResponses[0].complete('create-older');
    repository.createResponses[1].complete('create-newer');
    await tester.pumpAndSettle();
    repository.fail('create-older', 'The tab could not be created.');
    await tester.pumpAndSettle();
    repository.projected.add(newer);
    await vm.refresh();
    await tester.pumpAndSettle();
    await openSheet(tester);
    expect(row(older), findsNothing);
    expect(
      find.descendant(of: row(newer), matching: find.text('Saved chat')),
      findsOneWidget,
    );
    expect(isSelected(tester, newer), isTrue);
    await dismissSheet(tester);
    vm.clearCommandFailure();
    await tester.pumpAndSettle();

    // D-03: closing the selected tab hides it; after the user picks another
    // chat, the rejected close lists it again without reselecting it.
    await selectTab(tester, 'chat-a');
    expect(draftText(tester), 'Keep this draft');
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-a')));
    await tester.pumpAndSettle();
    await openSheet(tester);
    expect(row('chat-a'), findsNothing);
    await dismissSheet(tester);
    await selectTab(tester, 'chat-b');
    repository.closeResponses.single.complete('close-a');
    await tester.pumpAndSettle();
    repository.fail('close-a', 'The tab could not be closed.');
    await tester.pumpAndSettle();
    expect(find.textContaining('flaky test waits'), findsOneWidget);
    await openSheet(tester);
    expect(row('chat-a'), findsOneWidget);
    expect(isSelected(tester, 'chat-b'), isTrue);
    await dismissSheet(tester);

    // D-10: the first chat's transcript and draft survive reconciliation;
    // the scroll-position test below covers the rest of the flow.
    await selectTab(tester, 'chat-a');
    expect(find.textContaining('Release checklist'), findsOneWidget);
    expect(draftText(tester), 'Keep this draft');
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('composer overrides settle at the first newer projection', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final vm = await open(tester, repository);

    // D-04: each chip flips at once and holds until completion plus a newer
    // projection, which is authoritative even when it differs. The desktop
    // here keeps its old values, so release shows as a return to them.
    Future<void> settles(
      String field, {
      required Future<void> Function() change,
      required List<Completer<String>> responses,
      required Object? Function() read,
      required Object chosen,
      required Object projected,
    }) async {
      expect(read(), projected, reason: '$field before the change');
      await change();
      expect(read(), chosen, reason: '$field applies at once');
      final commandId = '$field-1';
      responses.single.complete(commandId);
      await tester.pumpAndSettle();
      await vm.refresh();
      await tester.pumpAndSettle();
      expect(read(), chosen, reason: '$field holds before completion');
      repository.complete(commandId);
      await tester.pumpAndSettle();
      expect(read(), chosen, reason: '$field holds until a newer projection');
      await vm.refresh();
      await tester.pumpAndSettle();
      expect(read(), projected, reason: '$field follows the projection');
    }

    await settles(
      'plan',
      change: () async {
        await toggleComposerPlan(tester);
        await tester.pumpAndSettle();
      },
      responses: repository.planResponses,
      read: () => planEnabled(tester),
      chosen: true,
      projected: false,
    );
    await settles(
      'thinking',
      change: () => chooseComposerOption(tester, 'effort'),
      responses: repository.thinkingResponses,
      read: () => controls(tester).effort?.level,
      chosen: 'medium',
      projected: 'off',
    );
    await settles(
      'fast',
      change: () => chooseComposerOption(tester, 'fast'),
      responses: repository.fastResponses,
      read: () => controls(tester).speed,
      chosen: CanopyEffortSpeed.fast,
      projected: CanopyEffortSpeed.regular,
    );
    await settles(
      'model',
      change: () async {
        await tester.tap(find.byKey(const ValueKey('composer-model')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('model-option-claude-sonnet')),
        );
        await tester.pumpAndSettle();
      },
      responses: repository.modelResponses,
      read: () => controls(tester).selectedModelId,
      chosen: 'claude-sonnet',
      projected: 'gpt-5-codex',
    );
    expect(repository.lastSetThinkingLevel, 'medium');
    expect(repository.lastSetFastMode, isTrue);
    expect(repository.lastSetModel, 'claude-sonnet');
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a replaced session ignores late tab and composer outcomes', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final vm = await open(tester, repository);

    // D-05: a create, a close, and a composer change are pending when the
    // session is replaced; their late answers and failures change nothing.
    final created = await newChat(tester, repository);
    await selectTab(tester, 'chat-a');
    await toggleComposerPlan(tester);
    await tester.pumpAndSettle();
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-b')));
    await tester.pumpAndSettle();
    await openSheet(tester);
    expect(row('chat-b'), findsNothing);
    await dismissSheet(tester);
    await vm.disconnect();
    await vm.connect('654321');
    await tester.pumpAndSettle();
    expect(planEnabled(tester), isFalse);
    // The old session's close no longer hides the tab.
    await openSheet(tester);
    expect(row('chat-b'), findsOneWidget);
    final selected = [
      for (final chatId in [created, 'chat-a', 'chat-b'])
        if (isSelected(tester, chatId)) chatId,
    ];
    expect(selected, hasLength(1));
    await dismissSheet(tester);

    repository.createResponses.single.complete('old-create');
    repository.closeResponses.single.complete('old-close');
    repository.planResponses.single.completeError(
      const RemoteControlException('Old plan change rejected'),
    );
    await tester.pumpAndSettle();
    repository.fail('old-create', 'Old tab failed');
    await tester.pumpAndSettle();
    repository.fail('old-close', 'Old close failed');
    await tester.pumpAndSettle();

    expect(find.text('Old plan change rejected'), findsNothing);
    expect(find.text('Old tab failed'), findsNothing);
    expect(find.text('Old close failed'), findsNothing);
    expect(planEnabled(tester), isFalse);
    await openSheet(tester);
    expect(row(created), findsOneWidget);
    expect(row('chat-a'), findsOneWidget);
    expect(row('chat-b'), findsOneWidget);
    expect(isSelected(tester, selected.single), isTrue);
    await dismissSheet(tester);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a replaced session shows no late tab transport failures', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final vm = await open(tester, repository);

    // D-05: a create and a close are pending when the session is replaced;
    // then both submissions fail in transport.
    final created = await newChat(tester, repository);
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-b')));
    await tester.pumpAndSettle();
    await vm.disconnect();
    await vm.connect('654321');
    await tester.pumpAndSettle();

    repository.createResponses.single.completeError(
      const RemoteControlException('Old create unreachable'),
    );
    repository.closeResponses.single.completeError(
      const RemoteControlException('Old close unreachable'),
    );
    await tester.pumpAndSettle();

    expect(find.text('Old create unreachable'), findsNothing);
    expect(find.text('Old close unreachable'), findsNothing);
    expect(find.byType(SnackBar), findsNothing);
    await openSheet(tester);
    expect(row(created), findsOneWidget);
    expect(row('chat-b'), findsOneWidget);
    await dismissSheet(tester);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('a close that fails before the next frame keeps the draft', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final vm = await open(tester, repository);
    await tester.enterText(find.byKey(_draftKey), 'Draft for chat A');
    await selectTab(tester, 'chat-b');
    await tester.enterText(find.byKey(_draftKey), 'Draft for chat B');
    await selectTab(tester, 'chat-a');
    expect(draftText(tester), 'Draft for chat A');

    // D-11: closing chat A shows chat B optimistically; the transport
    // failure lands before the next frame and shows chat A again. The
    // composer stays on chat A's draft, and new text is saved for chat A.
    repository.closeChatTabError = const RemoteControlException('Close failed');
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-a')));
    await tester.pumpAndSettle();
    repository.closeChatTabError = null;
    expect(find.text('Close failed'), findsOneWidget);
    expect(find.textContaining('Release checklist'), findsOneWidget);
    expect(draftText(tester), 'Draft for chat A');
    await tester.enterText(find.byKey(_draftKey), 'Still chat A');
    await tester.pumpAndSettle();
    await selectTab(tester, 'chat-b');
    expect(draftText(tester), 'Draft for chat B');
    await selectTab(tester, 'chat-a');
    expect(draftText(tester), 'Still chat A');
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('standalone sends carry only touched thinking and fast', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    repository.standaloneChats.add(
      const RemoteStandaloneChat(
        localId: 'cc-notes',
        projectLocalId: 'ws-1',
        title: 'Release notes',
        providerType: 'codex',
        model: 'gpt-5-codex',
        modelLabel: 'GPT-5 Codex',
        availableModels: chatControllersModels,
      ),
    );
    // A projected transcript, so the chat does not wait on hydration.
    repository.history.add(
      const RemoteChatMessage(
        messageId: 'n-1',
        chatId: 'cc-notes',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'The release notes are ready for review.',
      ),
    );
    final vm = await open(tester, repository, standaloneChatId: 'cc-notes');

    Future<RemoteChatSendOptions?> send(String text) async {
      await tester.enterText(find.byKey(_draftKey), text);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      // The sent turn awaits a reply that never comes; it never settles.
      await tester.pump(const Duration(milliseconds: 300));
      expect(draftText(tester), isEmpty);
      return repository.sendChatMessageCalls.last.options;
    }

    // D-06: an untouched send omits thinking and fast, so it cannot
    // overwrite levels set on the desktop.
    final untouched = await send('Draft the release notes.');
    expect(untouched?.thinkingLevel, isNull);
    expect(untouched?.fastMode, isNull);

    // Touched controls change locally and ride the next send only.
    await chooseComposerEffort(tester, 'medium');
    await toggleComposerFast(tester);
    expect(controls(tester).effort?.level, 'medium');
    expect(controls(tester).speed, CanopyEffortSpeed.fast);
    expect(repository.lastSetThinkingLevel, isNull);
    expect(repository.lastSetFastMode, isNull);
    final touched = await send('Add the upgrade steps.');
    expect(touched?.thinkingLevel, 'medium');
    expect(touched?.fastMode, isTrue);
    expect(repository.sendChatMessageCalls, hasLength(2));
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('retry attachments outlive the screen and restore once', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('diagram.png'),
      ]);
    final vm = await open(tester, repository, picker: picker);
    // The attachment sources live in the composer's `+` sheet (CAN-3922).
    await tester.tap(find.byKey(const ValueKey('composer-actions')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('composer-action-attach-files')),
    );
    await tester.pumpAndSettle();
    expect(find.text('diagram.png'), findsOneWidget);

    // D-07: the send is accepted after the screen closed, then rejected.
    repository.sendResponse = Completer<RemoteChatSendResult>();
    await tester.enterText(find.byKey(_draftKey), 'Here is the diagram');
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    // The send spinner runs until the response; it never settles.
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    repository.sendResponse!.complete(
      const RemoteChatSendResult(commandId: 'send-1', chatId: 'chat-a'),
    );
    await tester.pumpAndSettle();
    repository.fail('send-1', 'The send was rejected.');
    await tester.pumpAndSettle();

    await tester.pumpWidget(
      chatControllersHost(
        vm,
        themeMode: ThemeMode.light,
        attachmentPicker: picker,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
    expect(find.text('diagram.png'), findsOneWidget);
    const chatA = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-a',
    );
    expect(vm.pendingChatAttachmentsFor(chatA), isEmpty);

    // D-08: an accepted send still unconfirmed when the session is replaced
    // keeps its bytes while the new desktop lacks attachments, then returns
    // to the composer and re-uploads them once the capability returns.
    repository.sendResponse = Completer<RemoteChatSendResult>();
    await tester.enterText(find.byKey(_draftKey), 'Second try');
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    // The send spinner runs until the response; it never settles.
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
    repository.sendResponse!.complete(
      const RemoteChatSendResult(commandId: 'send-2', chatId: 'chat-a'),
    );
    await tester.pumpAndSettle();
    final uploads = repository.uploadCalls.length;
    repository.supportsChatAttachments = false;
    await vm.disconnect();
    await vm.connect('654321');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
    expect(vm.pendingChatAttachmentsFor(chatA), hasLength(1));
    expect(repository.uploadCalls, hasLength(uploads));

    repository.supportsChatAttachments = true;
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(find.text('diagram.png'), findsOneWidget);
    expect(repository.uploadCalls, hasLength(uploads + 1));
    expect(vm.pendingChatAttachmentsFor(chatA), isEmpty);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('PR state refreshes only while the chat is shown', (
    tester,
  ) async {
    final repository = ChatControllersRepository();
    final navigatorKey = GlobalKey<NavigatorState>();
    final vm = await open(tester, repository, navigatorKey: navigatorKey);

    // D-09: shown → covered → uncovered → backgrounded → resumed.
    expect(repository.prRefreshes, 1);
    navigatorKey.currentState!.push(
      MaterialPageRoute<void>(builder: (_) => const Scaffold()),
    );
    await tester.pumpAndSettle();
    expect(repository.prRefreshes, 1);
    navigatorKey.currentState!.pop();
    await tester.pumpAndSettle();
    expect(repository.prRefreshes, 2);
    // Frames stop while the app is paused, so check without pumping.
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(repository.prRefreshes, 2);
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(repository.prRefreshes, 3);
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });

  testWidgets('the transcript keeps its scroll position through '
      'reconciliation', (tester) async {
    final repository = ChatControllersRepository();
    // Earlier turns, so the transcript scrolls.
    repository.history.addAll([
      for (var i = 1; i <= 20; i++) ...[
        RemoteChatMessage(
          messageId: 'h-$i-ask',
          chatId: 'chat-a',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Check release item $i.',
        ),
        RemoteChatMessage(
          messageId: 'h-$i',
          chatId: 'chat-a',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Release note $i: checked the build matrix and changelog.',
        ),
      ],
    ]);
    final vm = await open(tester, repository);
    await tester.enterText(find.byKey(_draftKey), 'Keep this draft');
    await tester.pumpAndSettle();

    // D-10: read earlier history, then let tab and composer bookkeeping
    // reconcile; the reader stays where they were.
    final position = tester.widget<ListView>(transcript()).controller!.position;
    await tester.drag(transcript(), const Offset(0, 400));
    await tester.pumpAndSettle();
    final reading = position.pixels;
    expect(position.maxScrollExtent - reading, greaterThan(200));
    // The first history row the reader can see.
    final viewport = tester.getRect(transcript());
    final anchor = find.text(
      tester
          .widgetList(find.textContaining('Release note '))
          .map(
            (widget) => switch (widget) {
              EditableText(:final controller) => controller.text,
              Text(:final data) => data ?? '',
              _ => '',
            },
          )
          .firstWhere(
            (note) => viewport.contains(tester.getCenter(find.text(note))),
          ),
    );
    expect(anchor, findsOneWidget);
    final anchorTop = tester.getTopLeft(anchor).dy;

    void expectReading(String step) {
      expect(position.pixels, closeTo(reading, 1), reason: step);
      expect(tester.getTopLeft(anchor).dy, closeTo(anchorTop, 1), reason: step);
      expect(draftText(tester), 'Keep this draft', reason: step);
    }

    // The desktop closes another tab and opens a new one elsewhere.
    await openSheet(tester);
    await tester.tap(find.byKey(const ValueKey('chat-tab-close-chat-b')));
    await tester.pumpAndSettle();
    repository.closeResponses.single.complete('close-b');
    await tester.pumpAndSettle();
    expectReading('close pending');
    repository.projected
      ..remove('chat-b')
      ..add('chat-c');
    repository.complete('close-b');
    await tester.pumpAndSettle();
    await vm.refresh();
    await tester.pumpAndSettle();
    expectReading('tabs reconciled');

    // A composer override settles at the next projection.
    await toggleComposerPlan(tester);
    await tester.pumpAndSettle();
    repository.planResponses.single.complete('plan-1');
    await tester.pumpAndSettle();
    repository.complete('plan-1');
    await tester.pumpAndSettle();
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(planEnabled(tester), isFalse);
    expectReading('composer reconciled');

    await openSheet(tester);
    expect(row('chat-b'), findsNothing);
    expect(row('chat-c'), findsOneWidget);
    expect(isSelected(tester, 'chat-a'), isTrue);
    await dismissSheet(tester);
    expectReading('sheet dismissed');
    expect(tester.takeException(), isNull);
    await close(tester, vm);
  });
}
