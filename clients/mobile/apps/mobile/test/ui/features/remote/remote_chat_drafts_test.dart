import 'dart:async';
import 'dart:math';

import 'package:mobile/ui/features/remote/view_models/remote_draft_first_send.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show kRemoteFreshResumeAfter;
import 'package:mobile/ui/features/remote/view_models/remote_unsent_sends.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/composer_driver.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/reduced_motion.dart';

void main() {
  group('RemoteChatScreen drafts and not-sent rows', () {
    useReducedMotion();

    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget host(RemoteControlViewModel viewModel, Widget screen) =>
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
            navigatorObservers: [appRouteObserver],
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: screen,
          ),
        );

    const models = [
      ModelOption(
        id: 'claude-sonnet',
        label: 'Claude Sonnet 4.5',
        provider: 'claude',
        vendor: 'anthropic',
        kind: 'model',
        available: true,
      ),
    ];

    RemoteChatSummary summary(String chatId, {required bool active}) =>
        RemoteChatSummary(
          chatId: chatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat $chatId',
          active: active,
          providerType: 'claude',
          model: 'claude-sonnet',
          modelLabel: 'Claude Sonnet 4.5',
          thinkingLevel: 'off',
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          availableModels: models,
          modelCatalogProjected: true,
        );

    RemoteSessionSnapshot worktreeSnapshot({
      required String providerType,
      List<String> extraChatIds = const [],
    }) => RemoteSessionSnapshot(
      workspaces: const [],
      worktrees: const [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: const [],
      chatSummaries: [
        summary('chat-1', active: true),
        for (final chatId in extraChatIds) summary(chatId, active: false),
      ],
      chatMessages: const [
        RemoteChatMessage(
          messageId: 'm-1',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Working on it…',
        ),
      ],
    );

    Future<RemoteControlViewModel> connected(
      WidgetTester tester,
      FakeRemoteControlRepository repository,
    ) async {
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => vm.connect('123456'));
      return vm;
    }

    Widget hostWithStore(
      RemoteControlViewModel viewModel,
      Widget screen,
      ChatDraftStore store,
    ) => ChangeNotifierProvider<ChatDraftStoreHolder>.value(
      value: ChatDraftStoreHolder(store),
      child: host(viewModel, screen),
    );

    String composerText(WidgetTester tester) => tester
        .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
        .controller!
        .text;

    Future<void> selectChatTab(WidgetTester tester, String chatId) async {
      await tester.openTabsSheet();
      await tester.tap(find.byKey(ValueKey('chat-tab-$chatId')));
      await tester.finishSheetDismiss();
    }

    testWidgets('each chat tab keeps its own draft', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          extraChatIds: const ['chat-2'],
        );
      final vm = await connected(tester, repository);
      final store = InMemoryChatDraftStore();
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          store,
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'for chat one',
      );
      await selectChatTab(tester, 'chat-2');
      expect(composerText(tester), '');
      await selectChatTab(tester, 'chat-1');
      expect(composerText(tester), 'for chat one');
    });

    testWidgets('a close that fails before the next frame keeps the draft', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => worktreeSnapshot(
          providerType: 'claude',
          extraChatIds: const ['chat-2'],
        );
      final vm = await connected(tester, repository);
      final store = InMemoryChatDraftStore();
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          store,
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'for chat one',
      );
      await selectChatTab(tester, 'chat-2');
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'for chat two',
      );
      await selectChatTab(tester, 'chat-1');

      // Closing chat 1 selects chat 2 optimistically; the transport failure
      // lands before the next frame and selects chat 1 again.
      repository.closeChatTabError = const RemoteControlException(
        'Close failed',
      );
      await tester.closeTabFromSheet('chat-1');
      await tester.pump();
      repository.closeChatTabError = null;
      expect(find.text('Close failed'), findsOneWidget);
      expect(find.text('Working on it…'), findsOneWidget);
      expect(composerText(tester), 'for chat one');

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'still chat one',
      );
      RemoteWorktreeChatDraftTarget draftOf(String chatId) =>
          RemoteWorktreeChatDraftTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: chatId,
          );
      expect(store.draftFor(draftOf('chat-1')), 'still chat one');
      expect(store.draftFor(draftOf('chat-2')), 'for chat two');
      await selectChatTab(tester, 'chat-2');
      expect(composerText(tester), 'for chat two');
      await selectChatTab(tester, 'chat-1');
      expect(composerText(tester), 'still chat one');
    });

    // Invariant: after every frame the composer shows the shown chat's draft,
    // and each chat's saved draft is only what was typed while it was shown.
    for (final seed in const [11, 23, 47]) {
      testWidgets(
        'drafts follow the shown chat through seeded sequence $seed',
        (tester) async {
          usePhoneViewport(tester);
          const chatIds = ['chat-1', 'chat-2', 'chat-3'];
          final repository = FakeRemoteControlRepository()
            ..snapshotBuilder = () => worktreeSnapshot(
              providerType: 'claude',
              extraChatIds: const ['chat-2', 'chat-3'],
            );
          final vm = await connected(tester, repository);
          final store = InMemoryChatDraftStore();
          String? shown;
          await tester.pumpWidget(
            hostWithStore(
              vm,
              RemoteChatScreen.worktree(
                worktree: vm.worktreesFor('ws-1').single,
                onSelectedChatChanged: (chatId) => shown = chatId,
              ),
              store,
            ),
          );
          await tester.pumpAndSettle();
          RemoteWorktreeChatDraftTarget draftOf(String chatId) =>
              RemoteWorktreeChatDraftTarget(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                chatId: chatId,
              );
          final expected = {for (final id in chatIds) id: ''};
          final random = Random(seed);
          final steps = <String>[];
          for (var step = 0; step < 12; step++) {
            final chatId = chatIds[random.nextInt(chatIds.length)];
            switch (random.nextInt(4)) {
              case 0:
                steps.add('type');
                final text = 'seed $seed step $step';
                await tester.enterText(
                  find.byKey(const ValueKey('composer-draft')),
                  text,
                );
                expected[shown!] = text;
              case 1:
                steps.add('select $chatId');
                await selectChatTab(tester, chatId);
              case 2:
                steps.add('failed close $chatId');
                repository.closeChatTabError = const RemoteControlException(
                  'Close failed',
                );
                await tester.closeTabFromSheet(chatId);
                repository.closeChatTabError = null;
              default:
                steps.add('failed close shown $shown');
                repository.closeChatTabError = const RemoteControlException(
                  'Close failed',
                );
                await tester.closeTabFromSheet(shown!);
                repository.closeChatTabError = null;
            }
            await tester.pump();
            final reason = 'seed $seed: ${steps.join(', ')}';
            expect(composerText(tester), expected[shown], reason: reason);
            for (final id in chatIds) {
              expect(store.draftFor(draftOf(id)), expected[id], reason: reason);
            }
          }
        },
      );
    }

    testWidgets('a draft survives remounting the screen', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => worktreeSnapshot(providerType: 'claude');
      final vm = await connected(tester, repository);
      final store = InMemoryChatDraftStore();
      Widget screen() =>
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single);
      await tester.pumpWidget(hostWithStore(vm, screen(), store));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'come back to me',
      );
      // Same provider tree (it owns the view model), screen unmounted.
      await tester.pumpWidget(hostWithStore(vm, const SizedBox(), store));
      expect(find.byKey(const ValueKey('composer-draft')), findsNothing);
      await tester.pumpWidget(hostWithStore(vm, screen(), store));
      await tester.pumpAndSettle();
      expect(composerText(tester), 'come back to me');
    });

    testWidgets(
      'fresh recovery restores an unconfirmed closed tab and its draft',
      (tester) async {
        usePhoneViewport(tester);
        var now = DateTime(2026, 10, 24, 12);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => worktreeSnapshot(
            providerType: 'claude',
            extraChatIds: const ['chat-2'],
          );
        final vm = RemoteControlViewModel(
          repository: repository,
          clock: () => now,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          hostWithStore(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            InMemoryChatDraftStore(),
          ),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'keep my draft',
        );
        await tester.closeTabFromSheet('chat-1');
        vm.onAppBackgrounded();
        now = now.add(kRemoteFreshResumeAfter);
        await tester.runAsync(vm.onAppForegrounded);
        await tester.pumpAndSettle();
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-1')), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-1')));
        await tester.finishSheetDismiss();
        expect(composerText(tester), 'keep my draft');
        expect(repository.closeChatTabTargets, hasLength(1));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );

    testWidgets('fresh resume labels an accepted send as uncertain', (
      tester,
    ) async {
      usePhoneViewport(tester);
      var now = DateTime(2026, 10, 24, 12);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => worktreeSnapshot(providerType: 'claude');
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        clock: () => now,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          InMemoryChatDraftStore(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'please run',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      expect(repository.sendChatMessageCalls, hasLength(1));
      vm.onAppBackgrounded();
      now = now.add(kRemoteFreshResumeAfter);

      await tester.runAsync(vm.onAppForegrounded);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(find.text('please run'), findsOneWidget);
      expect(find.text('Delivery uncertain'), findsOneWidget);
      expect(find.text('Not sent'), findsNothing);
      expect(repository.sendChatMessageCalls, hasLength(1));
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('a rejected text send stays as a not-sent row', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = (() => worktreeSnapshot(providerType: 'claude'))
        ..sendChatMessageHandler = () =>
            throw const RemoteControlException('Desktop offline');
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          InMemoryChatDraftStore(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'please run',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pumpAndSettle();
      expect(composerText(tester), '');
      expect(find.text('Not sent'), findsOneWidget);
      expect(find.text('Desktop offline'), findsOneWidget);
      // The row carries the reason; no snackbar repeats it.
      expect(find.byType(SnackBar), findsNothing);

      repository.sendChatMessageHandler = null;
      await tester.tap(find.textContaining('Resend'));
      await tester.pumpAndSettle();
      expect(repository.sendChatMessageCalls, hasLength(2));
      expect(
        repository.sendChatMessageCalls.last.options!.userMessageId,
        repository.sendChatMessageCalls.first.options!.userMessageId,
      );
    });

    testWidgets('an unsent row does not block reading a later host reply', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final store = InMemoryChatDraftStore()
        ..putUnsent(
          UnsentRecord(
            id: 'rc:unsent-1',
            surface: 'rc',
            targetKey: const RemoteWorktreeChatDraftTarget(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              chatId: 'chat-1',
            ).key,
            text: 'Unsent follow-up',
            createdAt: DateTime.now(),
            status: UnsentStatus.notSent,
            extra: const {
              'userMessageId': 'unsent-1',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-1',
            },
          ),
        );
      final repository = FakeRemoteControlRepository()
        ..supportsChatMarkRead = true
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [],
          'worktrees': [
            {
              'localId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'branch': 'main',
              'hasUnread': true,
            },
          ],
          'standaloneChats': [],
          'chatSummaries': [
            {
              'chatId': 'chat-1',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat',
              'active': true,
              'hasUnread': true,
            },
          ],
          'chatMessages': [
            {
              'localMessageId': 'm-1',
              'localChatId': 'chat-1',
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'content': 'Host reply',
            },
          ],
        });
      final vm = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        draftStore: store,
      );
      await tester.runAsync(() => vm.connect('123456'));
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          store,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsOneWidget);
      expect(repository.markReadCalls.map((call) => call.lastMessageId), [
        'm-1',
      ]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('text typed while a send mints its chat follows that chat', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final completion = Completer<RemoteChatSendResult>();
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = (() => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        ))
        ..sendChatMessageHandler = () => completion.future;
      final vm = await connected(tester, repository);
      final store = InMemoryChatDraftStore();
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          store,
        ),
      );
      // The desktop reports the worktree has no chats, so the composer can
      // send (and mint the first chat).
      repository.eventsController.add(
        const RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ],
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pumpAndSettle();
      final input = find.byKey(const ValueKey('composer-draft'));
      await tester.enterText(input, 'first message');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();
      final chatId = repository.sendChatMessageCalls.single.target.chatId!;
      await tester.enterText(input, 'typed meanwhile');
      completion.complete(RemoteChatSendResult(commandId: '', chatId: chatId));
      await tester.pumpAndSettle();

      expect(composerText(tester), 'typed meanwhile');
      const noTab = RemoteWorktreeChatDraftTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      expect(store.draftFor(noTab), '');
      expect(
        store.draftFor(
          RemoteWorktreeChatDraftTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: chatId,
          ),
        ),
        'typed meanwhile',
      );
    });

    const noTabDraft = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
    );
    const chatOneDraft = RemoteWorktreeChatDraftTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    /// Opens wt-1 while its chat tabs are still loading (the snapshot carries
    /// the worktree but no summaries, and the fake never answers the
    /// worktree-state request on its own).
    Future<FakeRemoteControlRepository> pumpWhileTabsLoad(
      WidgetTester tester,
      ChatDraftStore store,
    ) async {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = (() => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
        ));
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          store,
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Loading chats…'), findsOneWidget);
      return repository;
    }

    Future<void> deliverChatOne(
      WidgetTester tester,
      FakeRemoteControlRepository repository,
    ) async {
      repository.eventsController.add(
        RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              chatSummaries: [summary('chat-1', active: true)],
            ),
          ],
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pumpAndSettle();
      expect(find.text('Loading chats…'), findsNothing);
    }

    testWidgets('text typed while the tabs load moves to the resolved chat', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final store = InMemoryChatDraftStore();
      final repository = await pumpWhileTabsLoad(tester, store);
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'typed early',
      );
      await tester.pump();

      await deliverChatOne(tester, repository);

      expect(composerText(tester), 'typed early');
      expect(store.draftFor(chatOneDraft), 'typed early');
      expect(store.draftFor(noTabDraft), '');
    });

    testWidgets(
      'text typed while the tabs load never overwrites a saved draft',
      (tester) async {
        usePhoneViewport(tester);
        final store = InMemoryChatDraftStore()
          ..setDraft(chatOneDraft, 'saved for chat one');
        final repository = await pumpWhileTabsLoad(tester, store);
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'typed early',
        );
        await tester.pump();

        await deliverChatOne(tester, repository);

        expect(composerText(tester), 'saved for chat one');
        expect(store.draftFor(chatOneDraft), 'saved for chat one');
        expect(store.draftFor(noTabDraft), 'typed early');
      },
    );

    testWidgets('Discard removes a not-sent row', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = (() => worktreeSnapshot(providerType: 'claude'))
        ..sendChatMessageHandler = () =>
            throw const RemoteControlException('Desktop offline');
      final vm = await connected(tester, repository);
      await tester.pumpWidget(
        hostWithStore(
          vm,
          RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          InMemoryChatDraftStore(),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'please run',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Discard'));
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsNothing);
      expect(find.text('please run'), findsNothing);
    });

    group('a first message whose chat does not exist yet', () {
      const flatWorkspace = RemoteWorkspace(
        localId: 'ws-notes',
        order: 0,
        name: 'Research notes',
        type: RemoteWorkspaceType.cowork,
      );

      RemoteSessionSnapshot flatSnapshot() => const RemoteSessionSnapshot(
        workspaces: [flatWorkspace],
        worktrees: [],
        standaloneChats: [],
      );

      RemoteSessionSnapshot emptyWorktreeSnapshot() =>
          const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
          );

      Future<RemoteControlViewModel> connectedWithStore(
        WidgetTester tester,
        FakeRemoteControlRepository repository,
        ChatDraftStore store,
      ) async {
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          draftStore: store,
        );
        await tester.runAsync(() => vm.connect('123456'));
        return vm;
      }

      /// The desktop reports that wt-1 has no chat tabs.
      Future<void> reportNoTabs(
        WidgetTester tester,
        FakeRemoteControlRepository repository,
      ) async {
        repository.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
          ),
        );
        await tester.runAsync(() => Future<void>.delayed(Duration.zero));
        await tester.pumpAndSettle();
      }

      Future<void> sendOffline(
        WidgetTester tester,
        RemoteControlViewModel vm,
        String text,
      ) async {
        await tester.runAsync(vm.disconnect);
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          text,
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pumpAndSettle();
        expect(find.text('Not sent'), findsOneWidget);
      }

      group('a draft composed before the screen opened (CAN-2932)', () {
        testWidgets('a flat workspace sends it once the screen opens', (
          tester,
        ) async {
          usePhoneViewport(tester);
          final store = InMemoryChatDraftStore()
            ..setDraft(
              const RemoteNewChatDraftTarget('ws-notes'),
              'Summarize the notes',
            );
          final repository = FakeRemoteControlRepository()
            ..snapshotBuilder = flatSnapshot;
          final vm = await connectedWithStore(tester, repository, store);
          await tester.pumpWidget(
            hostWithStore(
              vm,
              RemoteChatScreen.create(
                workspace: flatWorkspace,
                firstSend: RemoteDraftFirstSend(),
              ),
              store,
            ),
          );
          await tester.pumpAndSettle();

          final send = repository.sendChatMessageCalls.single;
          expect(send.text, 'Summarize the notes');
          expect(
            send.target,
            isA<RemoteStandaloneChatTarget>().having(
              (t) => t.projectLocalId,
              'projectLocalId',
              'ws-notes',
            ),
          );
          expect(composerText(tester), isEmpty);
          expect(
            store.draftFor(const RemoteNewChatDraftTarget('ws-notes')),
            '',
          );
          expect(tester.takeException(), isNull);
        });

        testWidgets(
          'manual retry retains the draft model, thinking and Fast settings',
          (tester) async {
            usePhoneViewport(tester);
            const options = RemoteChatSendOptions(
              model: 'gpt-5-codex',
              thinkingLevel: 'high',
              fastMode: true,
            );
            final store = InMemoryChatDraftStore()
              ..setDraft(
                const RemoteNewChatDraftTarget('ws-notes'),
                'Retry these notes',
              );
            final repository = _FailFirstStandaloneRepository()
              ..supportsStandaloneChatCreate = true
              ..snapshotBuilder = flatSnapshot;
            final vm = await connectedWithStore(tester, repository, store);
            final pending = <bool>[];
            final firstSend = RemoteDraftFirstSend(options)
              ..onPendingChanged = pending.add;
            await tester.pumpWidget(
              hostWithStore(
                vm,
                RemoteChatScreen.create(
                  workspace: flatWorkspace,
                  firstSend: firstSend,
                ),
                store,
              ),
            );
            await tester.pumpAndSettle();
            expect(repository.attempts, 1);
            expect(pending, [true, false]);
            expect(repository.sendChatMessageCalls, isEmpty);
            expect(composerText(tester), 'Retry these notes');
            await tester.pump(const Duration(seconds: 5));
            await tester.pumpAndSettle();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            expect(repository.attempts, 2);
            expect(pending, [true, false, true]);
            repository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 1,
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'retry-create',
                    result: {'chatId': repository.createdTarget!.chatId},
                  ),
                ],
              ),
            );
            await tester.pumpAndSettle();
            final sent = repository.sendChatMessageCalls.single;
            expect(pending, [true, false, true, false]);
            expect(sent.options?.model, options.model);
            expect(sent.options?.thinkingLevel, options.thinkingLevel);
            expect(sent.options?.fastMode, options.fastMode);
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'A follow-up',
            );
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pumpAndSettle();
            expect(repository.sendChatMessageCalls, hasLength(2));
            expect(repository.sendChatMessageCalls.last.options?.model, isNull);
            expect(
              repository.sendChatMessageCalls.last.options?.thinkingLevel,
              isNull,
            );
            expect(
              repository.sendChatMessageCalls.last.options?.fastMode,
              isNull,
            );
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets(
          'manual retry honors edited thinking and retains untouched draft settings',
          (tester) async {
            usePhoneViewport(tester);
            const options = RemoteChatSendOptions(
              model: 'gpt-5-codex',
              providerType: 'codex',
              inputMode: 'voice',
              thinkingLevel: 'high',
              fastMode: true,
            );
            final store = InMemoryChatDraftStore()
              ..setDraft(
                const RemoteNewChatDraftTarget('ws-notes'),
                'Retry these notes',
              );
            final repository = _FailFirstStandaloneRepository()
              ..supportsStandaloneChatCreate = true
              ..snapshotBuilder = flatSnapshot;
            final vm = await connectedWithStore(tester, repository, store);
            final pending = <bool>[];
            final firstSend = RemoteDraftFirstSend(options)
              ..onPendingChanged = pending.add;
            await tester.pumpWidget(
              hostWithStore(
                vm,
                RemoteChatScreen.create(
                  workspace: flatWorkspace,
                  firstSend: firstSend,
                ),
                store,
              ),
            );
            await tester.pumpAndSettle();
            expect(repository.attempts, 1);
            expect(pending, [true, false]);
            expect(repository.sendChatMessageCalls, isEmpty);
            expect(composerText(tester), 'Retry these notes');
            repository.snapshotBuilder = () => RemoteSessionSnapshot(
              workspaces: const [flatWorkspace],
              worktrees: const [],
              standaloneChats: [
                RemoteStandaloneChat(
                  localId: repository.createdTarget!.chatId,
                  projectLocalId: 'ws-notes',
                  title: 'Notes',
                  model: 'gpt-5-codex',
                  providerType: 'codex',
                  availableModels: const [
                    ModelOption(
                      id: 'gpt-5-codex',
                      label: 'GPT-5 Codex',
                      kind: 'model',
                      provider: 'codex',
                      available: true,
                    ),
                  ],
                ),
              ],
            );
            await tester.runAsync(vm.refresh);
            await tester.pumpAndSettle();
            await tester.pump(const Duration(seconds: 5));
            await tester.pumpAndSettle();
            await chooseComposerEffort(tester, 'medium');
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            expect(repository.attempts, 2);
            expect(pending, [true, false, true]);
            repository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 1,
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'retry-create',
                    result: {'chatId': repository.createdTarget!.chatId},
                  ),
                ],
              ),
            );
            await tester.pumpAndSettle();
            final sent = repository.sendChatMessageCalls.single;
            expect(pending, [true, false, true, false]);
            expect(sent.options?.model, options.model);
            expect(sent.options?.thinkingLevel, 'medium');
            expect(sent.options?.fastMode, options.fastMode);
            expect(sent.options?.providerType, options.providerType);
            expect(sent.options?.inputMode, options.inputMode);
            await tester.enterText(
              find.byKey(const ValueKey('composer-draft')),
              'A follow-up',
            );
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pumpAndSettle();
            expect(repository.sendChatMessageCalls, hasLength(2));
            expect(repository.sendChatMessageCalls.last.options?.model, isNull);
            expect(
              repository.sendChatMessageCalls.last.options?.thinkingLevel,
              'medium',
            );
            expect(
              repository.sendChatMessageCalls.last.options?.fastMode,
              isNull,
            );
            expect(tester.takeException(), isNull);
          },
        );

        testWidgets('a tree workspace sends it once its worktree exists', (
          tester,
        ) async {
          usePhoneViewport(tester);
          const workspace = RemoteWorkspace(
            localId: 'ws-app',
            order: 0,
            name: 'App',
            type: RemoteWorkspaceType.singleRepo,
          );
          final worktrees = <RemoteWorktree>[];
          final created = Completer<RemoteWorktreeCreateResult>();
          final store = InMemoryChatDraftStore()
            ..setDraft(
              const RemoteNewChatDraftTarget('ws-app'),
              'Fix the login bug',
            );
          final repository = FakeRemoteControlRepository()
            ..createWorktreeHandler = (() => created.future)
            ..snapshotBuilder = () => RemoteSessionSnapshot(
              workspaces: const [workspace],
              worktrees: List.of(worktrees),
              standaloneChats: const [],
            );
          final vm = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
            worktreeCreateRecoveryInterval: Duration.zero,
            draftStore: store,
          );
          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(
            hostWithStore(
              vm,
              RemoteChatScreen.create(
                workspace: workspace,
                firstSend: RemoteDraftFirstSend(),
              ),
              store,
            ),
          );
          await tester.pump();
          await tester.pump();

          // Nothing is sent while the worktree is still being created.
          expect(repository.createWorktreeCalls, hasLength(1));
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(composerText(tester), 'Fix the login bug');

          worktrees.add(
            const RemoteWorktree(
              localId: 'wt-new',
              workspaceLocalId: 'ws-app',
              branch: 'fix-login',
            ),
          );
          created.complete(
            const RemoteWorktreeCreateResult(
              commandId: 'cmd-create',
              worktreeLocalId: 'wt-new',
            ),
          );
          await tester.pumpAndSettle();

          final send = repository.sendChatMessageCalls.single;
          expect(send.text, 'Fix the login bug');
          expect(
            send.target,
            isA<RemoteWorktreeChatTarget>().having(
              (t) => t.worktreeLocalId,
              'worktreeLocalId',
              'wt-new',
            ),
          );
          expect(repository.createWorktreeCalls, hasLength(1));
          expect(tester.takeException(), isNull);
        });
      });

      testWidgets('a flat workspace shows it again after remounting', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final store = InMemoryChatDraftStore();
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = flatSnapshot;
        final vm = await connectedWithStore(tester, repository, store);
        Widget screen() =>
            const RemoteChatScreen.create(workspace: flatWorkspace);
        await tester.pumpWidget(hostWithStore(vm, screen(), store));
        await tester.pumpAndSettle();
        await sendOffline(tester, vm, 'first while offline');

        await tester.pumpWidget(hostWithStore(vm, const SizedBox(), store));
        await tester.pumpWidget(hostWithStore(vm, screen(), store));
        await tester.pumpAndSettle();

        expect(find.text('first while offline'), findsOneWidget);
        expect(find.text('Not sent'), findsOneWidget);
        expect(find.text(kRemoteOfflineReason), findsOneWidget);

        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpAndSettle();
        await tester.tap(find.textContaining('Resend'));
        await tester.pumpAndSettle();
        final send = repository.sendChatMessageCalls.single;
        expect(send.text, 'first while offline');
        expect(
          send.target,
          isA<RemoteStandaloneChatTarget>()
              .having((t) => t.chatId, 'chatId', startsWith('cc-'))
              .having((t) => t.projectLocalId, 'projectLocalId', 'ws-notes'),
        );
      });

      testWidgets('a flat workspace shows it again after a restart', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final store = InMemoryChatDraftStore();
        final first = FakeRemoteControlRepository()
          ..snapshotBuilder = flatSnapshot;
        final vm = await connectedWithStore(tester, first, store);
        Widget screen() =>
            const RemoteChatScreen.create(workspace: flatWorkspace);
        await tester.pumpWidget(hostWithStore(vm, screen(), store));
        await tester.pumpAndSettle();
        await sendOffline(tester, vm, 'first while offline');
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'typed after the send',
        );
        await tester.pump();

        // A restart: a new view model over the same store.
        await tester.pumpWidget(const SizedBox());
        final second = FakeRemoteControlRepository()
          ..snapshotBuilder = flatSnapshot;
        final restarted = await connectedWithStore(tester, second, store);
        await tester.pumpWidget(hostWithStore(restarted, screen(), store));
        await tester.pumpAndSettle();

        expect(find.text('first while offline'), findsOneWidget);
        expect(find.text('Not sent'), findsOneWidget);
        expect(composerText(tester), 'typed after the send');

        await tester.tap(find.textContaining('Resend'));
        await tester.pumpAndSettle();
        expect(second.sendChatMessageCalls.single.text, 'first while offline');
      });

      testWidgets('a worktree with no tabs shows it again after remounting', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final store = InMemoryChatDraftStore();
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = emptyWorktreeSnapshot;
        final vm = await connectedWithStore(tester, repository, store);
        final worktree = vm.worktreesFor('ws-1').single;
        Widget screen() => RemoteChatScreen.worktree(worktree: worktree);
        await tester.pumpWidget(hostWithStore(vm, screen(), store));
        await reportNoTabs(tester, repository);
        await sendOffline(tester, vm, 'first while offline');

        await tester.pumpWidget(hostWithStore(vm, const SizedBox(), store));
        await tester.pumpWidget(hostWithStore(vm, screen(), store));
        await tester.pumpAndSettle();

        expect(find.text('first while offline'), findsOneWidget);
        expect(find.text('Not sent'), findsOneWidget);

        await tester.runAsync(() => vm.connect('123456'));
        await reportNoTabs(tester, repository);
        await tester.tap(find.textContaining('Resend'));
        await tester.pumpAndSettle();
        final send = repository.sendChatMessageCalls.single;
        expect(send.text, 'first while offline');
        expect(send.target.chatId, startsWith('chat-m'));
        expect(
          repository.createChatTabTargets.single.chatId,
          send.target.chatId,
        );
      });

      testWidgets('a worktree with no tabs shows it again after a restart', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final store = InMemoryChatDraftStore();
        final first = FakeRemoteControlRepository()
          ..snapshotBuilder = emptyWorktreeSnapshot;
        final vm = await connectedWithStore(tester, first, store);
        await tester.pumpWidget(
          hostWithStore(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
            store,
          ),
        );
        await reportNoTabs(tester, first);
        await sendOffline(tester, vm, 'first while offline');

        await tester.pumpWidget(const SizedBox());
        final second = FakeRemoteControlRepository()
          ..snapshotBuilder = emptyWorktreeSnapshot;
        final restarted = await connectedWithStore(tester, second, store);
        await tester.pumpWidget(
          hostWithStore(
            restarted,
            RemoteChatScreen.worktree(
              worktree: restarted.worktreesFor('ws-1').single,
            ),
            store,
          ),
        );
        await reportNoTabs(tester, second);

        expect(find.text('first while offline'), findsOneWidget);
        expect(find.text('Not sent'), findsOneWidget);
        await tester.tap(find.textContaining('Resend'));
        await tester.pumpAndSettle();
        expect(second.sendChatMessageCalls.single.text, 'first while offline');
        expect(second.createChatTabTargets, hasLength(1));
      });
    });
  });
}

final class _FailFirstStandaloneRepository extends FakeRemoteControlRepository {
  int attempts = 0;
  RemoteStandaloneChatTarget? createdTarget;
  @override
  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target) {
    createdTarget = target;
    if (++attempts == 1) {
      throw const RemoteControlException('Creation failed');
    }
    return Future.value('retry-create');
  }
}
