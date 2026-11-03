import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_watcher_commands.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/chat_watchers_sheet.dart';

import '../../../../../support/fake_remote_control_repository.dart';

void main() {
  const worktree = RemoteWorktree(
    localId: 'wt-1',
    workspaceLocalId: 'ws-1',
    branch: 'main',
  );

  void usePhoneViewport(WidgetTester tester) {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }

  Future<(RemoteControlViewModel, FakeRemoteControlRepository)> connected(
    WidgetTester tester, {
    List<Map<String, dynamic>>? watchers,
  }) async {
    final repository = FakeRemoteControlRepository()
      ..supportsWatchers = true
      ..connectedSessionId = 'session-1';
    repository.snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [],
      worktrees: [worktree],
      standaloneChats: [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Fix the login flow',
        ),
      ],
    );
    repository.worktreeStateSlices = {
      'wt-1': {'watchers': watchers ?? watcherFixtures()},
    };
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await tester.runAsync(() async {
      await vm.connect('123456');
      await vm.refreshWorktreeActivity(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
    });
    return (vm, repository);
  }

  Future<void> pumpSheet(
    WidgetTester tester,
    RemoteControlViewModel vm, {
    ThemeMode mode = ThemeMode.light,
  }) async {
    usePhoneViewport(tester);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        home: Scaffold(
          body: ChatWatchersSheet(
            viewModel: vm,
            worktree: worktree,
            chatId: 'chat-1',
            clock: () => DateTime.utc(2026, 10, 27, 14),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Finder inCard(String id, Finder matching) => find.descendant(
    of: find.byKey(ValueKey('chat-watcher-$id')),
    matching: matching,
  );

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    testWidgets('renders every fixture kind at phone width (${mode.name})', (
      tester,
    ) async {
      final (vm, _) = await connected(tester);
      addTearDown(vm.dispose);
      await pumpSheet(tester, vm, mode: mode);

      expect(find.text('Chat watchers'), findsOneWidget);
      for (final id in ['watch-pr', 'watch-ci', 'watch-wakeup']) {
        expect(find.byKey(ValueKey('chat-watcher-$id')), findsOneWidget);
      }
      expect(
        inCard('watch-pr', find.text('Pull request #42 · Demo watcher')),
        findsOneWidget,
      );
      expect(
        inCard('watch-pr', find.text('Fix the login flow')),
        findsOneWidget,
      );
      expect(inCard('watch-pr', find.text('2h ago')), findsOneWidget);
      expect(inCard('watch-pr', find.text('Branch: main')), findsOneWidget);
      expect(inCard('watch-pr', find.text('+1 more')), findsOneWidget);
      expect(
        inCard('watch-ci', find.text('CI reviewer · Delegate chat')),
        findsOneWidget,
      );
      expect(inCard('watch-wakeup', find.text('Delegate')), findsNothing);
      expect(
        inCard(
          'watch-wakeup',
          find.byKey(const ValueKey('chat-watcher-github-watch-wakeup')),
        ),
        findsNothing,
      );

      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('chat-watcher-watch-failed')),
        200,
      );
      expect(
        inCard('watch-failed', find.text('Delivery failed')),
        findsOneWidget,
      );
      expect(
        inCard(
          'watch-failed',
          find.text('The watcher notification could not be delivered.'),
        ),
        findsOneWidget,
      );
      expect(
        inCard(
          'watch-failed',
          find.text(
            'Follow-up Report the result in this chat.',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('shows the empty state', (tester) async {
    final (vm, _) = await connected(tester, watchers: const []);
    addTearDown(vm.dispose);
    await pumpSheet(tester, vm);

    expect(
      find.text(
        'No active watchers for this chat. Ask the agent to watch a build or pull request.',
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('long titles wrap instead of truncating', (tester) async {
    final long = 'Watch ${List.filled(20, 'the release branch').join(' ')}';
    final row = watcherJson(id: 'watch-long');
    final (vm, _) = await connected(
      tester,
      watchers: [
        {
          ...row,
          'display': {
            ...(row['display'] as Map<String, dynamic>),
            'title': long,
          },
        },
      ],
    );
    addTearDown(vm.dispose);
    await pumpSheet(tester, vm);

    final title = find.text(long);
    expect(title, findsOneWidget);
    expect(tester.getSize(title).height, greaterThan(60));
    expect(tester.getSize(title).width, lessThanOrEqualTo(390));
    expect(tester.takeException(), isNull);
  });

  testWidgets('delete confirms, stays pending, and leaves with the delta', (
    tester,
  ) async {
    final (vm, repository) = await connected(
      tester,
      watchers: [watcherJson(id: 'watch-pr')],
    );
    addTearDown(vm.dispose);
    await pumpSheet(tester, vm);

    await tester.tap(
      find.byKey(const ValueKey('chat-watcher-delete-watch-pr')),
    );
    await tester.pump();
    expect(find.text('Notify subscribing chat'), findsOneWidget);
    expect(
      find.text(
        'Sends a final watcher-deleted message to the chat that subscribed '
        'to this watcher.',
      ),
      findsOneWidget,
    );

    // Cancel closes the confirm without sending.
    await tester.tap(
      find.byKey(const ValueKey('chat-watcher-cancel-watch-pr')),
    );
    await tester.pump();
    expect(find.text('Notify subscribing chat'), findsNothing);

    await tester.tap(
      find.byKey(const ValueKey('chat-watcher-delete-watch-pr')),
    );
    await tester.pump();
    await tester.tap(
      find.byKey(const ValueKey('chat-watcher-notify-watch-pr')),
    );
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(
        find.byKey(const ValueKey('chat-watcher-confirm-delete-watch-pr')),
      );
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pump();

    expect(repository.watcherDeletes.single.watcherId, 'watch-pr');
    expect(repository.watcherDeletes.single.notifySubscriber, isTrue);
    expect(find.text('Deleting…'), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-watcher-watch-pr')), findsOneWidget);

    repository.eventsController.add(
      RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'cursor': 300,
            'payload': {
              'scope': 'worktree',
              'removed': [
                {
                  'entityType': 'watcher',
                  'localId': 'watch-pr',
                  'parentLocalId': 'ws-1:wt-1',
                },
              ],
            },
          },
        ],
        'nextCursor': 300,
      }),
    );
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();

    expect(find.byKey(const ValueKey('chat-watcher-watch-pr')), findsNothing);
    expect(
      find.text(
        'No active watchers for this chat. Ask the agent to watch a build or pull request.',
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('a failed delete shows the inline error and keeps the row', (
    tester,
  ) async {
    final (vm, repository) = await connected(
      tester,
      watchers: [watcherJson(id: 'watch-pr')],
    );
    addTearDown(vm.dispose);
    repository.watcherDeleteError = const RemoteWatcherDeleteException(
      RemoteWatcherDeleteFailure.notFoundOrFiring,
      'Watcher not found or currently firing.',
    );
    await pumpSheet(tester, vm, mode: ThemeMode.dark);

    await tester.tap(
      find.byKey(const ValueKey('chat-watcher-delete-watch-pr')),
    );
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(
        find.byKey(const ValueKey('chat-watcher-confirm-delete-watch-pr')),
      );
      await Future<void>.delayed(Duration.zero);
    });
    await tester.pump();

    expect(
      find.byKey(const ValueKey('chat-watcher-error-watch-pr')),
      findsOneWidget,
    );
    expect(find.text('Watcher not found or currently firing.'), findsOneWidget);
    expect(find.text('Confirm delete'), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-watcher-watch-pr')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
