// CAN-4436 device acceptance for the composer's Effort sheet, with real
// touch input on the slider and sheet. Run from apps/mobile:
//
//   flutter test integration_test/can_4436_effort_device_test.dart \
//     -d <device-id>
//
// Synthetic fixtures only: no account, desktop, or network.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/composer/canopy_effort_control.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/cloud_chat_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_cloud_chat_repository.dart';
import '../test/support/fake_remote_control_repository.dart';

const _allLevels = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

Map<String, dynamic> _row(String id, String provider, List<String> levels) => {
  'id': id,
  'label': id,
  'provider': provider,
  'kind': 'model',
  'supportedThinkingLevels': levels,
};

Map<String, dynamic> _tab(String chatId, String title, {bool active = false}) =>
    {
      'chatId': chatId,
      'scope': 'worktree',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
      'title': title,
      'active': active,
      'providerAvailability': {'claude': true, 'codex': true, 'cursor': true},
    };

RemoteChatMessage _answer(String chatId) => RemoteChatMessage(
  messageId: 'm-$chatId',
  chatId: chatId,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: 'Ready when you are.',
);

/// One worktree with chat-1 shown, and chat-2 as another tab when [other]
/// is set.
RemoteSessionSnapshot _worktree(
  Map<String, dynamic> summary, {
  Map<String, dynamic>? other,
}) => RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: const [
    RemoteWorktree(localId: 'wt-1', workspaceLocalId: 'ws-1', branch: 'main'),
  ],
  standaloneChats: const [],
  chatSummaries: [
    RemoteChatSummary.fromJson({
      ..._tab('chat-1', 'Effort levels', active: true),
      ...summary,
    }),
    if (other != null)
      RemoteChatSummary.fromJson({..._tab('chat-2', 'Other chat'), ...other}),
  ],
  // An empty transcript reads as loading while hydration runs, which keeps
  // pumpAndSettle waiting on a device.
  chatMessages: [_answer('chat-1'), if (other != null) _answer('chat-2')],
);

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  final trigger = find.byKey(const ValueKey('composer-thinking'));
  final slider = find.byKey(const ValueKey('effort-slider'));

  Future<FakeRemoteControlRepository> pumpRemote(
    WidgetTester tester,
    Map<String, dynamic> summary, {
    Map<String, dynamic>? other,
  }) async {
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = (() => _worktree(summary, other: other));
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
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return repository;
  }

  List<String> sheetLevels(WidgetTester tester) =>
      tester.widget<CanopyEffortPanel>(find.byType(CanopyEffortPanel)).levels;

  Future<void> dismissSheet(WidgetTester tester) async {
    // Tap the scrim above the sheet, as a person would.
    await tester.tapAt(const Offset(20, 40));
    await tester.pumpAndSettle();
  }

  testWidgets('a Claude 5 chat at Low drags to Ultra and commits once', (
    tester,
  ) async {
    final repository = await pumpRemote(tester, {
      'providerType': 'claude',
      'model': 'opus[1m]',
      'modelLabel': 'Opus 5',
      'thinkingLevel': 'low',
      'availableModels': [_row('opus[1m]', 'claude', _allLevels)],
    });
    expect(
      find.descendant(of: trigger, matching: find.text('Low')),
      findsOneWidget,
    );
    expect(tester.getSize(trigger).width, greaterThanOrEqualTo(48));
    expect(tester.getSize(trigger).height, greaterThanOrEqualTo(48));

    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheetLevels(tester), _allLevels);

    final rect = tester.getRect(slider);
    final gesture = await tester.startGesture(
      Offset(rect.left + rect.width / 6, rect.center.dy),
    );
    await gesture.moveTo(Offset(rect.right - 2, rect.center.dy));
    await tester.pump();
    expect(repository.lastSetThinkingLevel, isNull, reason: 'preview only');
    await gesture.up();
    await tester.pumpAndSettle();
    expect(repository.lastSetThinkingLevel, 'ultra');

    await dismissSheet(tester);
    expect(find.byType(CanopyEffortPanel), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'an Effort choice that fails to send shows the chat level again',
    (tester) async {
      final repository = await pumpRemote(tester, {
        'providerType': 'claude',
        'model': 'opus[1m]',
        'modelLabel': 'Opus 5',
        'thinkingLevel': 'low',
        'availableModels': [_row('opus[1m]', 'claude', _allLevels)],
      });
      repository.setThinkingLevelHandler = (_) async =>
          throw const RemoteControlException('Effort not sent');
      await tester.tap(trigger);
      await tester.pumpAndSettle();

      final rect = tester.getRect(slider);
      final gesture = await tester.startGesture(
        Offset(rect.left + rect.width / 6, rect.center.dy),
      );
      await gesture.moveTo(Offset(rect.right - 2, rect.center.dy));
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();
      expect(repository.lastSetThinkingLevel, 'ultra');
      expect(find.text('Effort not sent'), findsOneWidget);
      expect(
        tester
            .widget<Text>(
              find.descendant(
                of: find.byKey(const ValueKey('effort-level')),
                matching: find.byType(Text),
              ),
            )
            .textSpan!
            .toPlainText(),
        'Effort  Low',
      );
      expect(tester.widget<Slider>(slider).value, _allLevels.indexOf('low'));

      await dismissSheet(tester);
      expect(
        find.descendant(of: trigger, matching: find.text('Low')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a rollback of a pending High during a drag keeps the drag', (
    tester,
  ) async {
    final repository = await pumpRemote(tester, {
      'providerType': 'claude',
      'model': 'opus[1m]',
      'modelLabel': 'Opus 5',
      'thinkingLevel': 'medium',
      'availableModels': [_row('opus[1m]', 'claude', _allLevels)],
    });
    final sent = <String>[];
    repository.setThinkingLevelHandler = (level) async {
      sent.add(level);
      return 'effort-cmd-${sent.length}';
    };
    String heading() => tester
        .widget<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('effort-level')),
            matching: find.byType(Text),
          ),
        )
        .textSpan!
        .toPlainText();
    await tester.tap(trigger);
    await tester.pumpAndSettle();

    // Real drags: move from None until the heading names the level.
    final rect = tester.getRect(slider);
    Future<TestGesture> dragTo(String label) async {
      final start = Offset(rect.left + 2, rect.center.dy);
      final gesture = await tester.startGesture(start);
      await gesture.moveTo(start + const Offset(40, 0));
      await gesture.moveTo(start);
      await tester.pump();
      for (var x = start.dx; x < rect.right; x += 2) {
        await gesture.moveTo(Offset(x, rect.center.dy));
        await tester.pump();
        if (heading() == 'Effort  $label') break;
      }
      expect(heading(), 'Effort  $label');
      return gesture;
    }

    final high = await dragTo('High');
    await high.up();
    await tester.pumpAndSettle();
    expect(sent, ['high']);

    // High is still pending when the chat refuses it under a drag to Max.
    final max = await dragTo('Max');
    repository.eventsController.add(
      const RemotePortalEventBatch(
        events: [
          RemoteCommandFailedEvent(
            message: 'Effort refused',
            commandId: 'effort-cmd-1',
          ),
        ],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Effort refused'), findsOneWidget);
    expect(heading(), 'Effort  Max', reason: 'the drag is still down');
    expect(tester.widget<Slider>(slider).value, _allLevels.indexOf('max'));

    await max.up();
    await tester.pumpAndSettle();
    expect(sent, ['high', 'max'], reason: 'the release sends the label');
    expect(heading(), 'Effort  Max');

    await dismissSheet(tester);
    expect(
      find.descendant(of: trigger, matching: find.text('Max')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a desktop model switch under a drag sends nothing; the next '
      'drag does', (tester) async {
    Map<String, dynamic> on(String model, String label) => {
      'providerType': 'claude',
      'model': model,
      'modelLabel': label,
      'thinkingLevel': 'medium',
      'availableModels': [
        _row('opus[1m]', 'claude', _allLevels),
        _row('sonnet[1m]', 'claude', _allLevels),
      ],
    };
    final repository = await pumpRemote(tester, on('opus[1m]', 'Opus 5'));
    final sent = <String>[];
    repository.setThinkingLevelHandler = (level) async {
      sent.add(level);
      return 'effort-cmd-${sent.length}';
    };
    String heading() => tester
        .widget<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('effort-level')),
            matching: find.byType(Text),
          ),
        )
        .textSpan!
        .toPlainText();
    await tester.tap(trigger);
    await tester.pumpAndSettle();

    final rect = tester.getRect(slider);
    Future<TestGesture> dragTo(String label) async {
      final start = Offset(rect.left + 2, rect.center.dy);
      final gesture = await tester.startGesture(start);
      await gesture.moveTo(start + const Offset(40, 0));
      await gesture.moveTo(start);
      await tester.pump();
      for (var x = start.dx; x < rect.right; x += 2) {
        await gesture.moveTo(Offset(x, rect.center.dy));
        await tester.pump();
        if (heading() == 'Effort  $label') break;
      }
      expect(heading(), 'Effort  $label');
      return gesture;
    }

    // The desktop moves the chat to Sonnet, with the same levels and level,
    // while a drag on Opus holds High.
    final high = await dragTo('High');
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateDeltaEvent(
            chatSummaries: [
              _worktree(on('sonnet[1m]', 'Sonnet 5')).chatSummaries.single,
            ],
          ),
        ],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Sonnet 5'), findsOneWidget);
    expect(sheetLevels(tester), _allLevels);
    expect(heading(), 'Effort  Medium', reason: 'Sonnet is shown');

    await high.moveTo(Offset(rect.right - 4, rect.center.dy));
    await tester.pumpAndSettle();
    expect(heading(), 'Effort  Medium');
    await high.up();
    await tester.pumpAndSettle();
    expect(sent, isEmpty, reason: 'the Opus drag sends nothing');
    expect(heading(), 'Effort  Medium');

    final max = await dragTo('Max');
    await max.up();
    await tester.pumpAndSettle();
    expect(sent, ['max']);

    await dismissSheet(tester);
    expect(
      find.descendant(of: trigger, matching: find.text('Max')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a desktop close of the shown chat under a drag sends nothing; '
      'the fallback chat takes the next drag', (tester) async {
    final opus = {
      'providerType': 'claude',
      'model': 'opus[1m]',
      'modelLabel': 'Opus 5',
      'thinkingLevel': 'medium',
      'availableModels': [_row('opus[1m]', 'claude', _allLevels)],
    };
    final repository = await pumpRemote(tester, opus, other: opus);
    final sent = <String>[];
    repository.setThinkingLevelHandler = (level) async {
      sent.add(level);
      return 'effort-cmd-${sent.length}';
    };
    String heading() => tester
        .widget<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('effort-level')),
            matching: find.byType(Text),
          ),
        )
        .textSpan!
        .toPlainText();
    await tester.tap(trigger);
    await tester.pumpAndSettle();

    final rect = tester.getRect(slider);
    Future<TestGesture> dragTo(String label) async {
      final start = Offset(rect.left + 2, rect.center.dy);
      final gesture = await tester.startGesture(start);
      await gesture.moveTo(start + const Offset(40, 0));
      await gesture.moveTo(start);
      await tester.pump();
      for (var x = start.dx; x < rect.right; x += 2) {
        await gesture.moveTo(Offset(x, rect.center.dy));
        await tester.pump();
        if (heading() == 'Effort  $label') break;
      }
      expect(heading(), 'Effort  $label');
      return gesture;
    }

    // The desktop closes chat-1 while a drag on it holds High. The screen
    // falls back to chat-2, on the same model, levels and level.
    final high = await dragTo('High');
    repository.eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: 'chat',
            selectedChatOnly: true,
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: 'wt-1',
            targetChatId: 'chat-2',
            targetChatScope: RemoteChatScope.worktree,
            chatSummaries: [
              RemoteChatSummary.fromJson({
                ..._tab('chat-2', 'Other chat', active: true),
                ...opus,
              }),
            ],
            chatMessages: [_answer('chat-2')],
          ),
        ],
        nextCursor: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Other chat'), findsWidgets);
    expect(sheetLevels(tester), _allLevels);
    expect(heading(), 'Effort  Medium', reason: 'chat-2 is shown');

    await high.moveTo(Offset(rect.right - 4, rect.center.dy));
    await tester.pumpAndSettle();
    expect(heading(), 'Effort  Medium');
    await high.up();
    await tester.pumpAndSettle();
    expect(sent, isEmpty, reason: 'the chat-1 drag sends nothing');
    expect(repository.setThinkingLevelTargets, isEmpty);
    expect(heading(), 'Effort  Medium');

    final max = await dragTo('Max');
    await max.up();
    await tester.pumpAndSettle();
    expect(sent, ['max']);
    expect(repository.setThinkingLevelTargets.map((target) => target.chatId), [
      'chat-2',
    ]);

    await dismissSheet(tester);
    expect(
      find.descendant(of: trigger, matching: find.text('Max')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a gpt-6-astra chat offers Low through Ultra; Fast toggles', (
    tester,
  ) async {
    final repository = await pumpRemote(tester, {
      'providerType': 'codex',
      'model': 'gpt-6-astra',
      'modelLabel': 'GPT-6 Astra',
      'thinkingLevel': 'xhigh',
      'availableModels': [_row('gpt-6-astra', 'codex', _allLevels.sublist(1))],
    });
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheetLevels(tester), _allLevels.sublist(1));
    await tester.tap(find.byKey(const ValueKey('effort-fast-mode')));
    await tester.pumpAndSettle();
    expect(repository.lastSetFastMode, isTrue);
    await dismissSheet(tester);
    expect(find.byKey(const ValueKey('effort-trigger-bolt')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a Cursor chat has no effort and no /thinking', (tester) async {
    final repository = await pumpRemote(tester, {
      'providerType': 'cursor',
      'model': 'cursor-composer',
      'modelLabel': 'Composer',
      'availableModels': [_row('cursor-composer', 'cursor', const [])],
    });
    expect(trigger, findsNothing);
    final draft = find.byKey(const ValueKey('composer-draft'));
    await tester.tap(draft);
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(draft, '/thi');
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('composer-command-thinking')),
      findsNothing,
    );
    expect(repository.lastSetThinkingLevel, isNull);
    expect(tester.takeException(), isNull);
  });

  for (final provider in ['claude', 'codex']) {
    testWidgets('a $provider row with an empty legacy set has no effort', (
      tester,
    ) async {
      final repository = await pumpRemote(tester, {
        'providerType': provider,
        'model': 'legacy-model',
        'modelLabel': 'Legacy model',
        'availableModels': [
          {
            'id': 'legacy-model',
            'label': 'Legacy model',
            'provider': provider,
            'kind': 'model',
            'thinkingLevels': <String>[],
          },
        ],
      });
      expect(trigger, findsNothing);
      final draft = find.byKey(const ValueKey('composer-draft'));
      await tester.tap(draft);
      await tester.pump(const Duration(milliseconds: 600));
      await tester.enterText(draft, '/thi');
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('composer-command-thinking')),
        findsNothing,
      );
      expect(repository.lastSetThinkingLevel, isNull);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('an Ultra fast chat shows the purple bolt and stays unchanged', (
    tester,
  ) async {
    final repository = await pumpRemote(tester, {
      'providerType': 'codex',
      'model': 'gpt-6-astra',
      'modelLabel': 'GPT-6 Astra',
      'thinkingLevel': 'high',
      'fastMode': false,
      'speed': 'ultrafast',
      'availableModels': [_row('gpt-6-astra', 'codex', _allLevels.sublist(1))],
    });
    final bolt = find.byKey(const ValueKey('effort-trigger-bolt'));
    expect(
      tester.widget<CanopyIcon>(bolt).tint,
      AppColors.of(tester.element(bolt))['fg-special'],
    );
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Fastest replies. Higher speeds may use more of your subscription '
        'allowance. Change it in the desktop app.',
      ),
      findsOneWidget,
    );
    final learnMore = find.bySemanticsLabel('Learn more about speed usage');
    expect(learnMore, findsOneWidget);
    expect(tester.getSize(learnMore).height, greaterThanOrEqualTo(48));
    await tester.tap(find.byKey(const ValueKey('effort-fast-mode')));
    await tester.pumpAndSettle();
    await dismissSheet(tester);
    expect(repository.lastSetFastMode, isNull);
    expect(repository.lastSetThinkingLevel, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Ultra fast arriving while Fast is pending stays unchanged', (
    tester,
  ) async {
    final summary = <String, dynamic>{
      'providerType': 'codex',
      'model': 'gpt-6-astra',
      'modelLabel': 'GPT-6 Astra',
      'thinkingLevel': 'high',
      'speed': 'standard',
      'availableModels': [_row('gpt-6-astra', 'codex', _allLevels.sublist(1))],
    };
    final repository = await pumpRemote(tester, summary);
    final vm = Provider.of<RemoteControlViewModel>(
      tester.element(trigger),
      listen: false,
    );
    final toggle = find.byKey(const ValueKey('effort-fast-mode'));
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(repository.setFastModeCommandIds, hasLength(1));

    // The desktop reports Ultra fast before it completes the Fast command.
    summary['speed'] = 'ultrafast';
    await vm.refresh();
    await tester.pumpAndSettle();
    expect(
      find.descendant(of: toggle, matching: find.byType(IconButton)),
      findsNothing,
      reason: 'the open sheet shows Ultra fast read-only',
    );
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    await dismissSheet(tester);

    final draft = find.byKey(const ValueKey('composer-draft'));
    await tester.tap(draft);
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(draft, '/fast');
    await tester.pumpAndSettle();
    final command = find.byKey(const ValueKey('composer-command-fast'));
    if (tester.any(command)) {
      await tester.tap(command);
      await tester.pumpAndSettle();
    }
    expect(repository.setFastModeCommandIds, hasLength(1));
    final bolt = find.byKey(const ValueKey('effort-trigger-bolt'));
    expect(
      tester.widget<CanopyIcon>(bolt).tint,
      AppColors.of(tester.element(bolt))['fg-special'],
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a cloud draft offers its catalog levels and sends the pick', (
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
          home: const CloudChatScreen.create(
            initialWorkspaceId: 'cloud-workspace-1',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheetLevels(tester), ['off', 'low', 'medium', 'high']);
    await dismissSheet(tester);
    expect(tester.takeException(), isNull);
  });

  // CAN-4436 published review: the draft creates its chat under an open
  // Effort sheet. The sheet keeps changing the created chat's choices, and
  // the next send takes them.
  testWidgets('a cloud Effort sheet open while the draft creates its chat '
      'follows the created chat', (tester) async {
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()]);
    final creating = Completer<void>();
    repository.createCompleters['ws-1'] = creating;
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
          home: const CloudChatScreen.create(initialWorkspaceId: 'ws-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final fast = find.byKey(const ValueKey('effort-fast-mode'));
    String speed() => tester
        .widget<Text>(
          find.descendant(
            of: find.byKey(const ValueKey('effort-speed')),
            matching: find.byType(Text),
          ),
        )
        .textSpan!
        .toPlainText();
    // A send or turn spinner runs, so the frames do not settle.
    Future<void> frames() => tester.pump(const Duration(milliseconds: 400));

    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'first',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await frames();
    await tester.tap(trigger);
    await frames();
    await frames();
    expect(speed(), 'Speed  Regular');

    creating.complete();
    await frames();
    final chatId = repository.createCalls.single.externalId;
    expect(chat.state?.chatId, chatId);
    expect(find.byType(CanopyEffortPanel), findsOneWidget);
    await tester.tap(fast);
    await frames();
    expect(speed(), 'Speed  Fast');
    await tester.tap(fast);
    await frames();
    expect(speed(), 'Speed  Regular');
    await tester.tap(fast);
    await frames();
    expect(speed(), 'Speed  Fast');
    final rect = tester.getRect(slider);
    final drag = await tester.startGesture(
      Offset(rect.left + 2, rect.center.dy),
    );
    await drag.moveTo(Offset(rect.right - 2, rect.center.dy));
    await tester.pump();
    await drag.up();
    await frames();
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('effort-level')),
        matching: find.textContaining('Extra High', findRichText: true),
      ),
      findsOneWidget,
    );

    // The first turn ends; Fast still turns off from the same sheet.
    void frame(String event, Map<String, Object?> data, String id) => streams
        .last
        .add(CloudSseFrame(event: event, data: jsonEncode(data), id: id));
    frame('message.start', {'sourceKey': 'turn-1', 'role': 'assistant'}, '100');
    frame('message.delta', {'sourceKey': 'turn-1', 'textDelta': 'done'}, '101');
    frame('message.finish', {'sourceKey': 'turn-1'}, '102');
    await frames();
    expect(chat.turnInProgress, isFalse);
    await tester.tap(fast);
    await tester.pumpAndSettle();
    expect(speed(), 'Speed  Regular');
    await dismissSheet(tester);

    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'second',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await frames();
    expect(repository.postCalls, hasLength(2));
    final next = repository.postCalls.last;
    expect(next.chatId, chatId);
    expect(next.thinking, 'xhigh');
    expect(next.fast, isFalse);
    expect(tester.takeException(), isNull);
  });

  // CAN-4436 published review: a chat saved at Max on a model the catalog no
  // longer lists keeps its own levels, not the default model's, and its next
  // send keeps the model and sends no effort.
  testWidgets('a cloud chat on an unlisted model keeps Max and sends no '
      'effort', (tester) async {
    final repository = FakeCloudChatRepository(
      workspaces: [
        sampleWorkspace(
          chats: [sampleChat(model: 'claude-opus-4-5', thinkingLevel: 'max')],
        ),
      ],
    );
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
          home: const CloudChatScreen(chatId: 'chat-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Model no longer available'), findsOneWidget);
    expect(
      find.descendant(of: trigger, matching: find.text('Max')),
      findsOneWidget,
    );
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheetLevels(tester), ['off', 'medium', 'high', 'xhigh', 'max']);
    await dismissSheet(tester);

    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'still here?',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump(const Duration(milliseconds: 400));
    final next = repository.postCalls.single;
    expect(next.model, 'claude-opus-4-5');
    expect(next.thinking, isNull);
    expect(tester.takeException(), isNull);
  });

  // CAN-4436 required review: Core binds the chat to Codex and the model
  // catalog request fails. The sheet offers the Codex levels, so a drag to
  // the end lands on Extra High, and the next send carries it.
  testWidgets('a Codex cloud chat whose catalog failed tops out at Extra '
      'High', (tester) async {
    final repository = FakeCloudChatRepository(workspaces: [sampleWorkspace()])
      ..modelsError = StateError('catalog unavailable')
      ..bootstraps['chat-1'] = const CloudChatBootstrap(
        messages: [
          CloudCoreMessage(
            id: 'a1',
            role: 'ASSISTANT',
            text: 'Ready when you are.',
            sourceKey: 'turn-1',
            model: {'id': 'gpt-5.6-luna'},
            cost: CloudCoreCost(kind: CloudCoreCostKind.zero),
            costBilledViaLlmProxy: false,
            createdAtMs: 1789890001000,
            artifacts: [],
          ),
        ],
        toolActivity: [],
        executionHarness: 'codex',
      );
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
          home: const CloudChatScreen(chatId: 'chat-1'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(list.modelsError, isNotNull);
    expect(chat.state?.executionHarness, 'codex');
    expect(
      find.descendant(of: trigger, matching: find.text('Medium')),
      findsOneWidget,
    );
    await tester.tap(trigger);
    await tester.pumpAndSettle();
    expect(sheetLevels(tester), ['off', 'medium', 'high', 'xhigh']);
    final rect = tester.getRect(slider);
    final drag = await tester.startGesture(
      Offset(rect.left + 2, rect.center.dy),
    );
    await drag.moveTo(Offset(rect.right - 2, rect.center.dy));
    await tester.pump();
    await drag.up();
    await tester.pumpAndSettle();
    await dismissSheet(tester);
    expect(
      find.descendant(of: trigger, matching: find.text('Extra High')),
      findsOneWidget,
    );

    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'keep going',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await tester.pump(const Duration(milliseconds: 400));
    final next = repository.postCalls.single;
    expect(next.model, 'gpt-5.6-luna');
    expect(next.thinking, 'xhigh');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Developer options shows the Effort reference', (tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: AppTheme.light, home: const DesignSystemScreen()),
    );
    final entry = find.byKey(const ValueKey('effort-button'));
    await tester.scrollUntilVisible(entry, 200);
    await tester.pumpAndSettle();
    await tester.tap(entry);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('effort-trigger-fast')));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsOneWidget);
    await dismissSheet(tester);
    expect(tester.takeException(), isNull);
  });
}
