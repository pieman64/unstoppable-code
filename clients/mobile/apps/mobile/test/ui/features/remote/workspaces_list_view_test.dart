import 'dart:async';
import 'package:mobile/services/attachment_cache.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/composer/canopy_composer_action.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/add_project_sheet.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import '../../../support/reduced_motion.dart';
import '../../../support/overview_snapshot_fixture.dart';
import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/fake_remote_control_repository.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/ui/core/chat/chat_draft_store_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import '../../../support/workspace_context_fixture.dart';
import '../../../support/account_organizations_fixture.dart';

class _RecordingAttachmentCache extends AttachmentCache {
  final cleared = <(String, String)>[];
  final tracked = <String, (String, String)>{};

  @override
  Future<void> trackArchiveCommand(
    String commandId,
    String workspaceId,
    String worktreeId, {
    DateTime? createdAt,
  }) async {
    tracked[commandId] = (workspaceId, worktreeId);
  }

  @override
  Future<List<PendingAttachmentArchive>> pendingArchiveCommands() async => [];

  @override
  Future<void> finishArchiveCommand(
    String commandId, {
    required bool succeeded,
  }) async {
    final target = tracked.remove(commandId);
    if (succeeded && target != null) {
      cleared.add(target);
    }
  }

  @override
  Future<void> clear(String workspaceId, String worktreeId) async {
    cleared.add((workspaceId, worktreeId));
  }
}

void main() {
  group('WorkspacesListView phone navigation', () {
    // Fixture worktrees include busy/running rows whose always-on spinners
    // would keep pumpAndSettle from settling.
    useReducedMotion();
    setUpAll(() => SharedPreferences.setMockInitialValues({}));

    void usePhoneViewport(WidgetTester tester) {
      // Phone-width viewport stretched extra tall so every lazily-built list
      // row — including the ones pushed down by the pinned attention block —
      // is laid out and tappable without scrolling.
      tester.view.physicalSize = const Size(1170, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Future<RemoteControlViewModel> connectedViewModel(
      WidgetTester tester,
    ) async {
      final viewModel = RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      return viewModel;
    }

    Widget buildSubject(
      RemoteControlViewModel viewModel, {
      double textScale = 1.0,
      ChatDraftStore? draftStore,
    }) {
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<ChatDraftStoreHolder>(
            create: (_) => ChatDraftStoreHolder(draftStore),
          ),
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
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          // Through the builder, not an outer MediaQuery: MaterialApp installs
          // MediaQuery.fromView and would discard a wrapper above it.
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(textScale)),
            child: child ?? const SizedBox.shrink(),
          ),
          home: const Scaffold(body: WorkspacesListView()),
        ),
      );
    }

    // Pinned attention rows also name their workspace, so a workspace name
    // alone is not unique; match it inside the project header.
    Finder workspaceHeader(String workspaceId, String name) => find.descendant(
      of: find.byKey(ValueKey('workspace-$workspaceId')),
      matching: find.text(name),
    );

    Future<void> flushHydrationWatchdogs(WidgetTester tester) =>
        tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));

    testWidgets('working rows animate their progress indicators', (
      tester,
    ) async {
      // Exercise normal motion, unlike the other navigation fixtures.
      tester.binding.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: false);
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [
            for (var i = 0; i < 30; i++)
              {
                'localId': 'wt-$i',
                'workspaceLocalId': 'ws-1',
                'branch': 'branch-$i',
                'isStreaming': i < 2,
              },
          ],
          'standaloneChats': [
            {
              'localId': 'chat-1',
              'projectLocalId': 'ws-1',
              'title': 'Working chat',
              'hasActiveChat': true,
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pump();
      await tester.tap(find.text('Repository'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));
      expect(find.byKey(const ValueKey('worktree-working')), findsWidgets);
      // Working rows keep their progress indicators animating.
      expect(tester.hasRunningAnimations, isTrue);
      await tester.pumpWidget(const SizedBox.shrink());
      await vm.disconnect();
    });

    testWidgets('large expanded workspaces build rows only near the viewport', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [
            for (var i = 0; i < 150; i++)
              {
                'localId': 'wt-$i',
                'workspaceLocalId': 'ws-1',
                'branch': 'branch-$i',
                'label': 'Tree $i',
                'status': 'idle',
              },
          ],
          'standaloneChats': <Object>[],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      final last = find.byKey(const ValueKey('worktree-ws-1-wt-149'));
      expect(find.byKey(const ValueKey('worktree-ws-1-wt-0')), findsOneWidget);
      expect(last, findsNothing);
      await tester.scrollUntilVisible(last, 800, maxScrolls: 100);
      expect(last, findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Repository'),
        -800,
        maxScrolls: 100,
      );
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('worktree-ws-1-wt-0')), findsNothing);
      expect(repo.requestWorktreeChatSummariesStateCalls, 1);
      await tester.pumpWidget(const SizedBox.shrink());
      await vm.disconnect();
    });

    testWidgets('many workspaces remain reachable through lazy headers', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            for (var i = 0; i < 100; i++)
              {'localId': 'ws-$i', 'name': 'Project $i', 'type': 'single-repo'},
          ],
          'worktrees': <Object>[],
          'standaloneChats': <Object>[],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      expect(find.text('Project 0'), findsOneWidget);
      expect(find.text('Project 99'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Project 99'),
        800,
        maxScrolls: 100,
      );
      expect(find.byKey(const ValueKey('create-task-ws-99')), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    for (final unmatched in [false, true]) {
      testWidgets('standalone chats are lazy (unmatched: $unmatched)', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': unmatched ? <Object>[] : [overviewWorkspace()],
            'worktrees': <Object>[],
            'standaloneChats': [
              for (var i = 0; i < 150; i++)
                {
                  'localId': 'chat-$i',
                  'projectLocalId': 'ws-1',
                  'title': 'Chat $i',
                },
            ],
          });
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(vm.dispose);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.pumpAndSettle();
        if (!unmatched) {
          await tester.tap(find.text('Repository'));
          await tester.pumpAndSettle();
        }
        expect(find.text('Chat 0'), findsOneWidget);
        expect(find.text('Chat 149'), findsNothing);
        await tester.scrollUntilVisible(
          find.text('Chat 149'),
          800,
          maxScrolls: 100,
        );
        expect(find.text('Chat 149'), findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }

    for (final unreadSibling in [false, true]) {
      testWidgets(
        'returning from a read chat preserves only unread siblings ($unreadSibling)',
        (tester) async {
          usePhoneViewport(tester);
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = () => RemoteSessionSnapshot(
              workspaces: [RemoteWorkspace.fromJson(overviewWorkspace())],
              worktrees: [
                RemoteWorktree.fromJson({
                  ...overviewWorktree(),
                  'hasUnread': true,
                }),
              ],
              standaloneChats: const [],
              chatSummaries: [
                const RemoteChatSummary(
                  chatId: 'chat-1',
                  scope: RemoteChatScope.worktree,
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                  title: 'Chat',
                  active: true,
                  hasUnread: true,
                  lastMessageAt: '1',
                ),
                if (unreadSibling)
                  const RemoteChatSummary(
                    chatId: 'chat-2',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Sibling',
                    hasUnread: true,
                  ),
              ],
              chatMessages: const [
                RemoteChatMessage(
                  messageId: 'reply',
                  chatId: 'chat-1',
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Completed reply',
                ),
              ],
            );
          final vm = RemoteControlViewModel(repository: repo);
          addTearDown(() {
            if (!vm.isDisposed) vm.dispose();
          });
          addTearDown(repo.eventsController.close);
          await vm.connect('123456');
          await tester.pumpWidget(buildSubject(vm));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Repository'));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('worktree-ws-1-wt-1')));
          await tester.pumpAndSettle();
          expect(find.text('Completed reply'), findsOneWidget);
          expect(repo.markReadCalls.single.lastMessageId, 'reply');
          await tester.pageBack();
          await tester.pumpAndSettle();
          expect(vm.allWorktrees.single.hasUnread, unreadSibling);
          expect(
            find.byTooltip('Unread'),
            unreadSibling ? findsWidgets : findsNothing,
          );
          expect(
            find.byKey(const ValueKey('attention-sections')),
            unreadSibling ? findsOneWidget : findsNothing,
          );
          await tester.pumpWidget(const SizedBox.shrink());
          vm.dispose();
          await flushHydrationWatchdogs(tester);
        },
      );
    }

    testWidgets('fresh summary activity reaches unopened worktree rows', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(() {
        if (!vm.isDisposed) vm.dispose();
      });
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(milliseconds: 400));
      expect(repo.requestWorktreeChatSummariesStateCalls, 1);
      final reads = repo.snapshotFetches;
      void publishSummary({required bool running, required bool unread}) {
        repo.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree_chat_summaries',
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Working',
                    turnActive: running,
                    hasUnread: unread,
                  ),
                ],
              ),
            ],
            nextCursor: 2,
          ),
        );
      }

      publishSummary(running: true, unread: false);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('worktree-working')), findsOneWidget);
      publishSummary(running: false, unread: true);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('worktree-working')), findsNothing);
      expect(find.byTooltip('Unread'), findsWidgets);
      expect(repo.snapshotFetches, reads);
      expect(repo.requestWorktreeStateCalls, 0);
      expect(repo.requestChatTranscriptCalls, 0);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    testWidgets('live worktree progress applies before the cache refresh', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = initialOverview;
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: const Duration(seconds: 5),
      );
      addTearDown(() {
        if (!vm.isDisposed) vm.dispose();
      });
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      final reads = repo.snapshotFetches;
      repo.eventsController.add(
        overviewBatch(
          type: 'portal.state.delta',
          scope: 'worktree',
          entities: [
            {
              'entityType': 'worktree',
              'localId': 'wt-1',
              'parentLocalId': 'ws-1',
              'payload': {
                ...overviewWorktree(includeLocalId: false),
                'isStreaming': true,
              },
            },
          ],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('worktree-working')), findsOneWidget);
      expect(repo.snapshotFetches, reads);
      expect(repo.requestWorktreeStateCalls, 0);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
      await tester.pump(const Duration(seconds: 6));
    });

    testWidgets('standalone chat updates and removals apply without a read '
        '(CAN-4874)', (tester) async {
      usePhoneViewport(tester);
      Map<String, dynamic> chat(String localId, String title) => {
        'localId': localId,
        'projectLocalId': 'ws-cowork',
        'title': title,
      };
      // Every read answers the state from before the deltas, so a row only
      // changes when the client applies the delta itself.
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [overviewWorktree()],
          'standaloneChats': [
            chat('sc-1', 'Plan launch'),
            chat('sc-2', 'Write notes'),
          ],
        });
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: const Duration(milliseconds: 10),
      );
      addTearDown(() {
        if (!vm.isDisposed) vm.dispose();
      });
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      expect(find.text('Plan launch'), findsOneWidget);
      expect(find.text('Write notes'), findsOneWidget);
      final reads = repo.snapshotFetches;
      repo.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.state.delta',
              'eventId': 'ev-120',
              'cursor': 120,
              'payload': {
                'scope': 'standalone_chat',
                'entities': [
                  {
                    'entityType': 'standalone_chat',
                    'localId': 'sc-1',
                    'parentLocalId': 'ws-cowork',
                    'payload': {
                      ...chat('sc-1', 'Plan launch, revised'),
                      'hasActiveChat': true,
                    },
                  },
                ],
              },
            },
            {
              'type': 'portal.state.delta',
              'eventId': 'ev-121',
              'cursor': 121,
              'payload': {
                'scope': 'standalone_chat',
                'removed': [
                  {
                    'entityType': 'standalone_chat',
                    'localId': 'sc-2',
                    'parentLocalId': 'ws-cowork',
                  },
                ],
              },
            },
          ],
          'nextCursor': 121,
        }),
      );
      await tester.pump();
      // Past the delta refresh interval, when a fallback read would land.
      await tester.pump(const Duration(seconds: 31));
      await tester.pumpAndSettle();
      expect(find.text('Plan launch, revised'), findsOneWidget);
      expect(find.text('Plan launch'), findsNothing);
      expect(find.text('Write notes'), findsNothing);
      expect(repo.snapshotFetches, reads);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    // Merely-working worktrees are no longer pinned above the navigator — an
    // agent that is running needs nothing from the user, and the row still
    // carries its status indicators inside its project. The hazard is the
    // gate: `AttentionSectionsData.isEmpty` still counts the working lists, so
    // rendering on it would leave an empty block plus its trailing spacer
    // above `Projects` for exactly these worktrees.
    testWidgets('pins nothing — not even a gap — for a working worktree', (
      tester,
    ) async {
      usePhoneViewport(tester);

      Future<double> projectsLabelTop({required bool streaming}) async {
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [overviewWorkspace()],
            'worktrees': [
              {...overviewWorktree(), if (streaming) 'isStreaming': true},
            ],
          });
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(vm.dispose);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.pumpAndSettle();
        return tester.getRect(find.text('Projects')).top;
      }

      final quietTop = await projectsLabelTop(streaming: false);
      final workingTop = await projectsLabelTop(streaming: true);

      expect(find.byKey(const ValueKey('attention-sections')), findsNothing);
      // Identical, not merely close: a working worktree must not shift the
      // list by an empty block's trailing spacer.
      expect(workingTop, quietTop);
      await flushHydrationWatchdogs(tester);
    });

    // Only the unread (attention-bearing) variant survives: the streaming
    // variant used to reach its row through the pinned IN PROGRESS group,
    // which no longer exists.
    testWidgets(
      'long presses the unread worktree before expanding its project',
      (tester) async {
        const signal = 'hasUnread';
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [overviewWorkspace()],
            'worktrees': [
              {...overviewWorktree(), signal: true},
            ],
          });
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(vm.dispose);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.pumpAndSettle();
        await tester.longPress(
          find.byKey(const ValueKey('attention-row-ws-1-wt-1')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('archive-worktree-wt-1')),
          findsOneWidget,
        );
        expect(repo.archiveCalls, isEmpty);
        await tester.tap(find.byKey(const ValueKey('archive-worktree-wt-1')));
        await tester.pumpAndSettle();
        expect(find.text('Archive worktree?'), findsOneWidget);
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(repo.archiveCalls, isEmpty);
      },
    );

    // The pinned attention row is the standard worktree row, so its pending
    // line sits on the same title column as the project list's rows.
    testWidgets('pending archive line sits under the attention row title', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
          'worktrees': [
            {...overviewWorktree(), 'hasUnread': true},
          ],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('attention-row-ws-1-wt-1'));
      await tester.longPress(row);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('archive-worktree-wt-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Archive').last);
      await tester.pumpAndSettle();

      expect(find.text('Archiving…'), findsOneWidget);
      final title = find.descendant(of: row, matching: find.text('koala'));
      expect(
        tester.getTopLeft(find.text('Archiving…')).dx,
        tester.getTopLeft(title).dx,
      );
    });

    // CAN-3612. Every title in the list starts on one column: the project
    // name sets it, and worktree titles, chat titles, and the empty line
    // follow it instead of each restating its own inset.
    testWidgets('project, worktree, chat, and empty titles share one column', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            overviewWorkspace(),
            {'localId': 'ws-chat', 'name': 'Default', 'type': 'cowork'},
            {
              'localId': 'ws-empty',
              'name': 'Empty repo',
              'type': 'single-repo',
            },
          ],
          'worktrees': [overviewWorktree()],
          'standaloneChats': [
            {
              'localId': 'chat',
              'projectLocalId': 'ws-chat',
              'title': 'Expanded chat',
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      for (final name in ['Repository', 'Default', 'Empty repo']) {
        await tester.tap(find.text(name));
        await tester.pumpAndSettle();
      }

      double left(String text) => tester.getTopLeft(find.text(text)).dx;
      final column = left('Repository');
      expect(left('Default'), column);
      expect(left('koala'), column, reason: 'worktree title');
      expect(left('Expanded chat'), column, reason: 'chat title');
      expect(left('No worktrees'), column, reason: 'empty line');
    });

    testWidgets(
      'long press opens archive menu, cancellation keeps row, and completion removes it',
      (tester) async {
        usePhoneViewport(tester);
        var snapshot = initialOverview();
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => snapshot;
        final cache = _RecordingAttachmentCache();
        final vm = RemoteControlViewModel(
          repository: repo,
          attachmentCache: cache,
        );
        addTearDown(vm.dispose);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.tap(find.text('Repository'));
        await tester.pumpAndSettle();
        Future<void> reveal() async {
          await tester.longPress(
            find.byKey(const ValueKey('worktree-ws-1-wt-1')),
          );
          await tester.pumpAndSettle();
          expect(repo.archiveCalls, isEmpty);
          await tester.tap(find.byKey(const ValueKey('archive-worktree-wt-1')));
          await tester.pumpAndSettle();
        }

        await tester.drag(
          find.byKey(const ValueKey('worktree-ws-1-wt-1')),
          const Offset(-180, 0),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('archive-worktree-wt-1')),
          findsNothing,
        );
        await reveal();
        await tester.tap(find.text('Cancel'));
        await tester.pumpAndSettle();
        expect(repo.archiveCalls, isEmpty);
        expect(find.text('koala'), findsOneWidget);
        await reveal();
        await tester.tap(find.widgetWithText(FilledButton, 'Archive').last);
        await tester.pumpAndSettle();
        expect(repo.archiveCalls.single, (
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ));
        expect(find.text('Archiving…'), findsOneWidget);
        // The pending line sits under the row's title, on the list's one
        // title column (CAN-3612).
        expect(
          tester.getTopLeft(find.text('Archiving…')).dx,
          tester.getTopLeft(find.text('koala')).dx,
        );
        expect(
          tester.getTopLeft(find.text('Archiving…')).dx,
          tester.getTopLeft(find.text('Repository')).dx,
        );
        expect(cache.cleared, isEmpty);
        expect(find.text('koala'), findsOneWidget);
        await vm.archiveWorktree(snapshot.worktrees.single);
        expect(repo.archiveCalls, hasLength(1));
        snapshot = RemoteSessionSnapshot.fromJson({
          'workspaces': [overviewWorkspace()],
        });
        repo.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.command.completed',
                'payload': {
                  'commandId': 'archive-1',
                  'result': {'success': true},
                },
              },
            ],
            'nextCursor': 1,
          }),
        );
        await tester.pumpAndSettle();
        expect(find.text('koala'), findsNothing);
        expect(cache.cleared, [('ws-1', 'wt-1')]);
        snapshot = initialOverview();
        await vm.refresh();
        await tester.pumpAndSettle();
        expect(vm.isArchivingWorktree(snapshot.worktrees.single), isFalse);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets('archive rejection keeps the row and allows retry', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = initialOverview;
      final cache = _RecordingAttachmentCache();
      final vm = RemoteControlViewModel(
        repository: repo,
        attachmentCache: cache,
      );
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.tap(find.text('Repository'));
      await tester.pumpAndSettle();
      await tester.longPress(find.byKey(const ValueKey('worktree-ws-1-wt-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('archive-worktree-wt-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Archive').last);
      await tester.pumpAndSettle();
      repo.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.command.failed',
              'payload': {
                'commandId': 'archive-1',
                'error': {'message': 'Worktree is locked.'},
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      await tester.pumpAndSettle();
      expect(find.text('koala'), findsOneWidget);
      expect(find.text('Archiving…'), findsNothing);
      expect(find.text('Worktree is locked.'), findsOneWidget);
      expect(cache.cleared, isEmpty);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets(
      'disabled archive gate still opens a menu explaining availability',
      (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..canArchiveWorktrees = false
          ..snapshotBuilder = initialOverview;
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(vm.dispose);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.tap(find.text('Repository'));
        await tester.pumpAndSettle();
        await tester.longPress(
          find.byKey(const ValueKey('worktree-ws-1-wt-1')),
        );
        await tester.pumpAndSettle();
        final option = tester.widget<PopupMenuItem<String>>(
          find.byKey(const ValueKey('archive-worktree-wt-1')),
        );
        expect(option.enabled, isFalse);
        expect(
          find.text('Archiving is unavailable for this connection.'),
          findsOneWidget,
        );
        expect(repo.archiveCalls, isEmpty);
        await flushHydrationWatchdogs(tester);
      },
    );

    test(
      'demo archive reconciles a completion arriving before its submit response',
      () async {
        final repository = MockRemoteControlRepository(latency: Duration.zero);
        final vm = RemoteControlViewModel(
          repository: repository,
          attachmentCache: _RecordingAttachmentCache(),
        );
        addTearDown(vm.dispose);
        await vm.connect('123456');
        final worktree = vm.snapshot!.worktrees.firstWhere(
          vm.canArchiveWorktree,
        );
        final removed = Completer<void>();
        vm.addListener(() {
          if (!removed.isCompleted &&
              !vm.snapshot!.worktrees.any(
                (row) =>
                    row.localId == worktree.localId &&
                    row.workspaceLocalId == worktree.workspaceLocalId,
              )) {
            removed.complete();
          }
        });
        await vm.archiveWorktree(worktree);
        await removed.future.timeout(const Duration(seconds: 2));
        expect(
          vm.snapshot!.worktrees.any(
            (row) =>
                row.localId == worktree.localId &&
                row.workspaceLocalId == worktree.workspaceLocalId,
          ),
          isFalse,
        );
      },
    );

    testWidgets(
      'saved workspace order survives live snapshots and cached refreshes',
      (tester) async {
        usePhoneViewport(tester);
        Map<String, dynamic> workspace(String id, String name, int order) => {
          'localId': id,
          'name': name,
          'type': 'cowork',
          'order': order,
        };
        var rows = [
          workspace('z-default', 'Default', 0),
          workspace('a-canopy', 'canopy', 1),
        ];
        const chat = {
          'localId': 'chat',
          'projectLocalId': 'z-default',
          'title': 'Expanded chat',
        };
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': rows,
            'standaloneChats': [chat],
          });
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.tap(find.text('Default'));
        await tester.pumpAndSettle();
        void expectOrder(String first, String second) {
          expect(
            tester.getTopLeft(find.text(first)).dy,
            lessThan(tester.getTopLeft(find.text(second)).dy),
          );
          expect(find.text('Expanded chat'), findsOneWidget);
        }

        expectOrder('Default', 'canopy');
        for (var cycle = 0; cycle < 3; cycle++) {
          repository.eventsController.add(
            overviewBatch(
              eventId: 'ordering-$cycle',
              entities: [
                for (final row in rows)
                  {
                    'entityType': 'workspace',
                    'localId': row['localId'],
                    'payload': row,
                  },
                // An overview head carries every standalone chat; the
                // server replaces them with it (CAN-4874).
                {
                  'entityType': 'standalone_chat',
                  'localId': 'chat',
                  'parentLocalId': 'z-default',
                  'payload': chat,
                },
              ],
            ),
          );
          await tester.pumpAndSettle();
          expectOrder('Default', 'canopy');
          rows = rows.reversed.toList();
          await vm.refresh();
          await tester.pumpAndSettle();
          expectOrder('Default', 'canopy');
        }
        rows = [
          workspace('z-default', 'Default', 2),
          workspace('a-canopy', 'canopy', 0),
        ];
        await vm.refresh();
        await tester.pumpAndSettle();
        expectOrder('canopy', 'Default');
      },
    );

    testWidgets(
      'saved worktree order survives live snapshots and cached refreshes',
      (tester) async {
        usePhoneViewport(tester);
        final workspace = {
          'localId': 'ws',
          'name': 'Repository',
          'type': 'single-repo',
        };
        Map<String, dynamic> worktree(String id, String label, num? order) => {
          'localId': id,
          'workspaceLocalId': 'ws',
          'branch': 'feature/$id',
          'label': label,
          'order': ?order,
        };
        var rows = [
          worktree('z-first', 'First task', -1),
          worktree('alpha-tie', 'éclair', null),
          worktree('Beta-tie', '  éclair  ', 0),
          worktree('mixed', 'Beta', null),
          worktree('accent', 'Álpha', 0),
          worktree('c-last', 'Last task', 2),
        ];
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
            'workspaces': [workspace],
            'worktrees': rows,
          });
        final vm = RemoteControlViewModel(repository: repository);
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(buildSubject(vm));
        await tester.tap(find.text('Repository'));
        await tester.pumpAndSettle();
        void expectOrder(List<String> ids) {
          final positions = [
            for (final id in ids) tester.getTopLeft(find.text(id)).dy,
          ];
          expect(positions, orderedEquals([...positions]..sort()));
          expect(vm.worktreesFor('ws').map((w) => w.localId), ids);
          expect(vm.allWorktrees.map((w) => w.localId), ids);
        }

        const expected = [
          'z-first',
          'accent',
          'mixed',
          'alpha-tie',
          'Beta-tie',
          'c-last',
        ];
        expectOrder(expected);
        for (var cycle = 0; cycle < 3; cycle++) {
          rows = rows.reversed.toList();
          repository.eventsController.add(
            overviewBatch(
              eventId: 'worktree-order-$cycle',
              entities: [
                {
                  'entityType': 'workspace',
                  'localId': 'ws',
                  'payload': workspace,
                },
                for (final row in rows)
                  {
                    'entityType': 'worktree',
                    'localId': row['localId'],
                    'parentLocalId': 'ws',
                    'payload': row,
                  },
              ],
            ),
          );
          await tester.pumpAndSettle();
          expectOrder(expected);
          rows = [...rows]
            ..sort(
              (a, b) =>
                  (a['localId'] as String).compareTo(b['localId'] as String),
            );
          await vm.refresh();
          await tester.pumpAndSettle();
          expectOrder(expected);
        }
        rows = [
          for (final row in rows)
            {...row, if (row['localId'] == 'c-last') 'order': -2},
        ];
        await vm.refresh();
        await tester.pumpAndSettle();
        expectOrder(['c-last', ...expected.where((id) => id != 'c-last')]);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets('archive refresh updates the expanded rows and count', (
      tester,
    ) async {
      usePhoneViewport(tester);
      var archived = false;
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'default', 'name': 'Default', 'type': 'cowork'},
          ],
          'standaloneChats': [
            {
              'localId': 'active',
              'projectLocalId': 'default',
              'title': 'ping',
              'description': 'Network connectivity test',
            },
            {
              'localId': 'old',
              'projectLocalId': 'default',
              'title': 'New Chat',
              'archived': archived,
            },
          ],
        });
      final vm = RemoteControlViewModel(repository: repository);
      addTearDown(vm.dispose);
      await vm.connect('123456');
      await tester.pumpWidget(buildSubject(vm));
      await tester.tap(find.text('Default'));
      await tester.pumpAndSettle();
      expect(find.text('2 chats'), findsOneWidget);
      expect(find.text('New Chat'), findsOneWidget);
      archived = true;
      await vm.refresh();
      await tester.pumpAndSettle();
      expect(find.text('1 chat'), findsOneWidget);
      expect(find.text('Network connectivity test'), findsOneWidget);
      expect(find.text('New Chat'), findsNothing);
    });

    testWidgets('pins attention above compact collapsed workspace sections', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      // Attention remains part of the same list instead of becoming a second
      // navigation mode.
      expect(find.text('Attention'), findsNothing);
      expect(find.text('Browse'), findsNothing);
      expect(find.byKey(const ValueKey('attention-sections')), findsOneWidget);
      expect(find.text('Projects'), findsOneWidget);
      expect(find.text('3'), findsWidgets);

      final attentionTop = tester
          .getRect(find.byKey(const ValueKey('attention-sections')))
          .top;
      final workspacesTop = tester.getRect(find.text('Projects')).top;
      expect(attentionTop, lessThan(workspacesTop));

      // Workspace section headers.
      expect(workspaceHeader('ws-app', 'acme-web'), findsOneWidget);
      expect(workspaceHeader('ws-platform', 'platform'), findsOneWidget);
      expect(find.text('Research notes'), findsOneWidget);
      expect(find.text('2 worktrees · 1 chat'), findsOneWidget);
      expect(find.text('3 worktrees'), findsNothing);

      // Sections start collapsed so the first viewport stays navigable.
      expect(find.text('lion'), findsNothing);
      expect(find.text('Refactor the executor module graph'), findsNothing);

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('expanding a workspace reveals its rows', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();
      expect(find.text('lion'), findsNothing);

      await tester.tap(workspaceHeader('ws-app', 'acme-web'));
      await tester.pumpAndSettle();
      expect(find.text('lion'), findsOneWidget);
      expect(
        find.textContaining('wt-feature-auth · PR #1304', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('+117'), findsOneWidget);

      await tester.tap(workspaceHeader('ws-app', 'acme-web'));
      await tester.pumpAndSettle();
      expect(find.text('lion'), findsNothing);

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets(
      'trailing section chevrons stay right-aligned regardless of name length',
      (tester) async {
        usePhoneViewport(tester);
        final viewModel = await connectedViewModel(tester);

        await tester.pumpWidget(buildSubject(viewModel));
        await tester.pumpAndSettle();

        // The expand/collapse chevron must pin to the same right edge on
        // every workspace header row. Regression: the name's Flexible used
        // to share the row's free space 1:1 with a Spacer, so a shorter name
        // left leftover space that pulled the chevron left of longer-named
        // rows (the chevron's x drifted with name length).
        double headerChevronRight(String workspaceName) {
          final header = find
              .ancestor(
                of: find.text(workspaceName),
                matching: find.byType(InkWell),
              )
              .first;
          final expanded = find.descendant(
            of: header,
            matching: find.byIcon(Icons.expand_more),
          );
          final chevron = expanded.evaluate().isNotEmpty
              ? expanded
              : find.descendant(
                  of: header,
                  matching: find.byIcon(Icons.chevron_right),
                );
          expect(chevron, findsOneWidget);
          return tester.getRect(chevron).right;
        }

        final shortNameChevron = headerChevronRight('platform');
        final longNameChevron = headerChevronRight('Research notes');

        expect(
          longNameChevron,
          moreOrLessEquals(shortNameChevron, epsilon: 0.5),
        );

        expect(tester.takeException(), isNull);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets('tapping a worktree row opens its chat screen directly', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(workspaceHeader('ws-app', 'acme-web'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('lion'));
      // Bounded pumps, not pumpAndSettle: the tapped worktree is busy, so
      // the chat screen's animated working bar never settles. The timed pump
      // advances the fake clock so the mock's zero-latency transcript
      // request fires instead of leaking as a pending timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(find.byType(RemoteChatScreen), findsOneWidget);
      // The worktree's hydrated chat tabs are reachable from the chat
      // screen's conversation FAB.
      await tester.openTabsSheet();
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('PKCE implementation'),
        ),
        findsOneWidget,
      );
      await tester.dismissTabsSheet();

      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      viewModel.dispose();
    });

    // CAN-3940: list entry points reopen the tab the user last viewed.
    testWidgets('a worktree row reopens the last viewed chat tab', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();
      await tester.tap(workspaceHeader('ws-app', 'acme-web'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('lion'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));
      expect(find.text('Add PKCE to the mobile OAuth flow'), findsOneWidget);

      await tester.selectTabFromSheet('Widget test cleanup');
      await tester.finishSheetDismiss();
      expect(find.text('Add PKCE to the mobile OAuth flow'), findsNothing);
      Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(RemoteChatScreen), findsNothing);

      await tester.tap(find.text('lion'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(find.text('Add PKCE to the mobile OAuth flow'), findsNothing);

      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      viewModel.dispose();
    });

    testWidgets('an attention row reopens the last viewed chat tab', (
      tester,
    ) async {
      usePhoneViewport(tester);
      RemoteChatSummary tab(String chatId, String title, {bool? active}) =>
          RemoteChatSummary(
            chatId: chatId,
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: title,
            active: active,
          );
      RemoteChatMessage answer(String chatId, String text) => RemoteChatMessage(
        messageId: 'answer-$chatId',
        chatId: chatId,
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: text,
      );
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot(
          workspaces: [RemoteWorkspace.fromJson(overviewWorkspace())],
          worktrees: [
            RemoteWorktree.fromJson({...overviewWorktree(), 'hasUnread': true}),
          ],
          standaloneChats: const [],
          chatSummaries: [
            tab('chat-a', 'Chat A', active: true),
            tab('chat-b', 'Chat B'),
          ],
          chatMessages: [
            answer('chat-a', 'Answer in chat A'),
            answer('chat-b', 'Answer in chat B'),
          ],
        );
      final vm = RemoteControlViewModel(repository: repo);
      await tester.runAsync(() => vm.connect('123456'));
      final row = find.byKey(const ValueKey('attention-row-ws-1-wt-1'));

      await tester.pumpWidget(buildSubject(vm));
      await tester.pump();
      await tester.tap(row);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Answer in chat A'), findsOneWidget);

      await tester.selectTabFromSheet('Chat B');
      await tester.finishSheetDismiss();
      expect(find.text('Answer in chat B'), findsOneWidget);
      Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      await tester.tap(row);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.text('Answer in chat B'), findsOneWidget);
      expect(find.text('Answer in chat A'), findsNothing);

      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      vm.dispose();
    });

    testWidgets('offers a create button on tree and flat workspaces', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      // Tree workspaces create worktrees, while the flat workspace uses the
      // same affordance to mint a standalone chat.
      expect(find.byKey(const ValueKey('create-task-ws-app')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('create-task-ws-platform')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('create-task-ws-notes')),
        findsOneWidget,
      );

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('flat workspace + creates a standalone chat from its draft', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [
          RemoteWorkspace(
            localId: 'ws-notes',
            order: 0,
            name: 'Research notes',
            type: RemoteWorkspaceType.cowork,
          ),
        ],
        worktrees: [],
        standaloneChats: [],
      );
      final viewModel = RemoteControlViewModel(repository: repository);
      addTearDown(viewModel.dispose);
      addTearDown(repository.eventsController.close);
      await viewModel.connect('123456');

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('create-task-ws-notes')));
      await tester.pumpAndSettle();

      // The real chat screen opens directly; nothing is created until the
      // first message.
      expect(repository.createWorktreeCalls, isEmpty);
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      final screenState = tester.state(find.byType(RemoteChatScreen));
      expect(find.text('New chat'), findsOneWidget);
      expect(find.text('Research notes'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('creating-worktree-status')),
        findsNothing,
      );

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Summarize the customer interviews',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pump();

      // The send binds the chat in place: no route swap.
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(tester.state(find.byType(RemoteChatScreen)), same(screenState));
      expect(repository.sendChatMessageCalls, hasLength(1));
      final send = repository.sendChatMessageCalls.single;
      expect(send.text, 'Summarize the customer interviews');
      expect(
        send.target,
        isA<RemoteStandaloneChatTarget>()
            .having(
              (target) => target.projectLocalId,
              'projectLocalId',
              'ws-notes',
            )
            .having((target) => target.chatId, 'chatId', startsWith('cc-')),
      );

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    /// Fixture for the tree-workspace create flow: one existing worktree and
    /// a create whose outcome the test releases through [createResult].
    ({
      FakeRemoteControlRepository repository,
      List<RemoteWorktree> worktrees,
      Completer<RemoteWorktreeCreateResult> createResult,
    })
    treeCreateFixture() {
      final worktrees = [
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-app',
          branch: 'feature/oauth',
        ),
      ];
      final createResult = Completer<RemoteWorktreeCreateResult>();
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [
          RemoteWorkspace(
            localId: 'ws-app',
            order: 0,
            name: 'acme-web',
            type: RemoteWorkspaceType.singleRepo,
          ),
        ],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
      repository.createWorktreeHandler = () => createResult.future;
      return (
        repository: repository,
        worktrees: worktrees,
        createResult: createResult,
      );
    }

    Future<RemoteControlViewModel> createFlowViewModel(
      FakeRemoteControlRepository repository,
    ) async {
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        worktreeCreateRecoveryInterval: Duration.zero,
      );
      addTearDown(viewModel.dispose);
      addTearDown(repository.eventsController.close);
      await viewModel.connect('123456');
      return viewModel;
    }

    VoidCallback? sendAction(WidgetTester tester) => tester
        .widget<CanopyComposerAction>(
          find.byKey(const ValueKey('composer-send')),
        )
        .onPressed;

    testWidgets(
      'workspace + lands in the chat screen while its worktree is created',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = treeCreateFixture();
        final viewModel = await createFlowViewModel(fixture.repository);

        await tester.pumpWidget(buildSubject(viewModel));
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
        await tester.pump();
        await tester.pump();

        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        final createCall = fixture.repository.createWorktreeCalls.single;
        expect(createCall.workspaceLocalId, 'ws-app');
        expect(createCall.existingWorktreeIds, ['wt-1']);
        expect(createCall.baseWorktreeId, isNull);
        expect(createCall.forkOpenTabs, isFalse);

        // The real chat screen is the only route: full chrome from the first
        // frame, with the workspace as the subtitle until the branch exists.
        expect(find.byType(RemoteChatScreen), findsOneWidget);
        final screenState = tester.state(find.byType(RemoteChatScreen));
        expect(find.text('New chat'), findsOneWidget);
        // Scoped to the screen: the list beneath is still on stage while the
        // push transition runs and also names the workspace.
        expect(
          find.descendant(
            of: find.byType(RemoteChatScreen),
            matching: find.text('acme-web'),
          ),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('new-task-workspace')), findsNothing);
        expect(find.byKey(const ValueKey('chat-composer')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('creating-worktree-status')),
          findsOneWidget,
        );
        expect(find.text('Creating worktree…'), findsOneWidget);
        expect(find.byKey(const ValueKey('open-activity')), findsNothing);

        // Drafting is allowed straight away; only sending waits.
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login redirect',
        );
        await tester.pump();
        expect(sendAction(tester), isNull);
        final micButton = tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(const ValueKey('composer-mic')),
            matching: find.byType(IconButton),
          ),
        );
        expect(micButton.onPressed, isNotNull);

        // The desktop acknowledges the reservation while its background git
        // setup is still running: the row lands git-pending.
        fixture.worktrees.add(
          const RemoteWorktree(
            localId: 'wt-2',
            workspaceLocalId: 'ws-app',
            branch: 'canopy/otter',
            setupPhase: RemoteWorktreeSetupPhase.gitPending,
          ),
        );
        fixture.createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-2',
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Setting up worktree…'), findsOneWidget);
        expect(sendAction(tester), isNull);

        // Git setup finishes; the worktree binds in place.
        fixture.worktrees[1] = const RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'canopy/otter',
          setupPhase: RemoteWorktreeSetupPhase.idle,
        );
        await tester.pumpAndSettle();

        expect(find.byType(RemoteChatScreen), findsOneWidget);
        expect(tester.state(find.byType(RemoteChatScreen)), same(screenState));
        expect(
          find.byKey(const ValueKey('creating-worktree-status')),
          findsNothing,
        );
        expect(find.text('New chat'), findsOneWidget);
        expect(find.text('canopy/otter'), findsOneWidget);
        expect(find.byKey(const ValueKey('open-activity')), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller
              ?.text,
          'Fix the login redirect',
        );
        expect(sendAction(tester), isNotNull);

        expect(tester.takeException(), isNull);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets(
      "a created worktree's unsent draft stays out of the next new chat",
      (tester) async {
        usePhoneViewport(tester);
        final fixture = treeCreateFixture();
        final viewModel = await createFlowViewModel(fixture.repository);
        final store = InMemoryChatDraftStore();

        await tester.pumpWidget(buildSubject(viewModel, draftStore: store));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
        await tester.pump();
        await tester.pump();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login redirect',
        );
        await tester.pump();

        fixture.worktrees.add(
          const RemoteWorktree(
            localId: 'wt-2',
            workspaceLocalId: 'ws-app',
            branch: 'canopy/otter',
          ),
        );
        fixture.createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-2',
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('canopy/otter'), findsOneWidget);

        // Leave the new worktree without sending.
        await tester.pageBack();
        await tester.pumpAndSettle();
        expect(store.draftFor(const RemoteNewChatDraftTarget('ws-app')), '');
        expect(
          store.draftFor(
            const RemoteWorktreeChatDraftTarget(
              workspaceLocalId: 'ws-app',
              worktreeLocalId: 'wt-2',
            ),
          ),
          'Fix the login redirect',
        );

        // The next fresh worktree starts with an empty composer.
        final nextCreate = Completer<RemoteWorktreeCreateResult>();
        fixture.repository.createWorktreeHandler = () => nextCreate.future;
        await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
        await tester.pump();
        await tester.pump();
        expect(find.text('Creating worktree…'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller
              ?.text,
          isEmpty,
        );

        fixture.worktrees.add(
          const RemoteWorktree(
            localId: 'wt-3',
            workspaceLocalId: 'ws-app',
            branch: 'canopy/heron',
          ),
        );
        nextCreate.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create-2',
            worktreeLocalId: 'wt-3',
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets(
      'CAN-3643 background/resume during a create keeps the screen and draft',
      (tester) async {
        usePhoneViewport(tester);
        final fixture = treeCreateFixture();
        var heartbeat = 0;
        fixture.repository
          ..connectedSessionId = 'session-1'
          ..sessionMetadataBuilder = () => RemoteConnection(
            deviceLabel: 'Test Desktop',
            pairedAt: DateTime(2026),
            sessionId: 'session-1',
            lastSeenAt: DateTime.utc(2026, 10, 5, 12, 0, ++heartbeat),
          );
        final viewModel = await createFlowViewModel(fixture.repository);
        final generation = viewModel.sessionGeneration;

        await tester.pumpWidget(buildSubject(viewModel));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
        await tester.pump();
        await tester.pump();
        expect(fixture.repository.createWorktreeCalls, hasLength(1));
        final screenState = tester.state(find.byType(RemoteChatScreen));
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Fix the login redirect',
        );
        await tester.pump();
        expect(sendAction(tester), isNull);

        // Home, then back: the foreground re-reads the pairing's heartbeat
        // and capabilities, which replaces the connection metadata object.
        final connection = viewModel.connection;
        viewModel.onAppBackgrounded();
        await tester.pump();
        await viewModel.onAppForegrounded();
        await tester.pump();
        expect(viewModel.connection, isNot(same(connection)));
        expect(viewModel.sessionGeneration, generation);

        fixture.worktrees.add(
          const RemoteWorktree(
            localId: 'wt-2',
            workspaceLocalId: 'ws-app',
            branch: 'canopy/otter',
            setupPhase: RemoteWorktreeSetupPhase.gitPending,
          ),
        );
        fixture.createResult.complete(
          const RemoteWorktreeCreateResult(
            commandId: 'cmd-create',
            worktreeLocalId: 'wt-2',
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.textContaining('session changed'), findsNothing);
        expect(find.text('Setting up worktree…'), findsOneWidget);
        expect(tester.state(find.byType(RemoteChatScreen)), same(screenState));
        expect(sendAction(tester), isNull);

        fixture.worktrees[1] = const RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'canopy/otter',
          setupPhase: RemoteWorktreeSetupPhase.idle,
        );
        await tester.pumpAndSettle();

        expect(tester.state(find.byType(RemoteChatScreen)), same(screenState));
        expect(find.textContaining('session changed'), findsNothing);
        expect(find.text('canopy/otter'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller
              ?.text,
          'Fix the login redirect',
        );
        expect(sendAction(tester), isNotNull);
        expect(fixture.repository.createWorktreeCalls, hasLength(1));

        expect(tester.takeException(), isNull);
        await flushHydrationWatchdogs(tester);
      },
    );

    testWidgets('leaving the chat screen mid-create keeps the create running', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final fixture = treeCreateFixture();
      final viewModel = await createFlowViewModel(fixture.repository);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
      await tester.pump();
      await tester.pump();
      expect(find.byType(RemoteChatScreen), findsOneWidget);

      // The create is owned by the view model, so the screen does not trap
      // the user behind a "wait" notice.
      await tester.pageBack();
      await tester.pumpAndSettle();

      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(find.byType(SnackBar), findsNothing);
      expect(viewModel.isCreatingWorktree, isTrue);
      final createTask = tester.widget<IconButton>(
        find.byKey(const ValueKey('create-task-ws-app')),
      );
      expect(createTask.onPressed, isNull);

      fixture.worktrees.add(
        const RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'canopy/otter',
        ),
      );
      fixture.createResult.complete(
        const RemoteWorktreeCreateResult(
          commandId: 'cmd-create',
          worktreeLocalId: 'wt-2',
        ),
      );
      await tester.pumpAndSettle();

      expect(viewModel.isCreatingWorktree, isFalse);
      expect(
        viewModel.worktreesFor('ws-app').map((worktree) => worktree.localId),
        contains('wt-2'),
      );

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('pending tree create leaves flat workspace new chat enabled', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final createResult = Completer<RemoteWorktreeCreateResult>();
      final worktrees = [
        const RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-app',
          branch: 'feature/oauth',
        ),
      ];
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: const [
          RemoteWorkspace(
            localId: 'ws-app',
            order: 0,
            name: 'acme-web',
            type: RemoteWorkspaceType.singleRepo,
          ),
          RemoteWorkspace(
            localId: 'ws-notes',
            order: 1,
            name: 'Research notes',
            type: RemoteWorkspaceType.cowork,
          ),
        ],
        worktrees: List.of(worktrees),
        standaloneChats: const [],
      );
      repository.createWorktreeHandler = () => createResult.future;
      final viewModel = await createFlowViewModel(repository);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
      await tester.pump();
      await tester.pump();
      await tester.pageBack();
      await tester.pumpAndSettle();

      final treeCreate = tester.widget<IconButton>(
        find.byKey(const ValueKey('create-task-ws-app')),
      );
      final flatCreate = tester.widget<IconButton>(
        find.byKey(const ValueKey('create-task-ws-notes')),
      );
      expect(treeCreate.onPressed, isNull);
      expect(flatCreate.onPressed, isNotNull);

      worktrees.add(
        const RemoteWorktree(
          localId: 'wt-2',
          workspaceLocalId: 'ws-app',
          branch: 'canopy/otter',
        ),
      );
      createResult.complete(
        const RemoteWorktreeCreateResult(
          commandId: 'cmd-create',
          worktreeLocalId: 'wt-2',
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('uses canonical fallback copy when worktree creation fails', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            RemoteWorkspace(
              localId: 'ws-app',
              order: 0,
              name: 'acme-web',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [],
          standaloneChats: [],
        );
      repository.createWorktreeHandler = () => throw StateError('unexpected');
      final viewModel = RemoteControlViewModel(repository: repository);
      addTearDown(viewModel.dispose);
      addTearDown(repository.eventsController.close);
      await viewModel.connect('123456');

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('create-task-ws-app')));
      await tester.pumpAndSettle();

      // The failure renders inside the chat screen, in place of the
      // progress row, so the draft and chrome stay put.
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(
        find.text("Couldn't create the worktree. Please try again."),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('creating-worktree-status')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('retry-worktree-create')),
        findsOneWidget,
      );
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is CanopyIcon &&
              widget.glyph == CanopyGlyph.warningSign &&
              widget.size == 32,
        ),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Fix the login redirect',
      );
      await tester.pump();
      expect(sendAction(tester), isNull);

      await tester.tap(find.byKey(const ValueKey('retry-worktree-create')));
      await tester.pumpAndSettle();

      expect(repository.createWorktreeCalls, hasLength(2));
      expect(
        find.byKey(const ValueKey('retry-worktree-create')),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
            .controller
            ?.text,
        'Fix the login redirect',
      );

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('shows one deduplicated attention list above workspaces', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      expect(find.text('NEEDS ATTENTION'), findsOneWidget);
      expect(find.text('Projects'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('attention-row-ws-app-wt-bugfix')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('attention-row-ws-platform-wt-migrate')),
        findsOneWidget,
      );
      // `wt-ci` carries only a running pipeline. It is working, not asking,
      // so it is no longer pinned — it is reached through its project.
      expect(
        find.byKey(const ValueKey('attention-row-ws-platform-wt-ci')),
        findsNothing,
      );
      // Attention rows are label-first; the metadata line names the
      // workspace, because the queue spans projects.
      expect(find.text('krill'), findsOneWidget);
      expect(find.text('okapi'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('attention-row-ws-app-wt-bugfix')),
          matching: find.text('acme-web'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(
            const ValueKey('attention-row-ws-platform-wt-migrate'),
          ),
          matching: find.textContaining('platform · PR merged'),
        ),
        findsOneWidget,
      );

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    // CAN-4434: a pinned row is the project list's row. Only the metadata
    // line differs: it names the workspace in place of the worktree id.
    testWidgets('pinned rows match their project-list rows', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();
      await tester.tap(workspaceHeader('ws-app', 'acme-web'));
      await tester.pumpAndSettle();
      await tester.tap(workspaceHeader('ws-platform', 'platform'));
      await tester.pumpAndSettle();

      List<String> rowContent(Finder row) => [
        for (final tooltip in tester.widgetList<Tooltip>(
          find.descendant(of: row, matching: find.byType(Tooltip)),
        ))
          tooltip.message ?? '',
        for (final text in tester.widgetList<Text>(
          find.descendant(of: row, matching: find.byType(Text)),
        ))
          text.data ?? text.textSpan?.toPlainText() ?? '',
      ];

      for (final (workspaceId, workspaceName, worktreeId) in const [
        ('ws-app', 'acme-web', 'wt-bugfix'),
        ('ws-platform', 'platform', 'wt-migrate'),
      ]) {
        final pinned = rowContent(
          find.byKey(ValueKey('attention-row-$workspaceId-$worktreeId')),
        );
        final listed = rowContent(
          find.byKey(ValueKey('worktree-$workspaceId-$worktreeId')),
        );
        expect(listed, contains(startsWith(worktreeId)));
        expect(pinned, contains(startsWith(workspaceName)));
        expect(pinned, [
          for (final content in listed)
            content.startsWith(worktreeId)
                ? content.replaceFirst(worktreeId, workspaceName)
                : content,
        ]);
      }

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });

    testWidgets('tapping an attention row opens the worktree chat screen', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(buildSubject(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('attention-row-ws-app-wt-bugfix')),
      );
      // Bounded pumps, mirroring the main-list tap test: the pushed chat
      // screen's animations may not settle and the mock's zero-latency
      // transcript request needs a timed pump to fire.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(find.byType(RemoteChatScreen), findsOneWidget);

      expect(tester.takeException(), isNull);
      await flushHydrationWatchdogs(tester);
    });
  });

  group('Add project (CAN-3988)', () {
    useReducedMotion();
    setUpAll(() => SharedPreferences.setMockInitialValues({}));

    const project = RemoteWorkspace(
      localId: 'ws-web',
      order: 0,
      name: 'acme-web',
      type: RemoteWorkspaceType.singleRepo,
    );

    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Future<RemoteControlViewModel> connect(
      FakeRemoteControlRepository repository, {
      List<RemoteWorkspace> workspaces = const [],
    }) async {
      repository.snapshotBuilder = () => RemoteSessionSnapshot(
        workspaces: workspaces,
        worktrees: const [],
        standaloneChats: const [],
      );
      final viewModel = RemoteControlViewModel(repository: repository);
      await viewModel.connect('123456');
      return viewModel;
    }

    Widget host(
      RemoteControlViewModel viewModel, {
      ThemeMode themeMode = ThemeMode.light,
    }) => ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: viewModel,
      child: MaterialApp(
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: const Scaffold(body: WorkspacesListView()),
      ),
    );

    for (final themeMode in [ThemeMode.light, ThemeMode.dark]) {
      testWidgets('the empty state opens the Add project sheet '
          '(${themeMode.name})', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        final viewModel = await connect(repository);
        addTearDown(viewModel.dispose);
        await tester.pumpWidget(host(viewModel, themeMode: themeMode));
        await tester.pumpAndSettle();

        expect(find.text('No projects yet'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('add-project-empty')));
        await tester.pumpAndSettle();

        expect(find.byKey(const ValueKey('add-project-sheet')), findsOneWidget);
        expect(find.text('Git repository URL'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('the Projects heading opens the Add project sheet', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      final viewModel = await connect(repository, workspaces: [project]);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      final action = find.byKey(const ValueKey('add-project-header'));
      expect(action, findsOneWidget);
      expect(find.byTooltip('Add project'), findsOneWidget);
      expect(tester.getSize(action).height, greaterThanOrEqualTo(44));
      // The project's own New task action stays distinct.
      expect(find.byKey(const ValueKey('create-task-ws-web')), findsOneWidget);
      await tester.tap(action);
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('add-project-sheet')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    final urlField = find.byKey(const ValueKey('add-project-url'));
    final submit = find.byKey(const ValueKey('add-project-submit'));

    /// Opens the sheet from the empty state and submits [url].
    Future<void> submitUrl(WidgetTester tester, String url) async {
      await tester.tap(find.byKey(const ValueKey('add-project-empty')));
      await tester.pumpAndSettle();
      await tester.enterText(urlField, url);
      await tester.tap(submit);
      // Finite pumps: pending rows keep a progress indicator running.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    for (final (input, error) in const [
      ('', 'Enter a git repository URL.'),
      ('github.com/org/repo', kAddProjectInvalidUrlMessage),
      ('file:///Users/me/repo', kAddProjectInvalidUrlMessage),
      ('--upload-pack=x', kAddProjectInvalidUrlMessage),
    ]) {
      testWidgets('rejects "$input" on the phone without sending', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        final viewModel = await connect(repository);
        addTearDown(viewModel.dispose);
        await tester.pumpWidget(host(viewModel));
        await tester.pumpAndSettle();

        await submitUrl(tester, input);

        expect(find.text(error), findsOneWidget);
        expect(find.byKey(const ValueKey('add-project-sheet')), findsOneWidget);
        expect(repository.createProjectCalls, isEmpty);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets(
      'submit stays busy, then the sheet hands off to a pending row',
      (tester) async {
        usePhoneViewport(tester);
        final answer = Completer<RemotePortalCommandResult>();
        final repository = FakeRemoteControlRepository()
          ..createProjectHandler = ((_) => answer.future);
        final viewModel = await connect(repository);
        await tester.pumpWidget(host(viewModel));
        await tester.pumpAndSettle();

        await submitUrl(tester, ' https://github.com/org/repo.git ');
        expect(find.text('Adding…'), findsOneWidget);
        await tester.tap(submit, warnIfMissed: false);
        await tester.pump();
        expect(repository.createProjectCalls, hasLength(1));
        expect(repository.createProjectCalls.single.payload, {
          'kind': 'remote-clone',
          'remoteUrl': 'https://github.com/org/repo.git',
        });

        answer.complete(const RemotePortalCommandResult(commandId: 'cmd-1'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));

        expect(find.byKey(const ValueKey('add-project-sheet')), findsNothing);
        final row = find.byKey(const ValueKey('pending-project-1'));
        expect(row, findsOneWidget);
        expect(
          find.descendant(of: row, matching: find.text('repo')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: row, matching: find.text('Cloning…')),
          findsOneWidget,
        );
        // A clone in progress is not an empty project list.
        expect(find.text('No projects yet'), findsNothing);
        expect(
          find.byKey(const ValueKey('add-project-header')),
          findsOneWidget,
        );
        expect(find.text('Dismiss'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        // Stops the pending row's status reads before the test ends.
        viewModel.dispose();
      },
    );

    testWidgets('the created project replaces its pending row', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      final viewModel = await connect(repository, workspaces: [project]);
      addTearDown(viewModel.dispose);
      repository.createProjectHandler = (_) async {
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [
            project,
            RemoteWorkspace(
              localId: 'ws-new',
              order: 1,
              name: 'repo',
              type: RemoteWorkspaceType.singleRepo,
            ),
          ],
          worktrees: [],
          standaloneChats: [],
        );
        return const RemotePortalCommandResult(
          commandId: 'cmd-1',
          result: {'workspaceId': 'ws-new'},
        );
      };
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('add-project-header')));
      await tester.pumpAndSettle();
      await tester.enterText(urlField, 'git@github.com:org/repo.git');
      await tester.tap(submit);
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('pending-project-1')), findsNothing);
      expect(find.byKey(const ValueKey('workspace-ws-new')), findsOneWidget);
      expect(find.byKey(const ValueKey('workspace-ws-web')), findsOneWidget);
      expect(find.text('repo'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a desktop failure shows its message with Dismiss only', (
      tester,
    ) async {
      usePhoneViewport(tester);
      const failure =
          'Failed to clone the repository. Check the URL and access, then '
          'try again.';
      final repository = FakeRemoteControlRepository()
        ..createProjectHandler = ((_) async => const RemotePortalCommandResult(
          commandId: 'cmd-1',
          error: failure,
        ));
      final viewModel = await connect(repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      await submitUrl(tester, 'https://github.com/org/private.git');
      await tester.pumpAndSettle();

      expect(find.text(failure), findsOneWidget);
      expect(find.text('Retry'), findsNothing);
      final dismiss = find.bySemanticsLabel('Dismiss private');
      expect(dismiss, findsOneWidget);
      expect(
        tester
            .getSize(
              find.ancestor(
                of: find.text('Dismiss'),
                matching: find.byType(CanopyButton),
              ),
            )
            .height,
        greaterThanOrEqualTo(44),
      );
      await tester.tap(find.text('Dismiss'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('pending-project-1')), findsNothing);
      expect(find.text('No projects yet'), findsOneWidget);
      expect(repository.createProjectCalls, hasLength(1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a dropped connection asks the user to check Projects', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..createProjectHandler = ((_) async =>
            throw http.ClientException('Connection closed'));
      final viewModel = await connect(repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      await submitUrl(tester, 'https://github.com/org/repo.git');
      await tester.pumpAndSettle();

      expect(
        find.text(
          "Couldn't confirm that the clone finished. Check Projects before "
          'trying again.',
        ),
        findsOneWidget,
      );
      expect(find.text('Dismiss'), findsOneWidget);
      expect(repository.createProjectCalls, hasLength(1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a clone held for a reconnecting desktop says so', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..createProjectHandler = ((_) async => const RemotePortalCommandResult(
          commandId: 'cmd-1',
          queuedWhileReconnecting: true,
        ));
      final viewModel = await connect(repository);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      await submitUrl(tester, 'https://github.com/org/repo.git');

      expect(
        find.text("Waiting for the desktop… The clone starts when it's back."),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      // Stops the pending row's status reads before the test ends.
      viewModel.dispose();
    });

    testWidgets('long names fit at phone width with large text', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final repository = FakeRemoteControlRepository()
        ..createProjectHandler = ((_) async => const RemotePortalCommandResult(
          commandId: 'cmd-1',
          error: 'Failed to clone the repository.',
        ));
      final viewModel = await connect(repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(
        ChangeNotifierProvider<RemoteControlViewModel>.value(
          value: viewModel,
          child: MaterialApp(
            theme: AppTheme.light,
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: const Scaffold(body: WorkspacesListView()),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await submitUrl(
        tester,
        'https://github.com/org/a-really-long-repository-name-for-phones.git',
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('pending-project-1')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('Back closes the sheet without sending', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      final viewModel = await connect(repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('add-project-empty')));
      await tester.pumpAndSettle();
      await tester.enterText(urlField, 'https://github.com/org/repo.git');
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('add-project-sheet')), findsNothing);
      expect(repository.createProjectCalls, isEmpty);
      expect(find.text('No projects yet'), findsOneWidget);
    });

    testWidgets('the submit action stays above the keyboard', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      final viewModel = await connect(repository);
      addTearDown(viewModel.dispose);
      await tester.pumpWidget(host(viewModel));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('add-project-empty')));
      await tester.pumpAndSettle();

      tester.view.viewInsets = const FakeViewPadding(bottom: 1000);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();

      final visibleBottom = 2532 / 3 - 1000 / 3;
      expect(tester.getRect(submit).bottom, lessThanOrEqualTo(visibleBottom));
      expect(tester.getSize(submit).height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
    });
  });

  group('CAN-4429 workspace context', () {
    useReducedMotion();
    setUpAll(() => SharedPreferences.setMockInitialValues({}));

    Future<(RemoteControlViewModel, AuthViewModel, FakeRemoteControlRepository)>
    pumpScoped(WidgetTester tester, {bool withOwners = true}) async {
      tester.view.physicalSize = const Size(1170, 3600);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(
          () async => workspaceContextOrganizations(),
        ),
      );
      addTearDown(auth.dispose);
      await tester.runAsync(
        () => auth.signIn(email: 'a@b.dev', password: 'password'),
      );
      final repo = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson(
          workspaceContextShellState(withOwners: withOwners),
        );
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(vm.dispose);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AuthViewModel>.value(value: auth),
            workspaceContextProvider(),
            ChangeNotifierProvider<RemoteControlViewModel>.value(value: vm),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            home: const Scaffold(body: WorkspacesListView()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return (vm, auth, repo);
    }

    Finder project(String id) => find.byKey(ValueKey('workspace-$id'));

    testWidgets('CAN-4429 Personal lists only Personal projects and chats', (
      tester,
    ) async {
      await pumpScoped(tester);

      for (final id in workspaceContextPersonalIds) {
        expect(project(id), findsOneWidget);
      }
      for (final id in workspaceContextOrgAIds) {
        expect(project(id), findsNothing);
      }
      // The projectless chat stays; Q's attention row and the chat whose
      // project is missing do not.
      expect(find.text('Loose chat'), findsOneWidget);
      expect(find.text('Personal task'), findsOneWidget);
      expect(find.text('Acme task'), findsNothing);
      expect(find.text('Orphan chat'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('CAN-4429 switching context re-filters without reconnecting', (
      tester,
    ) async {
      final (vm, auth, repo) = await pumpScoped(tester);
      final connection = vm.connection;
      final fetches = repo.snapshotFetches;

      auth.switchOrg(workspaceContextOrgA);
      await tester.pumpAndSettle();

      for (final id in workspaceContextOrgAIds) {
        expect(project(id), findsOneWidget);
      }
      for (final id in workspaceContextPersonalIds) {
        expect(project(id), findsNothing);
      }
      expect(find.text('Acme task'), findsOneWidget);
      expect(find.text('Personal task'), findsNothing);
      expect(find.text('Loose chat'), findsNothing);
      // Adding a project creates a Personal one, so it is not offered here.
      expect(find.byKey(const ValueKey('add-project-header')), findsNothing);

      // Q's standalone chat is listed under Q.
      await tester.tap(
        find.descendant(
          of: project('ws-org-a'),
          matching: find.text('Acme API'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Acme chat'), findsOneWidget);

      auth.switchOrg(workspaceContextOrgB);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('remote-no-organization-projects')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('remote-no-organization-projects')),
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is CanopyIcon && widget.glyph == CanopyGlyph.buildings,
          ),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('add-project-empty')), findsNothing);
      for (final id in [
        ...workspaceContextPersonalIds,
        ...workspaceContextOrgAIds,
      ]) {
        expect(project(id), findsNothing);
      }

      expect(identical(vm.connection, connection), isTrue);
      expect(vm.isConnected, isTrue);
      expect(repo.disconnectCalls, 0);
      expect(repo.snapshotFetches, fetches);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'CAN-4429 a desktop without owners lists everything in Personal only',
      (tester) async {
        final (_, auth, _) = await pumpScoped(tester, withOwners: false);

        for (final id in [
          ...workspaceContextPersonalIds,
          ...workspaceContextOrgAIds,
        ]) {
          expect(project(id), findsOneWidget);
        }

        auth.switchOrg(workspaceContextOrgA);
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('remote-no-organization-projects')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  });
}
