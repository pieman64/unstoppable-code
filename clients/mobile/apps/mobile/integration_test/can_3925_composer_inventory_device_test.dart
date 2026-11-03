// CAN-3925 device acceptance for Remote Control composers on a desktop with
// the invocable inventory, with the real platform text input and keyboard.
// Run from apps/mobile:
//
//   flutter test integration_test/can_3925_composer_inventory_device_test.dart \
//     -d <device-id>
//
// Synthetic fixtures only: no account, desktop, or network.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

const _review = {
  'name': 'review',
  'description': 'Review the current diff',
  'insertText': '/review ',
  'section': 'discovered',
  'entryId': 'entry:command/review',
};
const _releaseNotes = {
  'name': 'release-notes',
  'description': 'Draft release notes',
  'section': 'available',
  'entryId': 'entry:skill/release-notes',
  'requiresResolution': true,
};
const _catalog = {
  'collections': [
    {'id': 'kit', 'name': 'Release kit', 'description': 'Skills for shipping'},
  ],
  'plugins': [
    {
      'marketplaceId': 'market',
      'pluginName': 'github',
      'name': 'GitHub',
      'description': 'Pull requests',
      'claudeSupported': true,
      'codexSupported': true,
    },
  ],
  'skills': <Object?>[],
  'mcpServers': <Object?>[],
};
const _githubRef = {'marketplaceId': 'market', 'pluginName': 'github'};
const _kitOnly = <String, Object?>{
  'collectionIds': ['kit'],
  'skillRefs': <Object?>[],
  'pluginRefs': <Object?>[],
};

RemoteSessionSnapshot _worktree(Map<String, Object?> selections) =>
    RemoteSessionSnapshot(
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
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Release prep',
          active: true,
          providerType: 'claude',
          model: 'claude-sonnet',
          modelLabel: 'Claude Sonnet 4.5',
          thinkingLevel: 'off',
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          modelCatalogProjected: true,
          pluginSelectionsDetail: selections,
        ),
      ],
      chatMessages: const [
        RemoteChatMessage(
          messageId: 'm-1',
          chatId: 'chat-1',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Prepare the release notes.',
        ),
      ],
    );

RemoteSessionSnapshot _standalone(
  Map<String, Object?> selections, {
  String provider = 'claude',
}) => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [],
  standaloneChats: [
    RemoteStandaloneChat.fromJson({
      'localId': 'chat-solo',
      'projectLocalId': 'ws-notes',
      'title': 'Launch notes',
      'providerType': provider,
      'pluginSelectionsDetail': selections,
    }),
  ],
  chatMessages: const [
    RemoteChatMessage(
      messageId: 'solo-1',
      chatId: 'chat-solo',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: 'Outline the launch announcement.',
    ),
  ],
);

FakeRemoteControlRepository _host({required bool inventory}) =>
    FakeRemoteControlRepository()
      ..supportsInvocableInventory = inventory
      ..invocables = [_review, _releaseNotes]
      ..slashCommands = [_review]
      ..pluginCatalog = _catalog;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final draft = find.byKey(const ValueKey('composer-draft'));
  final list = find.byKey(const ValueKey('composer-command-list'));
  final available = find.byKey(
    const ValueKey('composer-command-available-release-notes'),
  );
  final pluginsRow = find.byKey(const ValueKey('composer-action-plugins'));
  final github = find.byKey(
    const ValueKey('composer-plugin-plugin:market/github'),
  );
  TextEditingController controller(WidgetTester tester) =>
      tester.widget<TextField>(draft).controller!;

  Future<void> type(WidgetTester tester, String text) async {
    await tester.tap(draft);
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(draft, text);
    await tester.pumpAndSettle();
  }

  Future<void> openActions(WidgetTester tester) async {
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('Add files and more'));
    await tester.pumpAndSettle();
  }

  Future<void> closeSheet(WidgetTester tester) async {
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await tester.pumpAndSettle();
  }

  Finder count(String value) =>
      find.descendant(of: pluginsRow, matching: find.text(value));

  Future<RemoteControlViewModel> show(
    WidgetTester tester,
    FakeRemoteControlRepository repository,
    Widget Function(RemoteControlViewModel vm) screen,
  ) async {
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
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
          home: screen(vm),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return vm;
  }

  Widget worktreeScreen(RemoteControlViewModel vm) =>
      RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single);
  Widget standaloneScreen(RemoteControlViewModel vm) =>
      RemoteChatScreen.standalone(
        standaloneChat: vm.standaloneChatsFor('ws-notes').single,
      );

  testWidgets('a worktree chat resolves an available row, inserts the '
      'returned text, and counts the new selection', (tester) async {
    final repository = _host(inventory: true)
      ..snapshotBuilder = () => _worktree(_kitOnly);
    repository.resolveInvocableHandler = (_) async {
      repository.snapshotBuilder = () => _worktree({
        ..._kitOnly,
        'skillRefs': [
          {'sourceId': 'kit', 'skillName': 'release-notes'},
        ],
      });
      return const RemotePortalCommandResult(
        commandId: 'resolve-1',
        result: {
          'insertText': '/release-kit:release-notes ',
          'invocationKey': 'release-kit:release-notes',
        },
      );
    };
    final vm = await show(tester, repository, worktreeScreen);

    await type(tester, 'Write /rel');
    expect(tester.view.viewInsets.bottom, greaterThan(0));
    expect(available, findsOneWidget);
    expect(
      tester.getRect(list).bottom,
      lessThanOrEqualTo(
        tester.getRect(find.byKey(const ValueKey('chat-composer'))).top,
      ),
    );
    await tester.tap(available);
    await tester.pumpAndSettle();
    expect(controller(tester).text, 'Write /release-kit:release-notes ');
    expect(
      repository.invocableCalls.last['type'],
      'portal.editor.resolve_invocable',
    );

    await vm.refresh();
    await tester.pumpAndSettle();
    await openActions(tester);
    expect(count('2'), findsOneWidget);
    await closeSheet(tester);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed resolve shows the error and keeps the draft', (
    tester,
  ) async {
    final repository = _host(inventory: true)
      ..snapshotBuilder = (() => _worktree(_kitOnly))
      ..resolveInvocableHandler = (_) async =>
          throw const RemoteControlException('Not available.');
    await show(tester, repository, worktreeScreen);

    await type(tester, 'Write /rel');
    final before = controller(tester).value;
    await tester.tap(available);
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Could not enable that item. Try again or use the Plugins picker.',
      ),
      findsOneWidget,
    );
    expect(controller(tester).value, before);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a standalone chat lists host rows and keeps a plugin after '
      'reopening', (tester) async {
    var saved = _kitOnly;
    final repository = _host(inventory: true)
      ..snapshotBuilder = (() => _standalone(saved))
      ..setPluginSelectionsHandler = (_) async => 'plugins-1';
    await show(tester, repository, standaloneScreen);

    await type(tester, '/rev');
    expect(
      find.byKey(const ValueKey('composer-command-skills-review')),
      findsOneWidget,
    );
    await type(tester, 'Keep this draft');

    await openActions(tester);
    expect(count('1'), findsOneWidget);
    await tester.tap(pluginsRow);
    await tester.pumpAndSettle();
    await tester.tap(github);
    await tester.pumpAndSettle();
    expect(
      repository.pluginSelectionCalls.single.target,
      isA<RemoteStandaloneChatTarget>(),
    );
    saved = {
      ..._kitOnly,
      'pluginRefs': [_githubRef],
    };
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [RemoteCommandCompletedEvent(commandId: 'plugins-1')],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(github).value, isTrue);
    await closeSheet(tester);
    expect(controller(tester).text, 'Keep this draft');

    // Leave, then reopen from a fresh session snapshot.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    await show(tester, repository, standaloneScreen);
    await openActions(tester);
    expect(count('2'), findsOneWidget);
    await tester.tap(pluginsRow);
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(github).value, isTrue);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets(r'a Codex standalone chat opens host rows for $', (tester) async {
    final repository = _host(inventory: true)
      ..snapshotBuilder = () => _standalone(_kitOnly, provider: 'codex');
    await show(tester, repository, standaloneScreen);
    await type(tester, r'Use $rev');
    expect(
      find.byKey(const ValueKey('composer-command-skills-review')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('an older desktop keeps discovery rows and no standalone '
      'Plugins', (tester) async {
    final worktree = _host(inventory: false)
      ..snapshotBuilder = () => _worktree(_kitOnly);
    await show(tester, worktree, worktreeScreen);
    await type(tester, '/rev');
    expect(
      find.byKey(const ValueKey('composer-command-skills-review')),
      findsOneWidget,
    );
    expect(worktree.invocableCalls, isEmpty);
    expect(worktree.slashCommandCalls, isNotEmpty);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();

    final standalone = _host(inventory: false)
      ..supportsChatAttachments = true
      ..snapshotBuilder = () => _standalone(_kitOnly);
    await show(tester, standalone, standaloneScreen);
    await type(tester, '/rev');
    expect(list, findsNothing);
    await openActions(tester);
    expect(
      find.byKey(const ValueKey('composer-action-attach-files')),
      findsOneWidget,
    );
    expect(pluginsRow, findsNothing);
    await closeSheet(tester);
    expect(standalone.invocableCalls, isEmpty);
    expect(standalone.pluginCatalogCalls, isEmpty);
    expect(tester.takeException(), isNull);
  });
}
