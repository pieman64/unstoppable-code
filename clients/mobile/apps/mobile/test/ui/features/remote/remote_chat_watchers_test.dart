import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_watchers_chip.dart';
import 'package:provider/provider.dart';

import '../../../support/fake_remote_control_repository.dart';
import '../../../support/reduced_motion.dart';

void main() {
  useReducedMotion();

  final chip = find.byKey(const ValueKey('composer-watchers'));

  Future<RemoteControlViewModel> pumpChat(
    WidgetTester tester, {
    bool supportsWatchers = true,
    bool preloadActivity = false,
    FakeRemoteControlRepository? source,
    List<AskUserQuestionState> pendingQuestions = const [],
    ThemeMode mode = ThemeMode.light,
  }) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final repository = (source ?? FakeRemoteControlRepository())
      ..supportsForegroundChat = true
      ..supportsWatchers = supportsWatchers
      ..connectedSessionId = 'session-1';
    repository.snapshotBuilder = () => RemoteSessionSnapshot(
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
          title: 'Fix the login flow',
          active: true,
          providerType: 'claude',
          model: 'claude-sonnet',
          modelLabel: 'Claude Sonnet 4.5',
          thinkingLevel: 'high',
          pendingQuestions: pendingQuestions,
        ),
      ],
      chatMessages: const [
        RemoteChatMessage(
          messageId: 'm-1',
          chatId: 'chat-1',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Watching CI for you.',
        ),
      ],
    );
    repository.worktreeStateSlices = {
      'wt-1': {'watchers': watcherFixtures()},
    };
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await tester.runAsync(() async {
      await vm.connect('123456');
      if (preloadActivity) {
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
      }
    });
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>(create: (_) => vm),
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
          themeMode: mode,
          home: RemoteChatScreen.worktree(
            worktree: vm.worktreesFor('ws-1').single,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return vm;
  }

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets('the chip counts the chat watchers and opens the sheet '
        '(${mode.name})', (tester) async {
      await pumpChat(tester, mode: mode);

      expect(chip, findsOneWidget);
      expect(
        find.descendant(of: chip, matching: find.text('4')),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Manage chat watchers'), findsOneWidget);
      // Desktop's status-active composer capsule uses one info-tinted
      // surface, with plain 13px count text beside its catalog watcher glyph.
      final info = StatusColors.of(tester.element(chip)).unread;
      final button = tester.widget<TextButton>(
        find.descendant(of: chip, matching: find.byType(TextButton)),
      );
      expect(
        button.style!.backgroundColor?.resolve({}),
        info.withValues(alpha: 0.16),
      );
      expect(button.style!.foregroundColor?.resolve({}), info);
      expect(button.style!.shape?.resolve({}), isA<StadiumBorder>());
      final count = tester.widget<Text>(
        find.descendant(of: chip, matching: find.text('4')),
      );
      expect(count.style!.fontSize, 13);
      expect(count.style!.color, info);
      final eye = tester.widget<CanopyIcon>(
        find.descendant(of: chip, matching: find.byType(CanopyIcon)),
      );
      expect(eye.tint, info);
      expect(eye.glyph, CanopyGlyph.eyeSparkle);
      // It shares the controls row with the model and effort controls.
      final model = tester.getRect(
        find.byKey(const ValueKey('composer-model')),
      );
      expect(tester.getRect(chip).left, greaterThan(model.right));
      expect(
        tester.getRect(chip).right,
        lessThan(
          tester.getRect(find.byKey(const ValueKey('composer-send'))).left,
        ),
      );

      await tester.tap(chip);
      await tester.pumpAndSettle();
      expect(find.text('Chat watchers'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('chat-watcher-watch-pr')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('one watcher is an eye-only capsule; larger counts stay plain', (
    tester,
  ) async {
    for (final count in [1, 101]) {
      var taps = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: Scaffold(
            body: Center(
              child: ChatWatchersChip(count: count, onPressed: () => taps++),
            ),
          ),
        ),
      );
      expect(find.text('$count'), count == 1 ? findsNothing : findsOneWidget);
      expect(find.text('99+'), findsNothing);
      await tester.tap(chip);
      expect(taps, 1);
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets(
    'watcher-only updates change the count, hide and restore the chip',
    (tester) async {
      final repository = FakeRemoteControlRepository();
      await pumpChat(tester, source: repository, preloadActivity: true);
      expect(
        find.descendant(of: chip, matching: find.text('4')),
        findsOneWidget,
      );
      var cursor = 100;
      Future<void> remove(List<String> ids) async {
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.delta',
                'cursor': ++cursor,
                'payload': {
                  'scope': 'worktree',
                  'removed': [
                    for (final id in ids)
                      {
                        'entityType': 'watcher',
                        'localId': id,
                        'parentLocalId': 'ws-1:wt-1',
                      },
                  ],
                },
              },
            ],
            'nextCursor': cursor,
          }),
        );
        await tester.pumpAndSettle();
      }

      await remove(['watch-pr', 'watch-ci']);
      expect(
        find.descendant(of: chip, matching: find.text('2')),
        findsOneWidget,
      );
      await remove(['watch-wakeup', 'watch-failed']);
      expect(chip, findsNothing);
      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.state.delta',
              'cursor': ++cursor,
              'payload': {
                'scope': 'worktree',
                'entities': [
                  for (final row in watcherFixtures().take(2))
                    {
                      'entityType': 'watcher',
                      'localId': row['id'],
                      'parentLocalId': 'ws-1:wt-1',
                      'payload': row,
                    },
                ],
              },
            },
          ],
          'nextCursor': cursor,
        }),
      );
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: chip, matching: find.text('2')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('the chip hides when the desktop lacks chat watchers', (
    tester,
  ) async {
    await pumpChat(tester, supportsWatchers: false);

    expect(chip, findsNothing);
    expect(find.byKey(const ValueKey('composer-model')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the chip hides while a question prompt is open', (tester) async {
    await pumpChat(
      tester,
      pendingQuestions: const [
        AskUserQuestionState(
          requestId: 'req-1',
          questions: [
            AskUserQuestion(id: 'q-1', question: 'Ship it?', options: ['Yes']),
          ],
        ),
      ],
    );

    expect(find.byKey(const ValueKey('question-req-1')), findsOneWidget);
    expect(chip, findsNothing);
    expect(tester.takeException(), isNull);
  });
}
