// CAN-3922 device acceptance for the composer's `+` sheet and plugins sheet,
// with the real platform text input and keyboard. Run from apps/mobile:
//
//   flutter test integration_test/can_3922_composer_actions_device_test.dart \
//     -d <device-id>
//
// Synthetic fixtures only: no account, desktop, or network.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/cloud_invocables.dart';
import 'package:mobile/data/models/composer_plugins.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/services/attachment_picker.dart';
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

import '../test/support/fake_attachment_picker.dart';
import '../test/support/fake_cloud_chat_repository.dart';
import '../test/support/fake_remote_control_repository.dart';

const _githubRef = {'marketplaceId': 'market', 'pluginName': 'github'};

const _catalog = {
  'collections': [
    {'id': 'kit', 'name': 'Release kit', 'description': 'Skills for shipping'},
  ],
  'plugins': [
    {..._githubRef, 'name': 'GitHub', 'description': 'Pull requests'},
  ],
  'skills': <Object?>[],
  'mcpServers': <Object?>[],
};

RemoteSessionSnapshot _worktree() => const RemoteSessionSnapshot(
  workspaces: [],
  worktrees: [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
  ],
  standaloneChats: [],
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
      providerAvailability: ProviderAvailability(claude: true, codex: true),
      availableModels: [
        ModelOption(
          id: 'claude-sonnet',
          label: 'Claude Sonnet 4.5',
          provider: 'claude',
          kind: 'model',
          available: true,
        ),
      ],
      modelCatalogProjected: true,
      pluginSelectionsDetail: {
        'collectionIds': ['kit'],
        'skillRefs': <Object?>[],
        'pluginRefs': <Object?>[],
      },
    ),
  ],
);

/// wt-1 before its first message, or with [created] once the desktop
/// lists the tab a composer action created, holding [pluginRefs].
RemoteSessionSnapshot _emptyWorktree({
  String? created,
  List<Object?> pluginRefs = const [],
}) => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: _worktree().worktrees,
  standaloneChats: const [],
  chatSummaries: [
    if (created != null)
      RemoteChatSummary(
        chatId: created,
        scope: RemoteChatScope.worktree,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        title: 'New chat',
        providerType: 'claude',
        pluginSelectionsDetail: {
          'collectionIds': const <Object?>[],
          'skillRefs': const <Object?>[],
          'pluginRefs': pluginRefs,
        },
      ),
  ],
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final draft = find.byKey(const ValueKey('composer-draft'));
  TextEditingController controller(WidgetTester tester) =>
      tester.widget<TextField>(draft).controller!;

  double keyboard(WidgetTester tester) => tester.view.viewInsets.bottom;

  /// Waits for the platform keyboard to finish opening or closing.
  Future<void> settleKeyboard(WidgetTester tester) async {
    for (var i = 0; i < 20; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.pumpAndSettle();
  }

  Future<void> typeKept(WidgetTester tester, String text) async {
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, text);
    controller(tester).selection = const TextSelection(
      baseOffset: 0,
      extentOffset: 4,
    );
    await tester.pumpAndSettle();
  }

  Future<void> tapKey(WidgetTester tester, String key) async {
    await tester.tap(find.byKey(ValueKey(key)));
    await tester.pumpAndSettle();
  }

  Future<(FakeRemoteControlRepository, RemoteControlViewModel)> pumpRemote(
    WidgetTester tester,
    FakeAttachmentPicker picker, {
    RemoteSessionSnapshot Function() snapshot = _worktree,
  }) async {
    final repository = FakeRemoteControlRepository()
      ..supportsChatAttachments = true
      ..pluginCatalog = _catalog
      ..snapshotBuilder = snapshot;
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
          home: RemoteChatScreen.worktree(
            worktree: vm.worktreesFor('ws-1').single,
            attachmentPicker: picker,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (repository, vm);
  }

  testWidgets('Remote Control + sheet keeps the keyboard closed and the '
      'draft unchanged', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final (repository, vm) = await pumpRemote(tester, picker);

    await typeKept(tester, 'Ship the release notes');
    final kept = controller(tester).value;
    expect(keyboard(tester), greaterThan(0));

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);
    for (final id in [
      'attach-camera',
      'attach-library',
      'attach-files',
      'plugins',
      'plan',
    ]) {
      expect(find.byKey(ValueKey('composer-action-$id')), findsOneWidget);
    }

    // Plugins replaces the + sheet; the keyboard stays closed.
    await tapKey(tester, 'composer-action-plugins');
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);
    await tapKey(tester, 'composer-plugin-plugin:market/github');
    expect(repository.pluginSelectionCalls.single.selections['pluginRefs'], [
      _githubRef,
    ]);
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);

    // The + sheet's Photo library row stages a photo.
    await tester.tap(find.byTooltip('Add files and more'));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('composer-action-plugins')),
        matching: find.text('2'),
      ),
      findsOneWidget,
    );
    await tapKey(tester, 'composer-action-attach-library');
    expect(find.text('plan.png'), findsOneWidget);

    expect(controller(tester).value.text, kept.text);
    expect(controller(tester).value.selection, kept.selection);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control before the first message: Plan mode and '
      'Plugins create the first chat and keep the draft', (tester) async {
    final picker = FakeAttachmentPicker()
      ..next = AttachmentPickResult(AttachmentPickerOutcome.picked, [
        FakeAttachmentPicker.file('plan.png'),
      ]);
    final (repository, vm) = await pumpRemote(
      tester,
      picker,
      snapshot: _emptyWorktree,
    );
    await typeKept(tester, 'Ship the release notes');
    final kept = controller(tester).value;
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);
    for (final id in [
      'attach-camera',
      'attach-library',
      'attach-files',
      'plugins',
      'plan',
    ]) {
      expect(find.byKey(ValueKey('composer-action-$id')), findsOneWidget);
    }
    await tapKey(tester, 'composer-action-attach-library');
    expect(repository.createChatTabTargets, isEmpty);

    // Plan mode creates the first tab, then turns plan mode on in it.
    await tester.tap(find.byTooltip('Add files and more'));
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-action-plan');
    final chatId = repository.createChatTabTargets.single.chatId!;
    expect(repository.setPlanModeTargets, isEmpty);
    repository.snapshotBuilder = () => _emptyWorktree(created: chatId);
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(repository.setPlanModeTargets.single.chatId, chatId);
    expect(repository.lastSetPlanMode, isTrue);

    // Plugins now writes to the same chat.
    await tester.tap(find.byTooltip('Add files and more'));
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-action-plugins');
    await tapKey(tester, 'composer-plugin-plugin:market/github');
    expect(repository.pluginSelectionCalls.single.target.chatId, chatId);
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await settleKeyboard(tester);

    expect(repository.createChatTabTargets, hasLength(1));
    expect(controller(tester).value.text, kept.text);
    expect(find.text('plan.png'), findsOneWidget);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control /plugins opens the sheet without sending', (
    tester,
  ) async {
    final (repository, vm) = await pumpRemote(tester, FakeAttachmentPicker());
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, 'Check /plu');
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-command-plugins');
    await settleKeyboard(tester);

    expect(
      find.byKey(const ValueKey('composer-plugins-sheet')),
      findsOneWidget,
    );
    expect(keyboard(tester), 0);
    expect(controller(tester).text, 'Check ');
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control sheets keep their last rows above the '
      'navigation bar', (tester) async {
    final (repository, vm) = await pumpRemote(tester, FakeAttachmentPicker());
    repository.pluginCatalog = {
      ..._catalog,
      'plugins': [
        for (var i = 0; i < 12; i++)
          {
            'marketplaceId': 'market',
            'pluginName': 'plugin-$i',
            'name': 'Plugin $i',
            'description': 'Does useful work number $i',
          },
      ],
    };
    final view = tester.view;
    final inset = view.padding.bottom / view.devicePixelRatio;
    final screenBottom = view.physicalSize.height / view.devicePixelRatio;
    expect(inset, greaterThan(0));

    // Each sheet adds the inset once, below its own bottom padding.
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    final plan = tester.getRect(
      find.byKey(const ValueKey('composer-action-plan')),
    );
    expect(plan.bottom, moreOrLessEquals(screenBottom - inset - 8));

    await tapKey(tester, 'composer-action-plugins');
    await settleKeyboard(tester);
    final sheet = find.byKey(const ValueKey('composer-plugins-sheet'));
    await tester.drag(sheet, const Offset(0, -3000));
    await tester.pumpAndSettle();
    final last = tester.getRect(
      find.byKey(const ValueKey('composer-plugin-plugin:market/plugin-11')),
    );
    expect(last.bottom, moreOrLessEquals(screenBottom - inset - 16));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  /// Pumps [home] over [repository]'s Cloud chats.
  Future<void> pumpCloud(
    WidgetTester tester,
    FakeCloudChatRepository repository,
    Widget home,
  ) async {
    final store = InMemoryChatDraftStore();
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
    )..attachDraftStore(store);
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
            value: ChatDraftStoreHolder(store),
          ),
        ],
        child: MaterialApp(theme: AppTheme.light, home: home),
      ),
    );
    await settleKeyboard(tester);
  }

  testWidgets('a cloud draft creates its chat with plugins chosen before '
      'typing', (tester) async {
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..capabilityCatalogValue = const ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.plugin,
            ref: _githubRef,
            name: 'GitHub',
          ),
        ],
      );
    await pumpCloud(tester, repository, const CloudChatScreen.create());

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    expect(keyboard(tester), 0);
    expect(
      find.byKey(const ValueKey('composer-action-attach-files')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey('composer-action-plan')), findsNothing);
    await tapKey(tester, 'composer-action-plugins');
    await tapKey(tester, 'composer-plugin-plugin:market/github');
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await tester.pumpAndSettle();

    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, 'Plan the launch');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(repository.createPluginSelections.single?['pluginRefs'], [
      _githubRef,
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cloud chat sheet reopened while a plugin saves keeps it '
      'when the next one turns on', (tester) async {
    const notesRef = {'sourceId': 'src', 'skillName': 'notes'};
    final saved = Completer<void>();
    late final FakeCloudChatRepository repository;
    repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..capabilityCatalogValue = const ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.plugin,
            ref: _githubRef,
            name: 'GitHub',
          ),
          ComposerPluginItem(
            kind: ComposerPluginKind.skill,
            ref: notesRef,
            name: 'Release notes',
          ),
        ],
      )
      ..capabilitiesGate = saved
      // The server keeps each accepted write as the chat's selection.
      ..capabilitiesAnswer = (selections) {
        final chat = sampleChat();
        repository.workspaces = [
          sampleWorkspace(
            chats: [
              CloudChatSummary(
                externalId: chat.externalId,
                title: chat.title,
                taskChatExternalId: null,
                modelDefinitionId: chat.modelDefinitionId,
                thinkingLevel: chat.thinkingLevel,
                coreAgentSessionId: chat.coreAgentSessionId,
                createdAtMs: chat.createdAtMs,
                capabilitySelections: selections,
              ),
            ],
          ),
        ];
        return CloudCapabilityWriteResult(selections: selections);
      };
    await pumpCloud(
      tester,
      repository,
      const CloudChatScreen(chatId: 'chat-1'),
    );
    await typeKept(tester, 'Keep this draft');
    bool on(String key) =>
        tester.widget<SwitchListTile>(find.byKey(ValueKey(key))).value;
    const github = 'composer-plugin-plugin:market/github';
    const notes = 'composer-plugin-skill:src/notes';

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    await tester.tap(find.byKey(const ValueKey(github)));
    await tester.pump(const Duration(milliseconds: 300));
    expect(on(github), isTrue);
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await tester.pumpAndSettle();

    // Reopen while the first save is still pending.
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
    for (var i = 0; i < 15; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byKey(const ValueKey('composer-plugins-sheet')), findsOne);
    expect(find.byKey(const ValueKey(github)), findsNothing);
    saved.complete();
    await tester.pumpAndSettle();
    expect(on(github), isTrue);

    await tapKey(tester, notes);
    expect(repository.capabilityCalls, hasLength(2));
    expect(repository.capabilityCalls.last.selections['pluginRefs'], [
      _githubRef,
    ]);
    expect(repository.capabilityCalls.last.selections['skillRefs'], [notesRef]);
    expect(on(github), isTrue);
    expect(on(notes), isTrue);
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await tester.pumpAndSettle();
    expect(controller(tester).text, 'Keep this draft');
    expect(repository.conversationSends, isEmpty);
    expect(tester.takeException(), isNull);
  });

  bool switchOn(WidgetTester tester, String id) => tester
      .widget<SwitchListTile>(find.byKey(ValueKey('composer-plugin-$id')))
      .value;

  Finder rowText(String id, String text) => find.descendant(
    of: find.byKey(ValueKey('composer-plugin-$id')),
    matching: find.text(text),
  );

  /// [matching] inside the row's title, where its label or error shows.
  Finder rowTitle(WidgetTester tester, String id, Finder matching) =>
      find.descendant(
        of: find.byWidget(
          tester
              .widget<SwitchListTile>(
                find.byKey(ValueKey('composer-plugin-$id')),
              )
              .title!,
        ),
        matching: matching,
      );

  Future<void> closeSheet(WidgetTester tester) async {
    Navigator.of(tester.element(find.byType(BottomSheet).last)).pop();
    await settleKeyboard(tester);
  }

  testWidgets('a cloud draft keeps plugins chosen before typing through '
      '/plugins, and the first send creates the chat with them', (
    tester,
  ) async {
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..capabilityCatalogValue = const ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.plugin,
            ref: _githubRef,
            name: 'GitHub',
          ),
        ],
      );
    await pumpCloud(tester, repository, const CloudChatScreen.create());
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    await tapKey(tester, 'composer-plugin-plugin:market/github');
    await closeSheet(tester);

    // /plugins removes its own token, which empties the draft text.
    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, '/plugins');
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-command-plugins');
    await settleKeyboard(tester);
    expect(controller(tester).text, '');
    expect(switchOn(tester, 'plugin:market/github'), isTrue);
    await closeSheet(tester);

    await tester.tap(draft);
    await settleKeyboard(tester);
    await tester.enterText(draft, 'Ship the launch notes');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(repository.createPluginSelections.single?['pluginRefs'], [
      _githubRef,
    ]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cloud MCP server the chat cannot use turns back off with an '
      'error on each attempt, and turns on once the chat can use it', (
    tester,
  ) async {
    const linearRef = {'serverId': 'linear', 'configId': 'default'};
    var usable = false;
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..capabilityCatalogValue = const ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.mcpServer,
            ref: linearRef,
            name: 'Linear',
          ),
        ],
      )
      // Saved, but held back until the user reconnects it.
      ..capabilitiesAnswer = (selections) => CloudCapabilityWriteResult(
        selections: selections,
        unusableRefs: usable ? const [] : const [linearRef],
      );
    await pumpCloud(
      tester,
      repository,
      const CloudChatScreen(chatId: 'chat-1'),
    );
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    final error = find.text('Could not change Linear. Try again.');
    for (final attempt in [1, 2]) {
      await tapKey(tester, 'composer-plugin-mcpServer:linear/default');
      expect(repository.capabilityCalls, hasLength(attempt));
      expect(switchOn(tester, 'mcpServer:linear/default'), isFalse);
      expect(error, findsOneWidget);
      // The error takes the place of the row's own label.
      expect(
        rowTitle(tester, 'mcpServer:linear/default', error),
        findsOneWidget,
      );
      expect(rowText('mcpServer:linear/default', 'Linear'), findsNothing);
    }

    usable = true;
    await tapKey(tester, 'composer-plugin-mcpServer:linear/default');
    expect(repository.capabilityCalls, hasLength(3));
    expect(switchOn(tester, 'mcpServer:linear/default'), isTrue);
    expect(error, findsNothing);
    expect(rowText('mcpServer:linear/default', 'Linear'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cloud chat that turns off its last inherited plugin keeps '
      'it off for the next toggle and after reopening', (tester) async {
    const notesRef = {'sourceId': 'src', 'skillName': 'notes'};
    const github = 'composer-plugin-plugin:market/github';
    const notes = 'composer-plugin-skill:src/notes';
    late final FakeCloudChatRepository repository;
    // The chat has no bundle and inherits GitHub from its project.
    void serverHolds(Map<String, Object?>? selections) {
      final chat = sampleChat();
      repository.workspaces = [
        sampleWorkspace(
          chats: [
            CloudChatSummary(
              externalId: chat.externalId,
              title: chat.title,
              taskChatExternalId: null,
              modelDefinitionId: chat.modelDefinitionId,
              thinkingLevel: chat.thinkingLevel,
              coreAgentSessionId: chat.coreAgentSessionId,
              createdAtMs: chat.createdAtMs,
              capabilitySelections: selections,
            ),
          ],
        ),
      ];
    }

    repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..capabilityCatalogValue = const ComposerPluginCatalog(
        items: [
          ComposerPluginItem(
            kind: ComposerPluginKind.plugin,
            ref: _githubRef,
            name: 'GitHub',
          ),
          ComposerPluginItem(
            kind: ComposerPluginKind.skill,
            ref: notesRef,
            name: 'Release notes',
          ),
        ],
      )
      ..capabilitiesAnswer = (selections) {
        final empty = [
          'collectionIds',
          'skillRefs',
          'pluginRefs',
          'mcpServerRefs',
        ].every((key) => (selections[key] as List?)?.isEmpty ?? true);
        if (!empty) {
          serverHolds(selections);
          return CloudCapabilityWriteResult(selections: selections);
        }
        // The route's answer for an empty selection on a chat with no
        // bundle: nothing to stage, and no capabilitySelections.
        serverHolds(null);
        return CloudCapabilityWriteResult.fromJson({
          'capabilityBundles': <String, Object?>{},
          'capabilityBundleStateVersion': 1,
          'outcome': 'unchanged',
          'warnings': <Object?>[],
        });
      };
    serverHolds(const {
      'collectionIds': <Object?>[],
      'skillRefs': <Object?>[],
      'pluginRefs': [_githubRef],
      'mcpServerRefs': <Object?>[],
    });
    await pumpCloud(
      tester,
      repository,
      const CloudChatScreen(chatId: 'chat-1'),
    );
    bool on(String key) =>
        tester.widget<SwitchListTile>(find.byKey(ValueKey(key))).value;
    final error = find.textContaining('Try again.');

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(on(github), isTrue);

    await tapKey(tester, github);
    expect(repository.capabilityCalls, hasLength(1));
    expect(on(github), isFalse);
    expect(error, findsNothing);

    await tapKey(tester, notes);
    expect(repository.capabilityCalls, hasLength(2));
    expect(repository.capabilityCalls.last.selections['pluginRefs'], isEmpty);
    expect(repository.capabilityCalls.last.selections['skillRefs'], [notesRef]);
    expect(on(notes), isTrue);
    expect(on(github), isFalse);
    expect(error, findsNothing);
    await closeSheet(tester);

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(on(notes), isTrue);
    expect(on(github), isFalse);
    expect(error, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Remote Control sheet reopened while a removal saves shows the '
      'desktop answer, and the next toggle keeps the rejected removal out', (
    tester,
  ) async {
    final (repository, vm) = await pumpRemote(tester, FakeAttachmentPicker());
    var commands = 0;
    repository.setPluginSelectionsHandler = (_) async =>
        'plugins-${++commands}';
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    await tapKey(tester, 'composer-plugin-collection:kit');
    expect(switchOn(tester, 'collection:kit'), isFalse);
    await closeSheet(tester);

    // Reopen while the desktop has not answered the removal.
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.byKey(const ValueKey('composer-plugins-sheet')), findsOne);
    expect(
      find.byKey(const ValueKey('composer-plugin-collection:kit')),
      findsNothing,
    );
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            message: 'Plugins are unavailable.',
            commandId: 'plugins-1',
          ),
        ],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(switchOn(tester, 'collection:kit'), isTrue);

    await tapKey(tester, 'composer-plugin-plugin:market/github');
    final last = repository.pluginSelectionCalls.last.selections;
    expect(last['collectionIds'], ['kit']);
    expect(last['pluginRefs'], [_githubRef]);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control sheet whose chat closes saves nothing to the '
      'chat shown next', (tester) async {
    RemoteSessionSnapshot chats({required bool withFirst}) {
      final base = _worktree();
      return RemoteSessionSnapshot(
        workspaces: base.workspaces,
        worktrees: base.worktrees,
        standaloneChats: base.standaloneChats,
        chatSummaries: [
          if (withFirst) ...base.chatSummaries,
          const RemoteChatSummary(
            chatId: 'chat-2',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Second chat',
            providerType: 'claude',
            pluginSelectionsDetail: {
              'collectionIds': <Object?>[],
              'skillRefs': <Object?>[],
              'pluginRefs': <Object?>[],
            },
          ),
        ],
      );
    }

    final (repository, vm) = await pumpRemote(
      tester,
      FakeAttachmentPicker(),
      snapshot: () => chats(withFirst: true),
    );
    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(switchOn(tester, 'collection:kit'), isTrue);

    repository.snapshotBuilder = () => chats(withFirst: false);
    await vm.refresh();
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-plugin-plugin:market/github');

    expect(repository.pluginSelectionCalls, isEmpty);
    expect(switchOn(tester, 'plugin:market/github'), isFalse);
    expect(find.text('Could not change GitHub. Try again.'), findsOneWidget);
    // The error takes the place of the row's label; its detail stays.
    expect(
      rowTitle(
        tester,
        'plugin:market/github',
        find.text('Could not change GitHub. Try again.'),
      ),
      findsOneWidget,
    );
    expect(rowText('plugin:market/github', 'GitHub'), findsNothing);
    expect(rowText('plugin:market/github', 'Pull requests'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control Claude chat keeps a Codex-only plugin off and '
      'lets a selected one turn off', (tester) async {
    const reviewRef = {'marketplaceId': 'market', 'pluginName': 'codex-review'};
    RemoteSessionSnapshot snapshot(List<Object?> pluginRefs) {
      final base = _worktree();
      final summary = base.chatSummaries.single;
      return RemoteSessionSnapshot(
        workspaces: base.workspaces,
        worktrees: base.worktrees,
        standaloneChats: base.standaloneChats,
        chatSummaries: [
          RemoteChatSummary(
            chatId: summary.chatId,
            scope: summary.scope,
            workspaceLocalId: summary.workspaceLocalId,
            worktreeLocalId: summary.worktreeLocalId,
            title: summary.title,
            active: true,
            providerType: summary.providerType,
            model: summary.model,
            modelLabel: summary.modelLabel,
            thinkingLevel: summary.thinkingLevel,
            providerAvailability: summary.providerAvailability,
            availableModels: summary.availableModels,
            modelCatalogProjected: true,
            pluginSelectionsDetail: {
              'collectionIds': ['kit'],
              'skillRefs': <Object?>[],
              'pluginRefs': pluginRefs,
            },
          ),
        ],
      );
    }

    final (repository, vm) = await pumpRemote(
      tester,
      FakeAttachmentPicker(),
      snapshot: () => snapshot([reviewRef]),
    );
    repository.pluginCatalog = {
      ..._catalog,
      'plugins': [
        {..._githubRef, 'name': 'GitHub', 'description': 'Pull requests'},
        for (final (name, label) in [
          ('codex-tools', 'Codex tools'),
          ('codex-review', 'Codex review'),
        ])
          {
            'marketplaceId': 'market',
            'pluginName': name,
            'name': label,
            'description': 'Runs in Codex chats',
            'claudeSupported': false,
            'codexSupported': true,
          },
      ],
    };
    bool enabled(String id) =>
        tester
            .widget<SwitchListTile>(find.byKey(ValueKey('composer-plugin-$id')))
            .onChanged !=
        null;
    Finder reason(String id) => find.descendant(
      of: find.byKey(ValueKey('composer-plugin-$id')),
      matching: find.text('Unsupported by this provider'),
    );

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(keyboard(tester), 0);
    expect(enabled('plugin:market/codex-tools'), isFalse);
    expect(reason('plugin:market/codex-tools'), findsOneWidget);
    expect(enabled('plugin:market/github'), isTrue);
    await tapKey(tester, 'composer-plugin-plugin:market/codex-tools');
    expect(repository.pluginSelectionCalls, isEmpty);
    expect(switchOn(tester, 'plugin:market/codex-tools'), isFalse);

    expect(switchOn(tester, 'plugin:market/codex-review'), isTrue);
    expect(enabled('plugin:market/codex-review'), isTrue);
    expect(reason('plugin:market/codex-review'), findsOneWidget);
    await tapKey(tester, 'composer-plugin-plugin:market/codex-review');
    expect(repository.pluginSelectionCalls.single.selections['pluginRefs'], []);
    repository.snapshotBuilder = () => snapshot(const []);
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [RemoteCommandCompletedEvent(commandId: 'fake-cmd-1')],
        nextCursor: 1,
      ),
    );
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(switchOn(tester, 'plugin:market/codex-review'), isFalse);
    await closeSheet(tester);

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(switchOn(tester, 'plugin:market/codex-review'), isFalse);
    expect(enabled('plugin:market/codex-review'), isFalse);
    expect(repository.pluginSelectionCalls, hasLength(1));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control before the first message: Plugins follows the '
      "new chat's provider, and a selected plugin it cannot use turns off "
      'and stays off after reopening', (tester) async {
    const toolsRef = {'marketplaceId': 'market', 'pluginName': 'codex-tools'};
    const reviewRef = {'marketplaceId': 'market', 'pluginName': 'codex-review'};
    final (repository, vm) = await pumpRemote(
      tester,
      FakeAttachmentPicker(),
      snapshot: _emptyWorktree,
    );
    repository
      ..setPluginSelectionsHandler = ((_) async => 'plugins-1')
      ..pluginCatalog = {
        ..._catalog,
        'plugins': [
          {..._githubRef, 'name': 'GitHub', 'description': 'Pull requests'},
          for (final (ref, label) in [
            (toolsRef, 'Codex tools'),
            (reviewRef, 'Codex review'),
          ])
            {
              ...ref,
              'name': label,
              'description': 'Runs in Codex chats',
              'claudeSupported': false,
              'codexSupported': true,
            },
        ],
      };
    bool enabled(String id) =>
        tester
            .widget<SwitchListTile>(find.byKey(ValueKey('composer-plugin-$id')))
            .onChanged !=
        null;

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final chatId = repository.createChatTabTargets.single.chatId!;
    repository.snapshotBuilder = () =>
        _emptyWorktree(created: chatId, pluginRefs: const [reviewRef]);
    await vm.refresh();
    await tester.pumpAndSettle();

    // The new chat runs Claude, so Codex-only plugins cannot turn on.
    expect(enabled('plugin:market/codex-tools'), isFalse);
    await tapKey(tester, 'composer-plugin-plugin:market/codex-tools');
    expect(repository.pluginSelectionCalls, isEmpty);
    expect(switchOn(tester, 'plugin:market/codex-tools'), isFalse);
    expect(enabled('plugin:market/github'), isTrue);

    // A selected one still turns off, and it stays off.
    expect(switchOn(tester, 'plugin:market/codex-review'), isTrue);
    await tapKey(tester, 'composer-plugin-plugin:market/codex-review');
    final call = repository.pluginSelectionCalls.single;
    expect(call.target.chatId, chatId);
    expect(call.selections['pluginRefs'], isEmpty);
    repository.snapshotBuilder = () => _emptyWorktree(created: chatId);
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [RemoteCommandCompletedEvent(commandId: 'plugins-1')],
        nextCursor: 2,
      ),
    );
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(switchOn(tester, 'plugin:market/codex-review'), isFalse);
    expect(enabled('plugin:market/codex-review'), isFalse);
    await closeSheet(tester);

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tapKey(tester, 'composer-action-plugins');
    expect(switchOn(tester, 'plugin:market/codex-review'), isFalse);
    expect(enabled('plugin:market/codex-review'), isFalse);
    expect(repository.pluginSelectionCalls, hasLength(1));
    expect(repository.createChatTabTargets, hasLength(1));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });

  testWidgets('Remote Control before the first message: a session replaced '
      'before the desktop lists the chat offers Retry, which saves to the '
      'same tab', (tester) async {
    final (repository, vm) = await pumpRemote(
      tester,
      FakeAttachmentPicker(),
      snapshot: _emptyWorktree,
    );
    await typeKept(tester, 'Ship the release notes');
    final kept = controller(tester).value.text;

    await tester.tap(find.byTooltip('Add files and more'));
    await settleKeyboard(tester);
    await tester.tap(find.byKey(const ValueKey('composer-action-plugins')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final chatId = repository.createChatTabTargets.single.chatId!;
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await vm.disconnect();
    await vm.connect('654321');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text("Couldn't load plugins."), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    await tester.tap(find.byKey(const ValueKey('composer-plugins-retry')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(repository.createChatTabTargets.map((target) => target.chatId), [
      chatId,
      chatId,
    ]);
    repository.snapshotBuilder = () => _emptyWorktree(created: chatId);
    await vm.refresh();
    await tester.pumpAndSettle();
    await tapKey(tester, 'composer-plugin-plugin:market/github');
    expect(repository.pluginSelectionCalls.single.target.chatId, chatId);
    await closeSheet(tester);

    expect(controller(tester).value.text, kept);
    expect(repository.sendChatMessageCalls, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    vm.dispose();
  });
}
