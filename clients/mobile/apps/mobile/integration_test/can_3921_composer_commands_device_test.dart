// CAN-3921 device acceptance for the composer's `/` and `$` suggestions,
// with the real platform text input and keyboard. Run from apps/mobile:
//
//   flutter test integration_test/can_3921_composer_commands_device_test.dart \
//     -d <device-id>
//
// Synthetic fixtures only: no account, desktop, or network.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _models = [
  ModelOption(
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.5',
    provider: 'claude',
    kind: 'model',
    available: true,
  ),
  ModelOption(
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    provider: 'codex',
    kind: 'model',
    available: true,
  ),
];

RemoteSessionSnapshot _worktree(String provider) => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
  ],
  standaloneChats: const [],
  chatSummaries: [
    RemoteChatSummary(
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Release prep',
      active: true,
      providerType: provider,
      model: provider == 'codex' ? 'gpt-5-codex' : 'claude-sonnet',
      modelLabel: provider == 'codex' ? 'GPT-5 Codex' : 'Claude Sonnet 4.5',
      thinkingLevel: 'off',
      providerAvailability: const ProviderAvailability(
        claude: true,
        codex: true,
      ),
      availableModels: _models,
      modelCatalogProjected: true,
    ),
  ],
  // The fake never delivers a transcript event. Seed a completed message so
  // the native test can settle instead of waiting on the loading spinner.
  chatMessages: const [
    RemoteChatMessage(
      messageId: 'message-1',
      chatId: 'chat-1',
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: 'Ready to review.',
    ),
  ],
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final draft = find.byKey(const ValueKey('composer-draft'));
  TextEditingController controller(WidgetTester tester) =>
      tester.widget<TextField>(draft).controller!;

  Future<void> type(WidgetTester tester, String text) async {
    await tester.tap(draft);
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(draft, text);
    await tester.pumpAndSettle();
  }

  Future<FakeRemoteControlRepository> pumpRemote(
    WidgetTester tester,
    String provider,
  ) async {
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = (() => _worktree(provider))
      ..slashCommands = [
        {
          'name': 'review',
          'description': 'Review the current diff',
          'insertText': '/review ',
        },
        {'name': 'release-notes', 'description': 'Draft release notes'},
      ];
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    addTearDown(vm.dispose);
    addTearDown(repository.eventsController.close);
    addTearDown(repository.eventsLiveController.close);
    await vm.connect('123456');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
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
            worktree: vm.worktreesFor('ws-1').single,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return repository;
  }

  testWidgets('Remote Control rows filter and insert without sending', (
    tester,
  ) async {
    final repository = await pumpRemote(tester, 'claude');

    await type(tester, 'Please check /');
    expect(
      find.byKey(const ValueKey('composer-command-model')),
      findsOneWidget,
    );
    final list = tester.getRect(
      find.byKey(const ValueKey('composer-command-list')),
    );
    final composer = tester.getRect(
      find.byKey(const ValueKey('chat-composer')),
    );
    expect(list.bottom, lessThanOrEqualTo(composer.top));

    // Built-in actions come first; host rows show once the query narrows.
    await type(tester, 'Please check /re');
    expect(
      find.byKey(const ValueKey('composer-command-skills-release-notes')),
      findsOneWidget,
    );
    await type(tester, 'Please check /rev');
    expect(
      find.byKey(const ValueKey('composer-command-skills-release-notes')),
      findsNothing,
    );
    await tester.tap(
      find.byKey(const ValueKey('composer-command-skills-review')),
    );
    await tester.pumpAndSettle();
    expect(controller(tester).text, 'Please check /review ');
    expect(repository.sendChatMessageCalls, isEmpty);

    await type(tester, r'Use $');
    expect(find.byKey(const ValueKey('composer-command-list')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(r'Codex chats open $ suggestions', (tester) async {
    await pumpRemote(tester, 'codex');
    await type(tester, r'Use $');
    expect(
      find.byKey(const ValueKey('composer-command-model')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cloud chat enables an available row, then inserts it', (
    tester,
  ) async {
    final repository = MockCloudChatRepository(latency: Duration.zero);
    final list = CloudChatsViewModel(repository: repository);
    final streams = <StreamController<CloudSseFrame>>[];
    final chat = CloudChatViewModel(
      repository: repository,
      openStream: (_, {after}) {
        final stream = StreamController<CloudSseFrame>();
        streams.add(stream);
        return stream.stream;
      },
      observeLifecycle: false,
    )..attachDraftStore(InMemoryChatDraftStore());
    addTearDown(() async {
      chat.dispose();
      list.dispose();
      for (final stream in streams) {
        await stream.close();
      }
    });
    await list.load();
    await list.ensureModels();
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<CloudChatsViewModel>.value(value: list),
          ChangeNotifierProvider<CloudChatViewModel>.value(value: chat),
          ChangeNotifierProvider<ChatDraftStoreHolder>.value(
            value: ChatDraftStoreHolder(InMemoryChatDraftStore()),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: const CloudChatScreen(chatId: 'cloud-chat-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await type(tester, 'Hi /rel');
    final available = find.byKey(
      const ValueKey('composer-command-available-release-notes'),
    );
    await tester.scrollUntilVisible(
      available,
      24,
      scrollable: find.descendant(
        of: find.byKey(const ValueKey('composer-command-list')),
        matching: find.byType(Scrollable),
      ),
    );
    await tester.pumpAndSettle();
    expect(available.hitTestable(), findsOneWidget);
    await tester.tap(available);
    await tester.pumpAndSettle();
    expect(controller(tester).text, 'Hi /release-notes ');
    expect(tester.takeException(), isNull);
  });
}
