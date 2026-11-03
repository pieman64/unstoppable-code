import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_row.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_controller.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/command_failure_banner.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_archive_row.dart';
import 'package:provider/provider.dart';

import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/ui/core/chat/widgets/chat_feed.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:mobile/ui/features/remote/views/widgets/activity_sidebar.dart';

import '../../../support/chat_tabs_sheet_driver.dart';
import '../../../support/rebuild_counter.dart';
import '../../../support/composer_driver.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/painted_scroll_frames.dart';

final class _GatedCachedTranscriptRepository
    extends FakeRemoteControlRepository {
  final cachedTail = Completer<List<RemoteChatMessage>>();

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) {
    cachedChatFetches++;
    return cachedTail.future;
  }
}

void main() {
  _orphanCompletionTests();
  group('RemoteChatScreen', () {
    void usePhoneViewport(WidgetTester tester) {
      // Narrow phone width so RenderFlex overflow in bubbles/chips surfaces.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    // Connect via [WidgetTester.runAsync]: the mock's `Future.delayed` never
    // resolves under the FakeAsync zone until a pump advances timers, so
    // awaiting connect before the first pump would otherwise hang the test.
    Future<RemoteControlViewModel> connectedViewModel(
      WidgetTester tester,
    ) async {
      final viewModel = RemoteControlViewModel(
        repository: MockRemoteControlRepository(latency: Duration.zero),
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      return viewModel;
    }

    Widget buildSubject(RemoteControlViewModel viewModel, Widget screen) {
      return MultiProvider(
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
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: screen,
        ),
      );
    }

    RemoteWorktree worktreeWithChats(RemoteControlViewModel viewModel) =>
        viewModel
            .worktreesFor('ws-app')
            .firstWhere((w) => w.localId == 'wt-feature-auth');

    for (final failed in [false, true]) {
      testWidgets(
        'legacy host stays working with ${failed ? 'not-sent' : 'pending'} follow-up',
        (tester) async {
          usePhoneViewport(tester);
          final completion = Completer<RemoteChatSendResult>();
          final repo = FakeRemoteControlRepository()
            ..sendChatMessageHandler = (() => completion.future)
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [],
              standaloneChats: [],
              worktrees: [
                RemoteWorktree(
                  localId: 'wt-1',
                  workspaceLocalId: 'ws-1',
                  branch: 'main',
                ),
              ],
              chatSummaries: [
                RemoteChatSummary(
                  chatId: 'chat-a',
                  scope: RemoteChatScope.worktree,
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                  title: 'Chat A',
                  active: true,
                ),
              ],
              chatMessages: [
                RemoteChatMessage(
                  messageId: 'reply',
                  chatId: 'chat-a',
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.streaming,
                  text: 'Checking the code',
                ),
              ],
            );
          final vm = RemoteControlViewModel(repository: repo);
          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              vm,
              RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
            ),
          );
          await tester.pump();
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Check the tests too',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          if (failed) {
            completion.completeError(
              const RemoteChatSendNotSentException('Send failed'),
            );
            await tester.pump();
          }
          expect(repo.sendChatMessageCalls, hasLength(1));
          const target = RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: 'chat-a',
          );
          expect(vm.messagesFor(target).last.text, 'Check the tests too');
          final working = find
              .byKey(const ValueKey('remote-chat-working-indicator'))
              .evaluate()
              .length;
          final stop = find
              .byKey(const ValueKey('composer-stop'))
              .evaluate()
              .length;
          expect(tester.takeException(), isNull);
          if (!failed) {
            completion.completeError(
              const RemoteChatSendNotSentException('Send failed'),
            );
            await tester.pump();
          }
          await tester.pumpWidget(const SizedBox());
          vm.dispose();
          await repo.eventsController.close();
          await tester.pump();
          expect(working, 1);
          expect(stop, 1);
        },
      );
    }

    testWidgets('a connection that has not come back says it is reconnecting', (
      tester,
    ) async {
      // CAN-3557: after the app returns, the transcript on screen is a cache
      // until event delivery comes back; it must not look current.
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()
        ..autoLive = false
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          standaloneChats: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
        );
      final vm = RemoteControlViewModel(repository: repo);
      addTearDown(repo.eventsController.close);
      await vm.connect('123456');
      repo.eventsLiveController.add(true);
      await tester.pumpWidget(
        buildSubject(
          vm,
          RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
        ),
      );
      await tester.pump();
      expect(find.byType(RemoteDegradedBanner), findsNothing);

      vm.onAppBackgrounded();
      unawaited(vm.onAppForegrounded());
      await tester.pump(const Duration(seconds: 3));

      expect(find.text('Reconnecting…'), findsOneWidget);

      repo.eventsLiveController.add(true);
      await tester.pump();

      expect(find.byType(RemoteDegradedBanner), findsNothing);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
    });

    for (final (away, reloads) in [
      (const Duration(minutes: 2), true),
      (const Duration(seconds: 30), false),
    ]) {
      testWidgets(
        'an open chat ${reloads ? 'reloads' : 'keeps'} its transcript after '
        '${away.inSeconds}s in the background',
        (tester) async {
          // A long absence skips the missed backlog rather than replaying it
          // onto the screen, so the open chat reads its transcript again.
          usePhoneViewport(tester);
          var now = DateTime(2026, 10, 23, 12);
          final repo = FakeRemoteControlRepository()
            ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
              'workspaces': [],
              'worktrees': [
                {
                  'localId': 'wt-1',
                  'workspaceLocalId': 'ws-1',
                  'branch': 'main',
                },
              ],
              'standaloneChats': [],
              'chatSummaries': [
                {
                  'chatId': 'chat-a',
                  'scope': 'worktree',
                  'workspaceLocalId': 'ws-1',
                  'worktreeLocalId': 'wt-1',
                  'title': 'Chat A',
                  'active': true,
                },
              ],
            });
          final vm = RemoteControlViewModel(
            repository: repo,
            stateRefreshDebounce: Duration.zero,
            clock: () => now,
          );
          addTearDown(repo.eventsController.close);
          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              vm,
              RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
            ),
          );
          await tester.pump();
          final requests = repo.requestChatTranscriptCalls;
          expect(requests, greaterThan(0));

          vm.onAppBackgrounded();
          now = now.add(away);
          await tester.runAsync(vm.onAppForegrounded);
          await tester.pump();

          expect(
            repo.requestChatTranscriptCalls,
            reloads ? requests + 1 : requests,
          );
          expect(repo.discardEventCursorCalls, reloads ? 1 : 0);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          vm.dispose();
        },
      );
    }

    for (final check in ['ordering', 'completion']) {
      testWidgets('late history preserves chat $check', (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
                turnActive: false,
              ),
            ],
          );
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();

        Map<String, dynamic> row(
          String id,
          String role,
          String text,
          int created,
          int updated,
          String status,
        ) => {
          'messageId': id,
          'chatId': 'chat-a',
          'scope': 'worktree',
          'role': role,
          'text': text,
          'status': status,
          'createdAtMs': created,
          'updatedAtMs': updated,
        };
        final prompt = row(
          'user',
          'user',
          'Fix the merge state',
          1000,
          1000,
          'complete',
        );
        final answer = row(
          'answer',
          'assistant',
          'The merge state is fixed.',
          3000,
          4000,
          'complete',
        );
        // A live response races a history read containing its earlier prompt
        // and an older streaming revision of the response.
        final live = check == 'ordering' ? [answer] : [prompt, answer];
        repo.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              for (final message in live)
                {
                  'type': 'portal.chat.event',
                  'payload': {
                    'chatId': 'chat-a',
                    'scope': 'worktree',
                    'message': message,
                  },
                },
            ],
            'nextCursor': 1,
          }),
        );
        await tester.pump();
        repo.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.snapshot',
                'payload': {
                  'chatMessages': [
                    prompt,
                    {...answer, 'updatedAtMs': 3000, 'status': 'streaming'},
                  ],
                },
              },
            ],
            'nextCursor': 2,
          }),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 200));
        if (check == 'ordering') {
          expect(
            tester.getTopLeft(find.text('Fix the merge state')).dy,
            lessThan(
              tester.getTopLeft(find.text('The merge state is fixed.')).dy,
            ),
          );
        } else {
          expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
          expect(
            find.byKey(const ValueKey('remote-chat-working-indicator')),
            findsNothing,
          );
        }
        expect(tester.takeException(), isNull);
        vm.dispose();
      });
    }

    testWidgets(
      'streaming updates the transcript without rebuilding chat chrome',
      (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final vm = RemoteControlViewModel(repository: repo);

        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump();
        final counter = RebuildCounter();
        for (var i = 1; i <= 3; i++) {
          repo.eventsController.add(
            RemotePortalEventBatch(
              nextCursor: i,
              events: [
                RemoteStateDeltaEvent(
                  chatSummaries: [
                    RemoteChatSummary(
                      chatId: 'chat-a',
                      scope: RemoteChatScope.worktree,
                      workspaceLocalId: 'ws-1',
                      worktreeLocalId: 'wt-1',
                      title: 'Chat A',
                      active: true,
                      turnActive: true,
                      turnElapsedMs: i * 1000,
                    ),
                  ],
                ),
                RemoteChatMessageEvent(
                  chatId: 'chat-a',
                  scope: RemoteChatScope.worktree,
                  message: RemoteChatMessage(
                    messageId: 'm-1',
                    chatId: 'chat-a',
                    role: ChatRole.assistant,
                    text: 'Streaming update $i',
                    status: ChatMessageStatus.streaming,
                    occurredAt: DateTime(2026),
                  ),
                ),
              ],
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(find.textContaining('Streaming update $i'), findsOneWidget);
        }
        expect(counter.of(RemoteChatScreen), 0);
        expect(counter.of(CanopyAppBar), 0);
        // A title change still reaches the chrome after summary-only updates.
        repo.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 4,
            events: [
              RemoteStateDeltaEvent(
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-a',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Renamed chat',
                    active: true,
                  ),
                ],
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Renamed chat'), findsOneWidget);
        expect(counter.of(CanopyAppBar), 1);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      },
    );

    group('chat body notifications', () {
      RemoteChatSummary summary(
        String chatId,
        String worktreeLocalId, {
        bool active = false,
        bool? hasUnread,
        bool? turnActive,
        int? turnElapsedMs,
        List<AskUserQuestionState>? pendingQuestions,
      }) => RemoteChatSummary(
        chatId: chatId,
        scope: RemoteChatScope.worktree,
        workspaceLocalId: 'ws-1',
        worktreeLocalId: worktreeLocalId,
        title: 'Title $chatId',
        active: active,
        hasUnread: hasUnread,
        turnActive: turnActive,
        turnElapsedMs: turnElapsedMs,
        pendingQuestions: pendingQuestions,
      );

      RemoteChatMessageEvent live(
        String chatId,
        int i, {
        RemoteChatScope scope = RemoteChatScope.worktree,
      }) => RemoteChatMessageEvent(
        chatId: chatId,
        scope: scope,
        message: RemoteChatMessage(
          messageId: 'live-$chatId',
          chatId: chatId,
          scope: scope,
          role: ChatRole.assistant,
          text: 'Streaming $chatId $i',
          status: ChatMessageStatus.streaming,
          occurredAt: DateTime(2026),
        ),
      );

      Future<(FakeRemoteControlRepository, RemoteControlViewModel)> open(
        WidgetTester tester,
      ) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: const [],
            standaloneChats: const [],
            worktrees: const [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
              RemoteWorktree(
                localId: 'wt-2',
                workspaceLocalId: 'ws-1',
                branch: 'other',
              ),
            ],
            chatSummaries: [
              summary('chat-a', 'wt-1', active: true),
              summary('chat-b', 'wt-1'),
              summary('chat-c', 'wt-2', active: true),
            ],
            chatMessages: const [
              RemoteChatMessage(
                messageId: 'history-a',
                chatId: 'chat-a',
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Hello from A',
              ),
            ],
          );
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(
              worktree: vm
                  .worktreesFor('ws-1')
                  .firstWhere((row) => row.localId == 'wt-1'),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Hello from A'), findsOneWidget);
        return (repo, vm);
      }

      Future<void> deliver(
        WidgetTester tester,
        FakeRemoteControlRepository repo,
        int cursor,
        List<RemotePortalEvent> events, {
        RemotePortalConnectionStatus? connectionStatus,
      }) async {
        repo.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: cursor,
            events: events,
            connectionStatus: connectionStatus,
          ),
        );
        await tester.pump();
        await tester.pump();
      }

      testWidgets('unrelated updates leave the chat body alone', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        var notifications = 0;
        vm.addListener(() => notifications++);
        final counter = RebuildCounter();
        for (var i = 1; i <= 3; i++) {
          await deliver(tester, repo, i, [
            const RemoteStateDeltaEvent(
              prProgress: {
                'ws-1:wt-1': RemotePrProgressState(
                  creation: RemotePrCreationProgress(
                    steps: [],
                    currentPhase: RemotePrCreationPhase.pushing,
                  ),
                ),
              },
            ),
            live('chat-b', i),
            live('chat-c', i),
            RemoteStateDeltaEvent(
              chatSummaries: [
                summary(
                  'chat-c',
                  'wt-2',
                  active: true,
                  turnActive: true,
                  turnElapsedMs: i * 1000,
                ),
              ],
            ),
          ]);
        }
        expect(notifications, greaterThan(0));
        expect(counter.of(ChatInput), 0);
        expect(counter.of(ChatFeed), 0);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('the bound chat and its chrome still reach the body', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        await deliver(tester, repo, 1, [live('chat-a', 1)]);
        expect(find.textContaining('Streaming chat-a 1'), findsOneWidget);

        // A sibling turning unread lights the tabs button. The question dot
        // below would take precedence, so this comes first.
        await deliver(tester, repo, 2, [
          RemoteStateDeltaEvent(
            chatSummaries: [summary('chat-b', 'wt-1', hasUnread: true)],
          ),
        ]);
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);

        await deliver(tester, repo, 3, [
          RemoteStateDeltaEvent(
            chatSummaries: [
              summary(
                'chat-a',
                'wt-1',
                active: true,
                turnActive: true,
                turnElapsedMs: 1000,
                pendingQuestions: const [
                  AskUserQuestionState(
                    requestId: 'req-1',
                    questions: [
                      AskUserQuestion(
                        id: 'q-1',
                        header: 'Deploy',
                        question: 'Ship to prod?',
                        options: ['Yes', 'No'],
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ]);
        expect(find.textContaining('Ship to prod?'), findsWidgets);

        await deliver(
          tester,
          repo,
          4,
          const [],
          connectionStatus: RemotePortalConnectionStatus.reconnecting,
        );
        expect(find.byType(RemoteDegradedBanner), findsOneWidget);

        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('a bound-chat update rebuilds only the rows it changed', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        await deliver(tester, repo, 1, [live('chat-a', 1)]);
        const history = ValueKey('message-content-history-a');
        expect(find.byKey(history), findsOneWidget);

        final counter = RebuildCounter();
        await deliver(tester, repo, 2, [live('chat-a', 2)]);
        // A chrome-only change: the transcript list stays the same object.
        await deliver(tester, repo, 3, [
          RemoteStateDeltaEvent(
            chatSummaries: [
              summary(
                'chat-a',
                'wt-1',
                active: true,
                turnActive: true,
                turnElapsedMs: 3000,
              ),
            ],
          ),
        ]);

        expect(find.textContaining('Streaming chat-a 2'), findsOneWidget);
        expect(counter.of(ChatFeed), greaterThan(0));
        expect(
          counter.ofKey(const ValueKey('message-content-live-chat-a')),
          greaterThan(0),
        );
        expect(counter.ofKey(history), 0);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('switching tabs rebinds the body to the new chat', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        await tester.selectTabFromSheet('Title chat-b');
        await tester.finishSheetDismiss();
        await deliver(tester, repo, 1, [live('chat-b', 1)]);
        expect(find.textContaining('Streaming chat-b 1'), findsOneWidget);

        // The new feed settles its own scroll state once after it appears.
        await tester.pump();
        await tester.pump();

        final counter = RebuildCounter();
        await deliver(tester, repo, 2, [live('chat-a', 2)]);
        expect(counter.of(ChatInput), 0);
        expect(counter.of(ChatFeed), 0);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('a send whose turn never arrives stops looking busy', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        unawaited(
          vm.sendChatMessage(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              chatId: 'chat-a',
            ),
            'next',
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);

        // Only the grace timer's notification can clear the bridge now that
        // unrelated notifications no longer rebuild the body.
        await tester.pump(kRemoteTurnStartGrace + const Duration(seconds: 1));
        await tester.pump();
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('the drawer follows PR progress, not transcript streaming', (
        tester,
      ) async {
        final (repo, vm) = await open(tester);
        await tester.tap(find.byKey(const ValueKey('open-activity')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byType(RemoteActivitySidebar), findsOneWidget);

        final counter = RebuildCounter();
        await deliver(tester, repo, 1, [live('chat-a', 1)]);
        await deliver(tester, repo, 2, [live('chat-a', 2)]);
        expect(counter.of(RemoteActivitySidebar), 0);

        await deliver(tester, repo, 3, [
          const RemoteStateDeltaEvent(
            prProgress: {
              'ws-1:wt-1': RemotePrProgressState(
                creation: RemotePrCreationProgress(
                  steps: [],
                  currentPhase: RemotePrCreationPhase.pushing,
                ),
              ),
            },
          ),
        ]);
        expect(counter.of(RemoteActivitySidebar), greaterThan(0));
        expect(
          tester
              .widget<RemoteActivitySidebar>(find.byType(RemoteActivitySidebar))
              .prProgress,
          isNotNull,
        );
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });

      testWidgets('a standalone chat streams through its notifier', (
        tester,
      ) async {
        usePhoneViewport(tester);
        const chat = RemoteStandaloneChat(
          localId: 'chat-s',
          projectLocalId: 'ws-1',
          title: 'Cowork chat',
        );
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [],
            standaloneChats: [chat],
            chatSummaries: [],
          );
        final vm = RemoteControlViewModel(repository: repo);
        addTearDown(repo.eventsController.close);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            const RemoteChatScreen.standalone(standaloneChat: chat),
          ),
        );
        await tester.pump();
        await tester.pump();
        for (var i = 1; i <= 2; i++) {
          await deliver(tester, repo, i, [
            live('chat-s', i, scope: RemoteChatScope.standalone),
          ]);
          expect(find.textContaining('Streaming chat-s $i'), findsOneWidget);
        }
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });
    });

    testWidgets(
      'refreshes attachment capability for an already-connected chat',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _CapabilityRefreshingRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();
        expect(await composerAttachRowEnabled(tester), isNull);

        await tester.runAsync(viewModel.onAppForegrounded);
        await tester.pump();

        expect(repository.restoreSessionCalls, 1);
        expect(await composerAttachRowEnabled(tester), isTrue);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    for (final supportsAttachments in [false, true]) {
      testWidgets(
        'cowork attachment composer respects capability $supportsAttachments',
        (tester) async {
          usePhoneViewport(tester);
          const chat = RemoteStandaloneChat(
            localId: 'cowork-attachments',
            projectLocalId: 'workspace-1',
            title: 'Cowork attachments',
          );
          final repository = FakeRemoteControlRepository()
            ..supportsChatAttachments = supportsAttachments
            ..supportsStandaloneChatCreate = supportsAttachments
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [],
              worktrees: [],
              standaloneChats: [chat],
            );
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              RemoteChatScreen.standalone(
                standaloneChat: chat,
                attachmentPicker: _SingleFileAttachmentPicker(),
              ),
            ),
          );
          await tester.pump();
          if (!supportsAttachments) {
            expect(await composerAttachRowEnabled(tester), isNull);
            expect(repository.uploadCalls, isEmpty);
          } else {
            expect(await composerAttachRowEnabled(tester), isTrue);
            await openComposerActions(tester);
            await tester.pumpAndSettle();
            await tester.tap(
              find.byKey(const ValueKey('composer-action-attach-files')),
            );
            await tester.pumpAndSettle();
            expect(
              find.byKey(const ValueKey('attachment-strip')),
              findsOneWidget,
            );
            expect(repository.uploadCalls, hasLength(1));
            repository.sendChatMessageHandler = () async =>
                throw const RemoteControlException(
                  'The desktop rejected the send.',
                );
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pumpAndSettle();
            expect(repository.sendChatMessageCalls, hasLength(1));
            expect(
              find.byKey(const ValueKey('attachment-strip')),
              findsOneWidget,
            );
            expect(find.text('notes.txt'), findsOneWidget);
            final first = repository.sendChatMessageCalls.single;
            expect(first.target, isA<RemoteStandaloneChatTarget>());
            expect(first.target.chatId, chat.localId);
            expect(first.text, '');
            expect(first.options?.attachments?.single.filename, 'notes.txt');
            expect(first.options?.attachments?.single.attachmentId, 'fake-1');
            repository.sendChatMessageHandler = () async =>
                RemoteChatSendResult(
                  commandId: 'cowork-send',
                  chatId: chat.localId,
                );
            await tester.pump(const Duration(seconds: 4));
            await tester.pumpAndSettle();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            expect(repository.sendChatMessageCalls, hasLength(2));
            final retry = repository.sendChatMessageCalls.last;
            expect(retry.options?.attachments, first.options?.attachments);
            expect(repository.uploadCalls, hasLength(1));
            expect(repository.deleteAttachmentCalls, isEmpty);
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          viewModel.dispose();
          await repository.eventsController.close();
        },
      );
    }

    testWidgets(
      'first Cowork attachment waits for authoritative chat creation',
      (tester) async {
        usePhoneViewport(tester);
        const workspace = RemoteWorkspace(
          localId: 'workspace-first-attachment',
          name: 'Cowork',
          type: RemoteWorkspaceType.cowork,
        );
        final repository = _ProvisionalStandaloneAttachmentRepository()
          ..supportsChatAttachments = true
          ..supportsStandaloneChatCreate = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [workspace],
            worktrees: [],
            standaloneChats: [],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.create(
              workspace: workspace,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();
        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pump();
        await tester.pump();
        expect(repository.createTargets, hasLength(1));
        expect(repository.uploadCalls, isEmpty);
        expect(repository.sendChatMessageCalls, isEmpty);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        expect(repository.sendChatMessageCalls, isEmpty);
        final createdTarget = repository.createTargets.single;
        expect(createdTarget.projectLocalId, workspace.localId);
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'create-standalone-1',
                result: {'chatId': createdTarget.chatId},
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        expect(repository.uploadCalls, hasLength(1));
        expect(find.text('notes.txt'), findsOneWidget);
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        expect(repository.createTargets, hasLength(1));
        final sent = repository.sendChatMessageCalls.single;
        expect(sent.target, isA<RemoteStandaloneChatTarget>());
        expect(sent.target.chatId, createdTarget.chatId);
        expect(sent.text, '');
        expect(sent.options?.attachments?.single.attachmentId, 'fake-1');
        expect(sent.options?.userMessageId, isNotEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets(
      'leaving a Cowork draft during creation never uploads into another chat',
      (tester) async {
        usePhoneViewport(tester);
        const workspace = RemoteWorkspace(
          localId: 'workspace-pending-creation',
          name: 'Cowork',
          type: RemoteWorkspaceType.cowork,
        );
        const destination = RemoteWorkspace(
          localId: 'workspace-destination',
          name: 'Other Cowork',
          type: RemoteWorkspaceType.cowork,
        );
        final repository = _ProvisionalStandaloneAttachmentRepository()
          ..supportsChatAttachments = true
          ..supportsStandaloneChatCreate = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [workspace, destination],
            worktrees: [],
            standaloneChats: [],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.create(
              workspace: workspace,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();
        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pump();
        await tester.pump();
        expect(repository.createTargets, hasLength(1));
        final createdTarget = repository.createTargets.single;
        expect(repository.uploadCalls, isEmpty);
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.create(workspace: destination),
          ),
        );
        await tester.pump();
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandCompletedEvent(
                commandId: 'create-standalone-1',
                result: {'chatId': createdTarget.chatId},
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pumpAndSettle();
        expect(repository.createTargets, hasLength(1));
        expect(repository.uploadCalls, isEmpty);
        expect(repository.sendChatMessageCalls, isEmpty);
        expect(repository.deleteAttachmentCalls, isEmpty);
        expect(find.text('notes.txt'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    // `false` is an older desktop: it announces `chat_attachments` but not
    // `standalone_chat_create`, so the first text send must create the chat.
    for (final supportsCreate in [true, false]) {
      testWidgets(
        'first Cowork text follows the create capability ($supportsCreate)',
        (tester) async {
          usePhoneViewport(tester);
          const workspace = RemoteWorkspace(
            localId: 'workspace-first-text',
            name: 'Cowork',
            type: RemoteWorkspaceType.cowork,
          );
          final repository = _ProvisionalStandaloneAttachmentRepository()
            ..supportsChatAttachments = true
            ..supportsStandaloneChatCreate = supportsCreate
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [workspace],
              worktrees: [],
              standaloneChats: [],
            );
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              const RemoteChatScreen.create(workspace: workspace),
            ),
          );
          await tester.pump();
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Hello',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          if (supportsCreate) {
            expect(repository.createTargets, hasLength(1));
            expect(repository.sendChatMessageCalls, isEmpty);
            repository.eventsController.add(
              RemotePortalEventBatch(
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'create-standalone-1',
                    result: {'chatId': repository.createTargets.single.chatId},
                  ),
                ],
                nextCursor: 1,
              ),
            );
            await tester.pump();
            await tester.pump();
            expect(
              repository.sendChatMessageCalls.single.target.chatId,
              repository.createTargets.single.chatId,
            );
          } else {
            expect(repository.createTargets, isEmpty);
          }
          expect(repository.sendChatMessageCalls.single.text, 'Hello');
          expect(repository.uploadCalls, isEmpty);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          viewModel.dispose();
          await repository.eventsController.close();
        },
      );
    }

    for (final provisional in [true, false]) {
      testWidgets(
        'older desktops explain unavailable Cowork attachments (provisional: $provisional)',
        (tester) async {
          usePhoneViewport(tester);
          const workspace = RemoteWorkspace(
            localId: 'workspace-older-desktop',
            name: 'Cowork',
            type: RemoteWorkspaceType.cowork,
          );
          const chat = RemoteStandaloneChat(
            localId: 'cowork-older-desktop',
            projectLocalId: 'workspace-older-desktop',
            title: 'Existing Cowork chat',
          );
          // Announces `chat_attachments` only, as desktops released before
          // the standalone create handshake do.
          final repository = _ProvisionalStandaloneAttachmentRepository()
            ..supportsChatAttachments = true
            ..snapshotBuilder = () => RemoteSessionSnapshot(
              workspaces: const [workspace],
              worktrees: const [],
              standaloneChats: provisional ? const [] : const [chat],
            );
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              provisional
                  ? RemoteChatScreen.create(
                      workspace: workspace,
                      attachmentPicker: _SingleFileAttachmentPicker(),
                    )
                  : RemoteChatScreen.standalone(
                      standaloneChat: chat,
                      attachmentPicker: _SingleFileAttachmentPicker(),
                    ),
            ),
          );
          await tester.pump();
          expect(await composerAttachRowEnabled(tester), isFalse);
          await openComposerActions(tester);
          expect(
            find.text(kStandaloneAttachmentsNeedDesktopUpdate),
            findsOneWidget,
          );
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-files')),
          );
          await tester.pumpAndSettle();
          expect(find.byType(BottomSheet), findsOneWidget);
          await closeComposerActions(tester);
          // Text still sends, without the create command older desktops
          // reject.
          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'Hello',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          await tester.pump();
          expect(repository.createTargets, isEmpty);
          expect(repository.sendChatMessageCalls.single.text, 'Hello');
          expect(repository.uploadCalls, isEmpty);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          viewModel.dispose();
          await repository.eventsController.close();
        },
      );
    }

    for (final failure in ['rejected', 'unconfirmed', 'wrong identity']) {
      testWidgets(
        'first Cowork attachment retries $failure creation without losing bytes',
        (tester) async {
          usePhoneViewport(tester);
          const workspace = RemoteWorkspace(
            localId: 'workspace-first-attachment',
            name: 'Cowork',
            type: RemoteWorkspaceType.cowork,
          );
          final repository = _ProvisionalStandaloneAttachmentRepository()
            ..supportsChatAttachments = true
            ..supportsStandaloneChatCreate = true
            ..snapshotBuilder = () => const RemoteSessionSnapshot(
              workspaces: [workspace],
              worktrees: [],
              standaloneChats: [],
            );
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              RemoteChatScreen.create(
                workspace: workspace,
                attachmentPicker: _SingleFileAttachmentPicker(),
              ),
            ),
          );
          await tester.pump();
          await openComposerActions(tester);
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const ValueKey('composer-action-attach-files')),
          );
          await tester.pump();
          await tester.pump();
          expect(repository.createTargets, hasLength(1));
          final chatId = repository.createTargets.single.chatId;
          if (failure == 'rejected') {
            repository.eventsController.add(
              RemotePortalEventBatch(
                events: [
                  RemoteCommandFailedEvent(
                    commandId: 'create-standalone-1',
                    message: 'The chat could not be created.',
                  ),
                ],
                nextCursor: 1,
              ),
            );
          } else if (failure == 'unconfirmed') {
            await tester.pump(const Duration(seconds: 31));
          } else {
            repository.eventsController.add(
              RemotePortalEventBatch(
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'create-standalone-1',
                    result: {'chatId': 'another-chat'},
                  ),
                ],
                nextCursor: 1,
              ),
            );
          }
          await tester.pumpAndSettle();
          expect(repository.uploadCalls, isEmpty);
          expect(repository.sendChatMessageCalls, isEmpty);
          expect(find.text('notes.txt'), findsOneWidget);
          await tester.tap(
            find.byKey(const ValueKey('attachment-retry-att-1')),
          );
          await tester.pump();
          await tester.pump();
          expect(repository.createTargets, hasLength(2));
          expect(repository.createTargets.last.chatId, chatId);
          expect(repository.uploadCalls, isEmpty);
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteCommandCompletedEvent(
                  commandId: 'create-standalone-2',
                  result: {'chatId': chatId},
                ),
              ],
              nextCursor: 2,
            ),
          );
          await tester.pumpAndSettle();
          expect(repository.uploadCalls, hasLength(1));
          await tester.pump(const Duration(seconds: 4));
          await tester.pumpAndSettle();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.pump();
          expect(repository.sendChatMessageCalls.single.target.chatId, chatId);
          expect(repository.createTargets, hasLength(2));
          expect(repository.deleteAttachmentCalls, isEmpty);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          viewModel.dispose();
          await repository.eventsController.close();
        },
      );
    }

    testWidgets('retains failed attachment drafts until capability returns', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
          ],
        );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      const target = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-a',
      );
      viewModel.retainPendingChatAttachments(
        commandId: 'failed-send',
        target: target,
        restoreImmediately: true,
        drafts: [
          ChatAttachmentDraft(
            localId: 'draft-1',
            filename: 'diagram.png',
            mediaType: 'image/png',
            bytes: Uint8List(1),
            status: ChatAttachmentStatus.ready,
            uploaded: ChatAttachmentRef(
              attachmentId: 'attachment-1',
              filename: 'diagram.png',
              mediaType: 'image/png',
              size: 1,
              contentSha256:
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              storageKind: 'blob',
              source: '/fake',
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(viewModel.pendingChatAttachmentsFor(target), hasLength(1));
      expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);

      repository.supportsChatAttachments = true;
      await tester.runAsync(viewModel.refresh);
      await tester.pump();
      await tester.pump();

      expect(viewModel.pendingChatAttachmentsFor(target), isEmpty);
      expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
      await repository.eventsController.close();
    });

    testWidgets(
      'long command failures stay compact and expand into a details sheet',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Commit it',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
        expect(repository.sendChatMessageCalls, hasLength(1));

        // Mirrors a real git-hook rejection: a command line, a full commit
        // body, and dozens of lines of hook output.
        final hookOutput = List.generate(
          60,
          (i) => 'npm warn hook output line $i that keeps going and going',
        ).join('\n');
        final message =
            'Command failed: /usr/bin/git commit -m fix(mobile): prevent '
            'chat message reordering and status regressions on replay\n\n'
            '$hookOutput\nFINAL-HOOK-LINE';
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(message: message, commandId: 'fake-cmd'),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        expect(viewModel.commandFailureMessage, message);

        final banner = find.byKey(const ValueKey('remote-command-failure'));
        expect(banner, findsOneWidget);
        final bannerContext = tester.element(banner);
        final colors = AppColors.of(bannerContext);
        expect(tester.widget<Material>(banner).color, colors.background);
        final failureIcon = tester.widget<CanopyIcon>(
          find.descendant(of: banner, matching: find.byType(CanopyIcon)),
        );
        expect(failureIcon.glyph, CanopyGlyph.exclamationTriangle);
        expect(failureIcon.tint, StatusColors.of(bannerContext).destructive);
        expect(
          tester
              .widget<Text>(find.text(CommandFailureBanner.summaryOf(message)))
              .style
              ?.color,
          colors.foreground,
        );
        // Bounded: a few lines at most, never the whole screen.
        expect(tester.getSize(banner).height, lessThan(120));
        // The not-sent row keeps the full reason; the banner stays compact.
        expect(
          find.descendant(
            of: banner,
            matching: find.textContaining('FINAL-HOOK-LINE'),
          ),
          findsNothing,
        );

        await tester.tap(banner);
        await tester.pumpAndSettle();
        final details = find.byKey(
          const ValueKey('remote-command-failure-details'),
        );
        expect(details, findsOneWidget);
        expect(
          find.descendant(
            of: details,
            matching: find.textContaining('FINAL-HOOK-LINE'),
          ),
          findsOneWidget,
        );
        Navigator.of(tester.element(details)).pop();
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const ValueKey('remote-command-failure-dismiss')),
        );
        await tester.pump();
        expect(banner, findsNothing);
        expect(viewModel.commandFailureMessage, isNull);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets(
      'retains an in-flight failed attachment batch when capability disappears',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final sendCompleter = Completer<RemoteChatSendResult>();
        repository.sendChatMessageHandler = () => sendCompleter.future;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        const target = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-a',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: viewModel.allWorktrees.single,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();

        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Send with a file',
        );
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        expect(viewModel.pendingChatAttachmentsFor(target), hasLength(1));

        repository.supportsChatAttachments = false;
        await tester.runAsync(viewModel.refresh);
        await tester.pump();
        expect(await composerAttachRowEnabled(tester), isNull);

        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The send failed.',
                commandId: 'send-1',
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        sendCompleter.complete(
          const RemoteChatSendResult(commandId: 'send-1', chatId: 'chat-a'),
        );
        await tester.pump();

        expect(viewModel.pendingChatAttachmentsFor(target), hasLength(1));

        repository.supportsChatAttachments = true;
        await tester.runAsync(viewModel.refresh);
        await tester.pump();
        await tester.pump();

        expect(viewModel.pendingChatAttachmentsFor(target), isEmpty);
        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets(
      'tab labels prefer desktop descriptions and fall back to titles',
      (tester) async {
        usePhoneViewport(tester);
        const longLabel =
            'Desktop label with a very long description that must fit inside a compact tab without hiding its close button';
        final repo = FakeRemoteControlRepository();
        repo.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [],
          'worktrees': [
            {
              'localId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'branch': 'Task',
              'label': 'Worktree description',
            },
          ],
          'standaloneChats': [],
          'chatSummaries': [
            {
              'chatId': 'described',
              'scope': 'worktree',
              'worktreeLocalId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'title': 'Original title',
              'description': longLabel,
              'active': true,
            },
            {
              'chatId': 'fallback',
              'scope': 'worktree',
              'worktreeLocalId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'title': 'Fallback title',
            },
          ],
        });
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pumpAndSettle();
        final header = find.byType(CanopyAppBar);
        final chatTitle = find.descendant(
          of: header,
          matching: find.text(longLabel),
        );
        final subtitle = find.descendant(
          of: header,
          matching: find.text('Worktree description'),
        );
        expect(chatTitle, findsOneWidget);
        expect(subtitle, findsOneWidget);
        expect(
          tester.getBottomLeft(chatTitle).dy,
          lessThanOrEqualTo(tester.getTopLeft(subtitle).dy),
        );
        expect(tester.widget<Text>(chatTitle).maxLines, 1);
        expect(tester.widget<Text>(chatTitle).overflow, TextOverflow.ellipsis);
        await tester.openTabsSheet();
        final described = find.byKey(const ValueKey('chat-tab-described'));
        expect(
          find.descendant(of: described, matching: find.text(longLabel)),
          findsOneWidget,
        );
        expect(
          tester
              .widget<CanopyIconButton>(
                find.byKey(const ValueKey('chat-tab-close-described')),
              )
              .tooltip,
          'Close $longLabel',
        );
        // A label this long wraps to a second line and then truncates rather
        // than overflowing, and its close control stays reachable.
        final labelText = tester.widget<Text>(
          find.descendant(of: described, matching: find.text(longLabel)),
        );
        expect(labelText.overflow, TextOverflow.ellipsis);
        expect(labelText.maxLines, 2);
        expect(
          find.byKey(const ValueKey('chat-tab-close-described')).hitTestable(),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        final fallback = find.byKey(const ValueKey('chat-tab-fallback'));
        expect(
          find.descendant(of: fallback, matching: find.text('Fallback title')),
          findsOneWidget,
        );
        await tester.tap(fallback);
        await tester.settleSheetDismiss();
        expect(
          find.descendant(of: header, matching: find.text('Fallback title')),
          findsOneWidget,
        );
        expect(subtitle, findsOneWidget);
        await tester.openTabsSheet();
        expect(
          tester
              .widget<ListTile>(find.byKey(const ValueKey('chat-tab-fallback')))
              .selected,
          isTrue,
        );
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repo.eventsController.close();
      },
    );

    testWidgets('an inactive screen acknowledges nothing until it is shown', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repo = FakeRemoteControlRepository()..supportsChatMarkRead = true;
      repo.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
        'workspaces': [
          {'localId': 'ws-1', 'name': 'Workspace'},
        ],
        'worktrees': [
          {
            'localId': 'wt-1',
            'workspaceLocalId': 'ws-1',
            'name': 'Task',
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
            'title': 'chat-1',
            'active': true,
            'hasUnread': true,
          },
        ],
        'chatMessages': [
          {
            'localMessageId': 'chat-1-reply',
            'localChatId': 'chat-1',
            'scope': 'worktree',
            'role': 'assistant',
            'status': 'complete',
            'content': 'Reply chat-1',
          },
        ],
      });
      final vm = RemoteControlViewModel(
        repository: repo,
        stateRefreshDebounce: Duration.zero,
      );
      await vm.connect('123456');
      final active = ValueNotifier<bool>(false);
      addTearDown(active.dispose);
      await tester.pumpWidget(
        buildSubject(
          vm,
          ValueListenableBuilder<bool>(
            valueListenable: active,
            builder: (context, isActive, _) => RemoteChatScreen.worktree(
              worktree: vm.allWorktrees.single,
              isActive: isActive,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      // Mounted behind another home-shell tab: nothing was read yet.
      expect(repo.markReadCalls, isEmpty);

      active.value = true;
      await tester.pump();
      await tester.pump();
      expect(repo.markReadCalls.map((c) => c.lastMessageId), ['chat-1-reply']);
      await tester.pumpWidget(const SizedBox());
      vm.dispose();
      await repo.eventsController.close();
    });

    testWidgets(
      'acknowledges only visible completed output on a capable desktop',
      (tester) async {
        usePhoneViewport(tester);
        final repo = FakeRemoteControlRepository()..supportsChatMarkRead = true;
        repo.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'ws-1', 'name': 'Workspace'},
          ],
          'worktrees': [
            {
              'localId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'name': 'Task',
              'hasUnread': true,
            },
          ],
          'standaloneChats': [],
          'chatSummaries': [
            for (final id in ['chat-1', 'chat-2'])
              {
                'chatId': id,
                'scope': 'worktree',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'title': id,
                'active': id == 'chat-1',
                'hasUnread': true,
              },
          ],
          'chatMessages': [
            for (final id in ['chat-1', 'chat-2'])
              {
                'localMessageId': '$id-reply',
                'localChatId': id,
                'scope': 'worktree',
                'role': 'assistant',
                'status': 'complete',
                'content': 'Reply $id',
              },
          ],
        });
        final vm = RemoteControlViewModel(
          repository: repo,
          stateRefreshDebounce: Duration.zero,
        );
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        expect(find.text('Reply chat-1'), findsOneWidget);
        expect(repo.markReadCalls.map((c) => c.lastMessageId), [
          'chat-1-reply',
        ]);
        await tester.pump();
        expect(repo.markReadCalls, hasLength(1));

        expect(
          vm
              .chatSummariesFor(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              )
              .first
              .hasUnread,
          isFalse,
        );
        expect(
          vm
              .chatSummariesFor(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              )
              .last
              .hasUnread,
          isTrue,
        );
        expect(vm.allWorktrees.single.hasUnread, isTrue);

        // The tab sheet is a route of its own, so while it is up the chat
        // screen is no longer current and must not acknowledge anything.
        // (This replaces the synthetic pushed page the previous version of
        // this test used: the sheet is the real covering route now.)
        await tester.openTabsSheet();
        expect(repo.markReadCalls, hasLength(1));
        expect(find.byKey(const ValueKey('chat-unread-chat-1')), findsNothing);
        expect(
          find.byKey(const ValueKey('chat-unread-chat-2')),
          findsOneWidget,
        );

        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        // A backgrounded app produces no frames, so the selection lands in
        // state but nothing is acknowledged for the newly chosen chat.
        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-2')));
        await tester.pump();
        expect(repo.markReadCalls, hasLength(1));

        // The framework asserts on skipped lifecycle states; walk back the
        // same way the OS does (paused -> hidden -> inactive -> resumed).
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        await tester.settleSheetDismiss();
        await tester.pump();
        expect(repo.markReadCalls.map((c) => c.lastMessageId), [
          'chat-1-reply',
          'chat-2-reply',
        ]);
        expect(
          vm
              .chatSummariesFor(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              )
              .every((s) => s.hasUnread == false),
          isTrue,
        );
        expect(vm.allWorktrees.single.hasUnread, isFalse);
        // Accepted commands whose completion never arrives must not stick.
        for (var attempt = 0; attempt < 4; attempt++) {
          await tester.pump(const Duration(seconds: 65));
          await tester.pump();
        }
        expect(repo.markReadCalls.length, greaterThanOrEqualTo(6));
        expect(vm.commandFailureMessage, isNull);
        await tester.openTabsSheet();
        final callsBeforeNewOutput = repo.markReadCalls.length;
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-2',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: 'new-reply',
                  chatId: 'chat-2',
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'New output',
                ),
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(
          find.byKey(const ValueKey('chat-unread-chat-2')),
          findsOneWidget,
        );
        expect(
          repo.markReadCalls.length,
          callsBeforeNewOutput,
          reason: 'A covered chat must not acknowledge new output',
        );
        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-2')));
        await tester.finishSheetDismiss();
        await tester.pump();
        expect(repo.markReadCalls.last.lastMessageId, 'new-reply');
        expect(
          vm
              .chatSummariesFor(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              )
              .last
              .hasUnread,
          isFalse,
        );
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repo.eventsController.close();
      },
    );

    testWidgets(
      'tab activity uses summaries before transcripts load and clears to unread',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        var running = true;
        var unread = true;
        repository.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [],
          'worktrees': [
            {
              'localId': 'wt-1',
              'workspaceLocalId': 'ws-1',
              'branch': 'main',
              'isWorking': true,
            },
          ],
          'standaloneChats': [],
          'chatSummaries': [
            for (final id in ['a', 'b'])
              {
                'chatId': id,
                'scope': 'worktree',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'title': 'Chat $id',
                'active': id == 'b',
                'turnActive': id == 'a' && running,
                'hasUnread': id == 'a' && unread,
              },
          ],
        });
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.openTabsSheet();
        final rowA = find.byKey(const ValueKey('chat-tab-a'));
        expect(
          find.descendant(of: rowA, matching: find.byType(ThinkingSpinner)),
          findsOneWidget,
        );
        // A running chat shows the spinner instead of an unread dot, and
        // cannot be closed.
        expect(find.byKey(const ValueKey('chat-unread-a')), findsNothing);
        expect(find.byKey(const ValueKey('chat-tab-close-a')), findsNothing);
        await tester.tap(find.text('Chat a'));
        await tester.settleSheetDismiss();
        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
        running = false;
        await vm.refresh();
        await tester.pump();
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
        // The finished chat is now unread, which the FAB advertises without
        // the sheet being open.
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);
        await tester.openTabsSheet();
        expect(
          find.descendant(of: rowA, matching: find.byType(ThinkingSpinner)),
          findsNothing,
        );
        expect(find.byKey(const ValueKey('chat-unread-a')), findsOneWidget);
        expect(find.byKey(const ValueKey('chat-tab-close-a')), findsOneWidget);
        await tester.dismissTabsSheet();

        unread = false;
        await vm.refresh();
        await tester.pump();
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsNothing);
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-unread-a')), findsNothing);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets('renders the seeded transcript and chat tabs', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: worktreeWithChats(viewModel)),
        ),
      );
      // The timed pump advances the fake clock so the mock's zero-latency
      // transcript request fires instead of leaking as a pending timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      // Tabs live behind the FAB now; the strip no longer competes with the
      // transcript for vertical space.
      await tester.openTabsSheet();
      expect(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('PKCE implementation'),
        ),
        findsOneWidget,
      );
      expect(find.text('Widget test cleanup'), findsOneWidget);
      await tester.dismissTabsSheet();

      // Seeded transcript for the active chat renders both roles.
      expect(find.text('Add PKCE to the mobile OAuth flow'), findsOneWidget);
      expect(find.textContaining('All 42 auth tests pass'), findsOneWidget);

      // Aggregate worktree activity cannot make a completed chat run.
      expect(find.byKey(const ValueKey('composer-stop')), findsNothing);

      // The intermediate agent steps are collapsed behind one summary card
      // of per-category counts — not rendered as a wall of tool rows.
      expect(
        find.bySemanticsLabel('Agent steps: 1 bash, 1 write/edit'),
        findsOneWidget,
      );
      expect(find.text('Run the auth tests'), findsNothing);
      expect(find.text('Edit'), findsNothing);

      // Expanding the row reveals flat icon rows with the friendly
      // verb + parameter labels: the Bash description heads its row with the
      // command as a mono detail, and Edit shows the touched file basename.
      await tester.tap(find.byKey(const ValueKey('turn-steps-seed-1')));
      await tester.pump();
      expect(find.text('Run the auth tests'), findsOneWidget);
      expect(find.text('npm test -- auth'), findsOneWidget);
      expect(find.byIcon(Icons.terminal), findsOneWidget);
      expect(find.text('Edit'), findsOneWidget);
      expect(find.text('oauth_pkce.dart'), findsOneWidget);

      // The correlated tool_result opens from the row.
      await tester.tap(find.text('Run the auth tests'));
      await tester.pump();
      expect(find.text('Result'), findsOneWidget);
      expect(find.text('42 passing (3.1s)'), findsOneWidget);

      // Collapsing hides the step rows again.
      final steps = find.byKey(const ValueKey('turn-steps-seed-1'));
      await tester.ensureVisible(steps);
      await tester.pump();
      await tester.tap(steps);
      await tester.pump();
      expect(find.text('Run the auth tests'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets(
      'Codex live tool upserts converge with history and collapse on completion',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        var running = true;
        final user = RemoteChatMessage.fromWireJson({
          'messageId': 'u-1',
          'chatId': 'chat-a',
          'role': 'user',
          'status': 'complete',
          'text': 'Find the caller',
        });
        RemoteChatMessage tool(
          String id, {
          bool completed = false,
          bool mcp = false,
          bool hydrated = false,
        }) => RemoteChatMessage.fromWireJson({
          'messageId': 'codex-$id',
          'chatId': 'chat-a',
          'role': 'system',
          'status': completed ? 'complete' : 'streaming',
          'text': '',
          'parts': [
            {
              'kind': 'tool_use',
              'toolFamily': mcp ? 'unknown' : 'graph',
              'data': {
                'toolUseId': 'codex-$id',
                'toolName': mcp
                    ? 'mcp__fixture__query'
                    : 'canopy_query_code_graph',
                'input': '{"query":"remote-caller"}',
                if (completed && hydrated)
                  'result': {
                    'output': mcp
                        ? 'Remote lookup failed'
                        : 'Found remote caller',
                    'isError': mcp,
                  },
              },
            },
            if (completed && !hydrated)
              {
                'kind': 'tool_result',
                'data': {
                  'toolUseId': 'codex-$id',
                  'output': mcp
                      ? 'Remote lookup failed'
                      : 'Found remote caller',
                  'isError': mcp,
                },
              },
          ],
        });
        var history = [user];
        repository.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [],
          'worktrees': [
            {'localId': 'wt-1', 'workspaceLocalId': 'ws-1', 'branch': 'main'},
          ],
          'standaloneChats': [],
          'chatSummaries': [
            {
              'chatId': 'chat-a',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat A',
              'active': true,
              'turnActive': running,
            },
          ],
        });
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.worktreesFor('ws-1').single),
          ),
        );
        await tester.pump();
        var cursor = 0;
        Future<void> emit(List<RemotePortalEvent> events) async {
          repository.eventsController.add(
            RemotePortalEventBatch(events: events, nextCursor: ++cursor),
          );
          await tester.runAsync(() => Future<void>.delayed(Duration.zero));
          await tester.pump();
        }

        Future<void> live(RemoteChatMessage message) => emit([
          RemoteChatMessageEvent(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            message: message,
          ),
        ]);
        Future<void> hydrate() => emit([
          RemoteStateSnapshotEvent(
            scope: 'chat',
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: 'wt-1',
            targetChatId: 'chat-a',
            targetChatScope: RemoteChatScope.worktree,
            chatMessages: history,
          ),
        ]);
        await live(user);
        await live(tool('graph'));
        await live(tool('mcp', mcp: true));
        expect(find.text('Canopy Query Code Graph'), findsOneWidget);
        final graphRow = find.byKey(const ValueKey('message-codex-graph'));
        final mcpRow = find.byKey(const ValueKey('message-codex-mcp'));
        expect(
          tester.getTopLeft(graphRow).dy,
          lessThan(tester.getTopLeft(mcpRow).dy),
        );
        await tester.tap(find.text('Canopy Query Code Graph'));
        await tester.pump();
        expect(find.textContaining('remote-caller'), findsWidgets);
        await live(tool('graph', completed: true));
        expect(find.text('Found remote caller'), findsOneWidget);
        await live(tool('mcp', completed: true, mcp: true));
        await tester.tap(find.text('Fixture › Query'));
        await tester.pump();
        expect(find.text('Remote lookup failed'), findsOneWidget);
        expect(find.text('Error'), findsOneWidget);
        await tester.tap(find.text('Fixture › Query'));
        await tester.pump();
        history = [
          user,
          tool('graph', completed: true, hydrated: true),
          tool('mcp', completed: true, mcp: true, hydrated: true),
        ];
        await hydrate();
        expect(graphRow, findsOneWidget);
        expect(mcpRow, findsOneWidget);
        expect(find.text('Found remote caller'), findsOneWidget);
        await live(tool('graph', completed: true));
        expect(graphRow, findsOneWidget);
        running = false;
        await vm.refresh();
        await live(
          RemoteChatMessage.fromWireJson({
            'messageId': 'answer',
            'chatId': 'chat-a',
            'role': 'assistant',
            'status': 'complete',
            'text': 'Lookup finished',
          }),
        );
        await tester.pump();
        expect(find.text('Canopy Query Code Graph'), findsNothing);
        final summary = find.byKey(const ValueKey('turn-steps-u-1'));
        await tester.tap(summary);
        await tester.pump();
        expect(find.text('Canopy Query Code Graph'), findsOneWidget);
        expect(graphRow, findsOneWidget);
        expect(mcpRow, findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets('an expanded tool-call panel survives new messages landing', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Ran the tests.',
            parts: [
              ChatPart(
                kind: 'tool_use',
                toolFamily: 'bash',
                data: {
                  'toolUseId': 'tu-1',
                  'toolName': 'Bash',
                  'input': '{"command": "npm test"}',
                },
              ),
            ],
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      // Expand the tool call's detail panel.
      await tester.tap(find.text('Bash'));
      await tester.pump();
      expect(find.byKey(const ValueKey('tool-call-detail')), findsOneWidget);

      // A new message lands, changing the builder's transcript rows.
      // (A USER message: it opens a new turn, so the tool-bearing answer
      // keeps its final-message classification — appending another assistant
      // answer would instead demote it into the collapsed steps by design.)
      // The keyed rows + findChildIndexCallback must keep the SAME panel
      // open — regression: without the callback the keyed element was
      // deactivated and the panel snapped shut on every append.
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteChatMessageEvent(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              message: RemoteChatMessage(
                messageId: 'u-2',
                chatId: 'chat-a',
                role: ChatRole.user,
                status: ChatMessageStatus.complete,
                text: 'Now run the linter too.',
              ),
            ),
          ],
          nextCursor: 1,
        ),
      );
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();

      expect(find.text('Now run the linter too.'), findsOneWidget);
      expect(find.byKey(const ValueKey('tool-call-detail')), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Flush the hydration/turn timers the screen armed so none outlive
      // the test, then release the view model.
      await tester.pump(const Duration(minutes: 2));
      viewModel.dispose();
    });

    testWidgets('watcher rows from the snapshot and live events show the '
        'watcher title; an older desktop row stays plain (CAN-4432)', (
      tester,
    ) async {
      usePhoneViewport(tester);
      Map<String, dynamic> wire(
        String id,
        int at,
        String text, [
        Map<String, dynamic>? watcherFired,
      ]) => {
        'messageId': id,
        'chatId': 'chat-a',
        'scope': 'worktree',
        'role': 'user',
        'status': 'complete',
        'text': text,
        'createdAtMs': at,
        'promptSource': 'automated',
        'watcherFired': ?watcherFired,
      };
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          RemoteChatMessage.fromWireJson(
            wire('legacy', 1000, 'Canopy watcher fired.\nPipeline: Lint'),
          ),
          RemoteChatMessage.fromWireJson(
            wire('single', 2000, 'Canopy watcher fired.\nPipeline: Deploy', {
              'kind': 'Pipeline completion (Deploy)',
            }),
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      repository.eventsController.add(
        RemotePortalEventBatch.fromJson({
          'events': [
            {
              'type': 'portal.chat.event',
              'payload': {
                'chatId': 'chat-a',
                'scope': 'worktree',
                'message': wire('merged', 3000, 'Two watchers fired.', {
                  'kind': 'Multiple watchers fired (2)',
                  'combinedWatchers': [
                    {'kind': 'Deploy', 'text': 'Deploy finished.'},
                    {'kind': 'Lint', 'text': 'Lint finished.'},
                  ],
                }),
              },
            },
          ],
          'nextCursor': 1,
        }),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Pipeline completion (Deploy) watcher has fired'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('watcher-bubble-single')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('user-bubble-legacy')), findsOneWidget);
      expect(find.byKey(const ValueKey('watcher-bubble-legacy')), findsNothing);

      await tester.tap(find.byKey(const ValueKey('watcher-title-merged')));
      await tester.pumpAndSettle();
      expect(find.text('Deploy watcher has fired'), findsOneWidget);
      expect(find.text('Lint watcher has fired'), findsOneWidget);
      expect(find.text('Lint finished.'), findsOneWidget);
      viewModel.dispose();
    });

    testWidgets('a long expanded run collapses again from its steps card', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          const RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Run the whole suite',
          ),
          // A long agent run: many intermediate steps behind one summary.
          for (var i = 0; i < 25; i++)
            RemoteChatMessage(
              messageId: 'step-$i',
              chatId: 'chat-a',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: '',
              parts: [
                ChatPart(
                  kind: 'tool_use',
                  toolFamily: 'bash',
                  data: {
                    'toolUseId': 'tu-$i',
                    'toolName': 'Bash',
                    'input': '{"command": "step $i"}',
                  },
                ),
              ],
            ),
          const RemoteChatMessage(
            messageId: 'a-final',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'All done.',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      // Expand the run's steps. The compact completed turn opens at the
      // bottom, so first reveal the summary from beneath the overlaid app bar.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 200),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('turn-steps-u-1')));
      await tester.pump();
      await tester.pump();
      expect(find.text('step 24'), findsOneWidget);

      // Scrolling deep into the run keeps it expanded; there is no floating
      // collapse affordance — the steps card is the only toggle.
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 600),
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('collapse-steps-pill')), findsNothing);

      // Scroll back up to the steps card and tap it to collapse the turn.
      await tester.dragUntilVisible(
        find.byKey(const ValueKey('turn-steps-u-1')),
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 400),
      );
      await tester.drag(
        find.byKey(const ValueKey('remote-chat-transcript')),
        const Offset(0, 100),
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('turn-steps-u-1')));
      await tester.pump();
      await tester.pump();
      expect(find.byKey(const ValueKey('turn-steps-u-1')), findsOneWidget);
      expect(find.textContaining('step 2'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    // Every ChatFeed scroll test mounts the feed in a bare Scaffold, so
    // nothing covered the real route: the app-bar inset the feed scrolls
    // under, the composer below it, and the Stack the transcript shares with
    // the tabs action. Flicking here exercises the assembled tree.
    for (final platform in const [TargetPlatform.android, TargetPlatform.iOS]) {
      testWidgets('a flick scrolls the transcript on the real screen '
          '(${platform.name})', (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository();
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
            chatSummaries: const [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
            chatMessages: [
              for (var i = 0; i < 20; i++) ...[
                RemoteChatMessage(
                  messageId: 'u-$i',
                  chatId: 'chat-a',
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  text: 'Question $i with enough text to give the row height.',
                ),
                RemoteChatMessage(
                  messageId: 'a-$i',
                  chatId: 'chat-a',
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Answer $i with enough text to make the feed scroll.',
                ),
              ],
            ],
          );
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));
          final worktree = viewModel.worktreesFor('ws-1').single;

          await tester.pumpWidget(
            buildSubject(
              viewModel,
              RemoteChatScreen.worktree(worktree: worktree),
            ),
          );
          await tester.pumpAndSettle();

          final transcript = find.byKey(
            const ValueKey('remote-chat-transcript'),
          );
          final position = tester
              .state<ScrollableState>(
                find.descendant(
                  of: transcript,
                  matching: find.byWidgetPredicate(
                    (widget) =>
                        widget is Scrollable &&
                        widget.physics is! NeverScrollableScrollPhysics,
                  ),
                  matchRoot: true,
                ),
              )
              .position;
          final start = position.pixels;

          await tester.fling(transcript, const Offset(0, 500), 1200);
          await tester.pumpAndSettle();

          expect(
            start - position.pixels,
            greaterThan(24),
            reason: 'the transcript did not scroll on the assembled screen',
          );
          expect(tester.takeException(), isNull);
          viewModel.dispose();
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }

    testWidgets('expanding a turn reveals each thinking step\'s text', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Fix the login badge',
          ),
          RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '',
            parts: [
              ChatPart(
                kind: 'thinking',
                data: {'text': 'First I will inspect the auth flow.'},
              ),
              ChatPart(
                kind: 'tool_use',
                toolFamily: 'bash',
                data: {'toolName': 'Bash'},
              ),
            ],
          ),
          RemoteChatMessage(
            messageId: 'a-2',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '',
            parts: [
              ChatPart(
                kind: 'thinking',
                data: {'text': 'Now updating the runbook to match.'},
              ),
            ],
          ),
          RemoteChatMessage(
            messageId: 'a-3',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Done — the badge shows only on sign-in.',
            parts: [
              ChatPart(
                kind: 'thinking',
                data: {'text': 'Composing the final summary.'},
              ),
            ],
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      // Collapsed by default: no thinking text, just the steps summary card.
      final stepsRow = find.byKey(const ValueKey('turn-steps-u-1'));
      expect(stepsRow, findsOneWidget);
      expect(find.text('First I will inspect the auth flow.'), findsNothing);
      expect(find.text('Now updating the runbook to match.'), findsNothing);

      // Expanding the row reveals every intermediate thinking step's text.
      await tester.tap(stepsRow);
      await tester.pumpAndSettle();
      expect(find.text('First I will inspect the auth flow.'), findsOneWidget);
      expect(find.text('Now updating the runbook to match.'), findsOneWidget);

      // Short thoughts fit the preview, so the final answer's shows in full.
      expect(find.text('Composing the final summary.'), findsOneWidget);
      expect(
        find.text('Done — the badge shows only on sign-in.'),
        findsOneWidget,
      );

      // Collapsing hides the thinking text again.
      await tester.tap(stepsRow);
      await tester.pumpAndSettle();
      expect(find.text('First I will inspect the auth flow.'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('shows a ticking working indicator while a turn is live', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final startedAt = DateTime.now()
          .subtract(const Duration(seconds: 65))
          .millisecondsSinceEpoch;
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          const RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Ship the fix',
          ),
          RemoteChatMessage(
            messageId: 'u-1:turn-timer',
            chatId: 'chat-a',
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(
                kind: 'turn_timer',
                data: {'startedAt': startedAt, 'completedAt': null},
              ),
            ],
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // Live turn: the working row shows with the elapsed time (~1:05) and no
      // ghost bubble is rendered for the timer-only system message.
      final indicator = find.byKey(
        const ValueKey('remote-chat-working-indicator'),
      );
      expect(indicator, findsOneWidget);
      expect(find.textContaining('Working... 1:0'), findsOneWidget);

      // The periodic tick keeps the row alive without pending-timer errors.
      await tester.pump(const Duration(seconds: 2));
      expect(indicator, findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('a running turn shows every step inline until it completes', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final startedAt = DateTime.now()
          .subtract(const Duration(seconds: 10))
          .millisecondsSinceEpoch;
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          const RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Refactor the login flow',
          ),
          const RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: '',
            parts: [
              ChatPart(
                kind: 'thinking',
                data: {'text': 'An older thought from step one.'},
              ),
              ChatPart(
                kind: 'tool_use',
                toolFamily: 'bash',
                data: {'toolName': 'Bash'},
              ),
            ],
          ),
          const RemoteChatMessage(
            messageId: 'a-2',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(
                kind: 'thinking',
                data: {'text': 'The very latest thought.'},
              ),
            ],
          ),
          RemoteChatMessage(
            messageId: 'u-1:turn-timer',
            chatId: 'chat-a',
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(
                kind: 'turn_timer',
                data: {'startedAt': startedAt, 'completedAt': null},
              ),
            ],
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      // Let the feed complete its initial bottom alignment. The live timer
      // intentionally prevents settle().
      await tester.pump();
      await tester.pump();
      await tester.pump();

      // Desktop parity: while the turn runs there is no steps row — every
      // thought and tool row is inline, and the working row does not
      // duplicate the newest thought.
      expect(find.byKey(const ValueKey('turn-steps-u-1')), findsNothing);
      expect(find.text('The very latest thought.'), findsOneWidget);
      expect(find.text('An older thought from step one.'), findsOneWidget);
      expect(find.textContaining('Working...'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('a running turn shows long thinking as a one-line preview', (
      tester,
    ) async {
      usePhoneViewport(tester);
      const thought =
          'I will start by reading the auth flow, then trace the badge '
          'visibility through the router before touching any tests.';
      final startedAt = DateTime.now()
          .subtract(const Duration(seconds: 10))
          .millisecondsSinceEpoch;
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          const RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Refactor the login flow',
          ),
          const RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(kind: 'thinking', data: {'text': thought}),
            ],
          ),
          RemoteChatMessage(
            messageId: 'u-1:turn-timer',
            chatId: 'chat-a',
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(
                kind: 'turn_timer',
                data: {'startedAt': startedAt, 'completedAt': null},
              ),
            ],
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      // The live timer intentionally prevents settle().
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(find.text('Thinking'), findsOneWidget);
      expect(find.text('${thought.substring(0, 80)}…'), findsOneWidget);
      expect(find.text(thought), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('shows the authoritative queued-message count below the feed', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final semantics = tester.ensureSemantics();
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': const [],
          'worktrees': [
            {'localId': 'wt-1', 'workspaceLocalId': 'ws-1', 'branch': 'main'},
          ],
          'standaloneChats': const [],
          'chatSummaries': [
            {
              'chatId': 'chat-1',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Queued chat',
              'active': true,
              'turnActive': true,
              'queuedMessages': [
                {
                  'id': 'queue-1',
                  'text': 'First follow-up',
                  'origin': 'portal',
                  'enqueuedAtMs': 1,
                },
                {
                  'id': 'queue-2',
                  'text': 'Second follow-up',
                  'origin': 'portal',
                  'enqueuedAtMs': 2,
                },
              ],
            },
          ],
          'chatMessages': [
            {
              'localMessageId': 'user-root',
              'localChatId': 'chat-1',
              'role': 'user',
              'status': 'complete',
              'content': 'Keep working',
              'scope': 'worktree',
            },
          ],
        });
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();

      final queueStatus = find.byKey(const ValueKey('chat-queue-status'));
      expect(queueStatus, findsOneWidget);
      expect(find.text('2 messages queued'), findsOneWidget);
      await tester.ensureVisible(queueStatus);
      await tester.pump();
      expect(find.bySemanticsLabel('2 messages queued'), findsOneWidget);
      expect(find.text('First follow-up'), findsNothing);
      expect(find.text('Second follow-up'), findsNothing);
      semantics.dispose();
      viewModel.dispose();
      await repository.eventsController.close();
    });

    testWidgets('replaces the working indicator when the turn completes', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final startedAt = DateTime.now()
          .subtract(const Duration(seconds: 90))
          .millisecondsSinceEpoch;
      final completedAt = DateTime.now()
          .subtract(const Duration(seconds: 30))
          .millisecondsSinceEpoch;
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          const RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Ship the fix',
          ),
          RemoteChatMessage(
            messageId: 'u-1:turn-timer',
            chatId: 'chat-a',
            role: ChatRole.system,
            status: ChatMessageStatus.complete,
            text: '',
            parts: [
              ChatPart(
                kind: 'turn_timer',
                data: {'startedAt': startedAt, 'completedAt': completedAt},
              ),
            ],
          ),
          const RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Done.',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('remote-chat-working-indicator')),
        findsNothing,
      );
      expect(find.textContaining('Working...'), findsNothing);
      expect(
        find.byKey(const ValueKey('remote-chat-completed-indicator')),
        findsOneWidget,
      );
      expect(find.text('Completed in 1:00'), findsOneWidget);
      expect(find.text('Done.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    for (final projectTurn in [true, false]) {
      testWidgets(
        'new active tab stays idle beside running chat ($projectTurn)',
        (tester) async {
          usePhoneViewport(tester);
          final repository = FakeRemoteControlRepository();
          RemoteChatSummary summary(
            String id, {
            required bool active,
            String? model,
          }) => RemoteChatSummary.fromJson({
            'chatId': id,
            'scope': 'worktree',
            'workspaceLocalId': 'ws-1',
            'worktreeLocalId': 'wt-1',
            'title': id == 'chat-a' ? 'Chat A' : 'New chat',
            'active': active,
            if (projectTurn) 'turnActive': id == 'chat-a',
            'model': ?model,
            if (projectTurn || id == 'chat-a')
              'availableModels': [
                {
                  'id': 'gpt-5-codex',
                  'label': 'GPT-5 Codex',
                  'provider': 'codex',
                  'kind': 'model',
                  'available': true,
                  'isDefault': true,
                },
                {
                  'id': 'claude-sonnet',
                  'label': 'Claude Sonnet',
                  'provider': 'claude',
                  'kind': 'model',
                  'available': true,
                },
              ],
            if (id == 'chat-a')
              'providerAvailability': {'claude': true, 'codex': false},
          });
          repository.snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: const [],
            standaloneChats: const [],
            worktrees: const [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
                isStreaming: true,
              ),
            ],
            chatSummaries: [summary('chat-a', active: true)],
            chatMessages: const [
              RemoteChatMessage(
                messageId: 'a-1',
                chatId: 'chat-a',
                role: ChatRole.assistant,
                status: ChatMessageStatus.streaming,
                text: 'Running in Chat A',
              ),
            ],
          );
          final vm = RemoteControlViewModel(repository: repository);

          await tester.runAsync(() => vm.connect('123456'));
          await tester.pumpWidget(
            buildSubject(
              vm,
              RemoteChatScreen.worktree(
                worktree: vm.worktreesFor('ws-1').single,
              ),
            ),
          );
          await tester.pump();
          expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
          await tester.startNewChatFromSheet();
          final id = repository.createChatTabTargets.single.chatId!;
          expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
          // The desktop catalog is already known before this tab's first
          // summary arrives. Its default should appear immediately.
          expect(find.text('GPT-5 Codex'), findsOneWidget);
          expect(repository.lastSetModel, isNull);
          await tester.tap(find.byKey(const ValueKey('composer-model')));
          await tester.pump(const Duration(milliseconds: 500));
          expect(
            tester
                .widget<CanopyModelRow>(
                  find.byKey(const ValueKey('model-option-gpt-5-codex')),
                )
                .enabled,
            isFalse,
          );
          Navigator.of(
            tester.element(
              find.byKey(const ValueKey('model-option-gpt-5-codex')),
            ),
          ).pop();
          await tester.pump(const Duration(milliseconds: 500));
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(
                  scope: 'worktree',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                  chatSummaries: [
                    summary('chat-a', active: false),
                    summary(id, active: true),
                  ],
                ),
              ],
              nextCursor: 2,
            ),
          );
          await tester.pump();
          expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
          expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
          expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
          expect(find.text('GPT-5 Codex'), findsOneWidget);
          // A later desktop selection still replaces the displayed default.
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(
                  scope: 'worktree',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                  chatSummaries: [
                    summary('chat-a', active: false),
                    summary(id, active: true, model: 'claude-sonnet'),
                  ],
                ),
              ],
              nextCursor: 3,
            ),
          );
          await tester.pump();
          expect(find.text('Claude Sonnet'), findsOneWidget);
          await tester.selectTabFromSheet('Chat A');
          expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
          expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
          vm.dispose();
        },
      );
    }

    for (final mode in [ThemeMode.light, ThemeMode.dark]) {
      testWidgets(
        'an idle send survives a pre-send snapshot in ${mode.name} mode',
        (tester) async {
          usePhoneViewport(tester);
          RemoteChatMessage row(
            String id, {
            ChatRole role = ChatRole.assistant,
            String text = 'Earlier reply',
            ChatMessageStatus status = ChatMessageStatus.complete,
            List<ChatPart> parts = const [],
          }) => RemoteChatMessage(
            messageId: id,
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            role: role,
            text: text,
            status: status,
            parts: parts,
          );
          final repository = FakeRemoteControlRepository();
          repository.snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Idle chat',
                turnActive: false,
              ),
            ],
          );
          final vm = RemoteControlViewModel(repository: repository);
          await tester.runAsync(() => vm.connect('123456'));
          addTearDown(() async {
            await tester.pumpWidget(const SizedBox());
            vm.dispose();
          });
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
                theme: AppTheme.light,
                darkTheme: AppTheme.dark,
                themeMode: mode,
                home: RemoteChatScreen.worktree(
                  worktree: vm.allWorktrees.single,
                  initialChatId: 'chat-1',
                ),
              ),
            ),
          );
          await tester.pump();
          expect(
            repository.requestChatTranscriptCalls,
            1,
            reason: 'Screen requested its transcript before Send',
          );

          await tester.enterText(
            find.byKey(const ValueKey('composer-draft')),
            'continue',
          );
          await tester.pump();
          await tester.tap(find.byKey(const ValueKey('composer-send')));
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 20)),
          );
          await tester.pump();
          expect(repository.sendChatMessageCalls, hasLength(1));
          final id =
              repository.sendChatMessageCalls.single.options!.userMessageId!;
          expect(find.text('continue'), findsOneWidget);
          final working = find.byKey(
            const ValueKey('remote-chat-working-indicator'),
          );
          expect(working, findsOneWidget);

          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteChatMessageEvent(
                  chatId: 'chat-1',
                  scope: RemoteChatScope.worktree,
                  message: row(id, role: ChatRole.user, text: 'continue'),
                ),
                RemoteChatMessageEvent(
                  chatId: 'chat-1',
                  scope: RemoteChatScope.worktree,
                  message: row(
                    'timer',
                    role: ChatRole.system,
                    text: '',
                    status: ChatMessageStatus.streaming,
                    parts: [
                      ChatPart(
                        kind: 'turn_timer',
                        data: {
                          'startedAt': DateTime.now().millisecondsSinceEpoch,
                          'completedAt': null,
                        },
                      ),
                    ],
                  ),
                ),
              ],
              nextCursor: 1,
            ),
          );
          await tester.pump();
          expect(find.text('continue'), findsOneWidget);
          expect(working, findsOneWidget);

          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(
                  scope: 'chat',
                  selectedChatOnly: true,
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                  targetChatId: 'chat-1',
                  targetChatScope: RemoteChatScope.worktree,
                  chatSummaries: const [
                    RemoteChatSummary(
                      chatId: 'chat-1',
                      scope: RemoteChatScope.worktree,
                      workspaceLocalId: 'ws-1',
                      worktreeLocalId: 'wt-1',
                      title: 'Idle chat',
                      turnActive: false,
                    ),
                  ],
                  chatMessages: [row('earlier')],
                ),
              ],
              nextCursor: 2,
            ),
          );
          await tester.pump();
          await tester.pump();
          expect(tester.takeException(), isNull);
          expect(find.text('continue'), findsOneWidget);
          expect(working, findsOneWidget);
        },
      );
    }

    testWidgets(
      'a stale foreground snapshot does not pull a new tab back to the old chat',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        const chatA = RemoteChatSummary(
          chatId: 'chat-a',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
        );
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
          chatSummaries: const [chatA],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-a',
            ),
          ),
        );
        await tester.pump();

        // Chat A's transcript is still loading when the user opens a tab.
        await tester.startNewChatFromSheet();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();
        final mintedId = repository.createChatTabTargets.single.chatId!;
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Typed into the new tab',
        );
        await tester.pump();

        // The desktop projects the new tab, then delivers chat A's foreground
        // snapshot whose tab list was read before the new tab existed.
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteStateDeltaEvent(
                chatSummaries: [
                  const RemoteChatSummary(
                    chatId: 'chat-a',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Chat A',
                  ),
                  RemoteChatSummary(
                    chatId: mintedId,
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'New chat',
                    active: true,
                  ),
                ],
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                selectedChatOnly: true,
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
                targetChatId: 'chat-a',
                targetChatScope: RemoteChatScope.worktree,
                chatSummaries: [chatA],
                chatMessages: [
                  RemoteChatMessage(
                    messageId: 'a-1',
                    chatId: 'chat-a',
                    role: ChatRole.assistant,
                    status: ChatMessageStatus.complete,
                    text: 'Answer in chat A',
                  ),
                ],
              ),
            ],
            nextCursor: 3,
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Answer in chat A'), findsNothing);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          'Typed into the new tab',
        );
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets('creates a new conversation from the sheet', (tester) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [
          RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Answer in chat A',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();
      expect(find.text('Answer in chat A'), findsOneWidget);

      // "New chat" mints a chat id client-side, selects it, and fires the
      // web-parity `portal.chat.create_tab` command (no desktop-side minting).
      await tester.startNewChatFromSheet();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
      expect(repository.createChatTabTargets, hasLength(1));
      final mintedId = repository.createChatTabTargets.single.chatId;
      expect(mintedId, isNotNull);
      expect(mintedId, isNotEmpty);
      expect(find.text('Answer in chat A'), findsNothing);
      expect(
        find.text('New conversation — send a message to start it.'),
        findsOneWidget,
      );
      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Keep after rejection',
      );
      await tester.pump();

      // An asynchronous desktop rejection reconciles the retained command id
      // and rolls the provisional selection back to the active projected tab.
      repository.eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The tab could not be created.',
              commandId: repository.createChatTabCommandIds.single,
            ),
          ],
          nextCursor: 2,
        ),
      );
      await tester.pump();
      expect(find.text('Answer in chat A'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
            .controller!
            .text,
        'Keep after rejection',
      );

      // Switching back to an existing tab restores its transcript.
      await tester.selectTabFromSheet('Chat A');
      expect(find.text('Answer in chat A'), findsOneWidget);

      // A fresh "New chat" mints a new id; sending targets it directly, so
      // the optimistic user bubble renders immediately.
      await tester.startNewChatFromSheet();
      expect(repository.createChatTabTargets, hasLength(2));
      await tester.enterText(find.byType(TextField), 'Start something new');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();

      expect(find.text('Start something new'), findsOneWidget);
      expect(find.text('Answer in chat A'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets(
      'new tabs survive selection and reconcile confirmation or transport failure',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _DeferredCreateChatRepository();
        String? confirmedId;
        repository.snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': [],
          'worktrees': [
            {'localId': 'wt-1', 'workspaceLocalId': 'ws-1', 'branch': 'main'},
          ],
          'standaloneChats': [],
          'chatSummaries': [
            {
              'chatId': 'chat-a',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat A',
              'active': true,
            },
            if (confirmedId != null)
              {
                'chatId': confirmedId,
                'scope': 'worktree',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'title': 'Saved',
              },
          ],
        });
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        final hydrationCalls = repository.requestChatTranscriptCalls;

        // Inside the sheet the provisional tab's own title is also "New
        // chat", which is the action button's label too — assert through the
        // row key so the two can never be confused.
        Finder titleOf(Finder row, String title) =>
            find.descendant(of: row, matching: find.text(title));
        bool isSelected(Finder row) => tester.widget<ListTile>(row).selected;

        await tester.startNewChatFromSheet();
        final firstId = repository.createChatTabTargets.single.chatId!;
        final firstTab = find.byKey(ValueKey('chat-tab-$firstId'));
        await tester.openTabsSheet();
        expect(titleOf(firstTab, 'New chat'), findsOneWidget);
        expect(isSelected(firstTab), isTrue);
        expect(repository.requestChatTranscriptCalls, hydrationCalls);

        await tester.tap(find.text('Chat A'));
        await tester.settleSheetDismiss();
        await tester.openTabsSheet();
        expect(titleOf(firstTab, 'New chat'), findsOneWidget);
        await tester.tap(firstTab);
        await tester.settleSheetDismiss();
        await tester.openTabsSheet();
        expect(isSelected(firstTab), isTrue);
        await tester.dismissTabsSheet();

        repository.completeCreate(0, 'create-1');
        await tester.pump();
        await tester.runAsync(() => vm.refresh());
        await tester.pump();
        await tester.openTabsSheet();
        expect(titleOf(firstTab, 'New chat'), findsOneWidget);
        await tester.dismissTabsSheet();

        // Once the desktop projects the tab, the provisional row is replaced
        // by the real one without losing the selection.
        confirmedId = firstId;
        await tester.runAsync(() => vm.refresh());
        await tester.pump();
        await tester.openTabsSheet();
        expect(firstTab, findsOneWidget);
        expect(titleOf(firstTab, 'New chat'), findsNothing);
        expect(titleOf(firstTab, 'Saved'), findsOneWidget);
        expect(isSelected(firstTab), isTrue);
        await tester.dismissTabsSheet();

        await tester.startNewChatFromSheet();
        final secondId = repository.createChatTabTargets.last.chatId!;
        final secondTab = find.byKey(ValueKey('chat-tab-$secondId'));
        await tester.openTabsSheet();
        expect(titleOf(secondTab, 'New chat'), findsOneWidget);
        await tester.tap(find.text('Chat A'));
        await tester.finishSheetDismiss();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Earlier draft',
        );
        await tester.pump();

        await tester.openTabsSheet();
        await tester.tap(secondTab);
        await tester.finishSheetDismiss();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Keep this thought',
        );
        await tester.pump();

        repository.failCreate(1);
        await tester.pump();
        expect(find.text('Creation unavailable.'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('composer-draft')))
              .controller!
              .text,
          'Keep this thought\nEarlier draft',
        );
        await tester.openTabsSheet();
        expect(secondTab, findsNothing);
        expect(
          isSelected(find.byKey(const ValueKey('chat-tab-chat-a'))),
          isTrue,
        );
        await tester.dismissTabsSheet();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      },
    );

    testWidgets(
      'restores staged attachments when provisional chat creation fails',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final sendCompleter = Completer<RemoteChatSendResult>();
        repository.sendChatMessageHandler = () => sendCompleter.future;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: viewModel.allWorktrees.single,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();

        await tester.startNewChatFromSheet();

        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);

        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Send with a file',
        );
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
        expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);

        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The tab could not be created.',
                commandId: repository.createChatTabCommandIds.single,
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.pump();
        await tester.pump();

        sendCompleter.completeError(
          const RemoteControlException('The send failed.'),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets(
      'restores provisional-chat attachments after screen recreation',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final sendCompleter = Completer<RemoteChatSendResult>();
        repository.sendChatMessageHandler = () => sendCompleter.future;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.allWorktrees.single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();
        await tester.startNewChatFromSheet();
        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Send with a file',
        );
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();

        sendCompleter.complete(
          RemoteChatSendResult(
            commandId: 'send-1',
            chatId: repository.createChatTabTargets.single.chatId,
          ),
        );
        await tester.pump();
        await tester.pumpWidget(const SizedBox());

        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The tab could not be created.',
                commandId: repository.createChatTabCommandIds.single,
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              attachmentPicker: _SingleFileAttachmentPicker(),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets(
      'restores staged attachments when submission fails after disposal',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsChatAttachments = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: true,
              ),
            ],
          );
        final sendCompleter = Completer<RemoteChatSendResult>();
        repository.sendChatMessageHandler = () => sendCompleter.future;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.allWorktrees.single;

        Widget screen() => buildSubject(
          viewModel,
          RemoteChatScreen.worktree(
            worktree: worktree,
            attachmentPicker: _SingleFileAttachmentPicker(),
          ),
        );

        await tester.pumpWidget(screen());
        await tester.pump();
        await openComposerActions(tester);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-action-attach-files')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('composer-draft')),
          'Send with a file',
        );
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        expect(find.byKey(const ValueKey('attachment-strip')), findsNothing);
        expect(
          viewModel.pendingChatAttachmentsFor(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              chatId: 'chat-a',
            ),
          ),
          hasLength(1),
        );

        await tester.pumpWidget(const SizedBox());
        sendCompleter.completeError(
          const RemoteControlException('The send failed.'),
        );
        await tester.pump();

        await tester.pumpWidget(screen());
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('attachment-strip')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
        await repository.eventsController.close();
      },
    );

    testWidgets('ignores stale create-tab failures from an older request', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _DeferredCreateChatRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          RemoteChatMessage(
            messageId: 'a-1',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Answer in chat A',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();

      await tester.startNewChatFromSheet();
      final firstId = repository.createChatTabTargets.single.chatId!;
      repository.completeCreate(0, 'create-1');
      await tester.pump();

      await tester.startNewChatFromSheet();
      expect(repository.createChatTabTargets, hasLength(2));
      final secondId = repository.createChatTabTargets.last.chatId!;
      // Both provisional tabs are listed. (The sheet's own action button is
      // also labelled "New chat", so match the rows by key, not by text.)
      await tester.openTabsSheet();
      expect(find.byKey(ValueKey('chat-tab-$firstId')), findsOneWidget);
      expect(find.byKey(ValueKey('chat-tab-$secondId')), findsOneWidget);
      await tester.dismissTabsSheet();

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The stale tab failed.',
              commandId: 'create-1',
            ),
          ],
          nextCursor: 2,
        ),
      );
      await tester.pump();
      expect(
        find.text('New conversation — send a message to start it.'),
        findsOneWidget,
      );
      expect(find.text('Answer in chat A'), findsNothing);

      repository.completeCreate(1, 'create-2');
      await tester.pump();

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The active tab failed.',
              commandId: 'create-2',
            ),
          ],
          nextCursor: 3,
        ),
      );
      // A real-async turn: the deferred completer's continuation has to run
      // before the view model can claim `create-2` as its own command and
      // reconcile the failure event against it. Zero-duration pumps alone do
      // not get there.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();
      expect(find.text('The active tab failed.'), findsOneWidget);
      expect(find.text('Answer in chat A'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    RemoteSessionSnapshot twoTabSnapshot() => const RemoteSessionSnapshot(
      workspaces: [],
      worktrees: [
        RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        ),
      ],
      standaloneChats: [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-a',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat A',
          active: true,
        ),
        RemoteChatSummary(
          chatId: 'chat-b',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat B',
        ),
      ],
      chatMessages: [
        RemoteChatMessage(
          messageId: 'a-1',
          chatId: 'chat-a',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Answer in chat A',
        ),
        RemoteChatMessage(
          messageId: 'b-1',
          chatId: 'chat-b',
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Answer in chat B',
        ),
      ],
    );

    testWidgets('previous session create cannot change the replacement chat', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _DeferredCreateChatRepository()
        ..snapshotBuilder = twoTabSnapshot;
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
        ),
      );
      await tester.pump();
      await tester.startNewChatFromSheet();
      final mintedId = repository.createChatTabTargets.single.chatId!;

      await tester.runAsync(viewModel.disconnect);
      await tester.runAsync(() => viewModel.connect('654321'));
      await tester.pump();

      // The old session's acknowledgement and terminal event arrive after
      // the replacement session is live.
      repository.completeCreate(0, 'old-create');
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The old tab failed.',
              commandId: 'old-create',
            ),
          ],
          nextCursor: 2,
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 5)),
      );
      await tester.pump();

      expect(find.text('The old tab failed.'), findsNothing);
      expect(find.byType(CommandFailureBanner), findsNothing);
      expect(
        find.text('New conversation — send a message to start it.'),
        findsOneWidget,
      );
      await tester.openTabsSheet();
      expect(find.byKey(ValueKey('chat-tab-$mintedId')), findsOneWidget);
      await tester.dismissTabsSheet();
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      viewModel.dispose();
    });

    testWidgets(
      'previous session close cannot change the replacement selection',
      (tester) async {
        usePhoneViewport(tester);
        final closeResponse = Completer<void>();
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoTabSnapshot
          ..beforeCloseChatTab = (() => closeResponse.future);
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();
        expect(find.text('Answer in chat A'), findsOneWidget);

        await tester.closeTabFromSheet('chat-a');
        await tester.pump();
        expect(find.text('Answer in chat A'), findsNothing);

        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();

        // The replacement session still projects chat A: the old close can no
        // longer settle, so it must not keep hiding the tab.
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsOneWidget);
        await tester.dismissTabsSheet();
        await tester.selectTabFromSheet('Chat B');
        await tester.finishSheetDismiss();
        expect(find.text('Answer in chat B'), findsOneWidget);

        closeResponse.complete();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The old close failed.',
                commandId: repository.closeChatTabCommandIds.single,
              ),
            ],
            nextCursor: 2,
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();

        expect(find.text('The old close failed.'), findsNothing);
        expect(find.text('Answer in chat B'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
      },
    );

    testWidgets(
      'previous session create transport failure shows no error in the '
      'replacement session',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _DeferredCreateChatRepository()
          ..snapshotBuilder = twoTabSnapshot;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.startNewChatFromSheet();
        final mintedId = repository.createChatTabTargets.single.chatId!;

        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();

        // The old session's submission is rejected after the replacement
        // session is live.
        repository.failCreate(0);
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();

        expect(find.text('Creation unavailable.'), findsNothing);
        expect(find.byType(SnackBar), findsNothing);
        expect(
          find.text('New conversation — send a message to start it.'),
          findsOneWidget,
        );
        await tester.openTabsSheet();
        expect(find.byKey(ValueKey('chat-tab-$mintedId')), findsOneWidget);
        await tester.dismissTabsSheet();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
      },
    );

    testWidgets(
      'previous session close transport failure shows no error in the '
      'replacement session',
      (tester) async {
        usePhoneViewport(tester);
        final closeResponse = Completer<void>();
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoTabSnapshot
          ..beforeCloseChatTab = (() => closeResponse.future);
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.closeTabFromSheet('chat-a');
        await tester.pump();

        await tester.runAsync(viewModel.disconnect);
        await tester.runAsync(() => viewModel.connect('654321'));
        await tester.pump();
        await tester.selectTabFromSheet('Chat B');
        await tester.finishSheetDismiss();
        expect(find.text('Answer in chat B'), findsOneWidget);

        // The old session's submission is rejected after the replacement
        // session is live.
        closeResponse.completeError(
          const RemoteControlException('The old close failed.'),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();

        expect(find.text('The old close failed.'), findsNothing);
        expect(find.byType(SnackBar), findsNothing);
        expect(find.text('Answer in chat B'), findsOneWidget);
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsOneWidget);
        await tester.dismissTabsSheet();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
      },
    );

    for (final scope in RemoteChatScope.values) {
      for (final cachedEcho in [false, true]) {
        testWidgets(
          'lock and unlock reconciles a lost send acknowledgement ($scope, $cachedEcho)',
          (tester) async {
            usePhoneViewport(tester);
            final completion = Completer<RemoteChatSendResult>();
            final repo = FakeRemoteControlRepository()
              ..sendChatMessageHandler = () => completion.future;
            final vm = RemoteControlViewModel(repository: repo);
            await vm.connect('123456');
            await tester.pumpWidget(
              buildSubject(
                vm,
                scope == RemoteChatScope.worktree
                    ? const RemoteChatScreen.worktree(
                        worktree: RemoteWorktree(
                          localId: 'wt-1',
                          workspaceLocalId: 'ws-1',
                          branch: 'main',
                        ),
                        initialChatId: 'chat-1',
                      )
                    : const RemoteChatScreen.standalone(
                        standaloneChat: RemoteStandaloneChat(
                          localId: 'chat-1',
                          projectLocalId: 'ws-1',
                          title: 'Chat',
                        ),
                      ),
              ),
            );
            await tester.pump();
            final input = find.byKey(const ValueKey('composer-draft'));
            await tester.enterText(input, 'Deploy the fix');
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            await tester.pump();
            final echo = RemoteChatMessage(
              messageId:
                  repo.sendChatMessageCalls.single.options!.userMessageId!,
              chatId: 'chat-1',
              scope: scope,
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              text: 'Deploy the fix',
            );
            if (!cachedEcho) {
              repo.eventsController.add(
                RemotePortalEventBatch(
                  nextCursor: 1,
                  events: [
                    RemoteChatMessageEvent(
                      chatId: 'chat-1',
                      scope: scope,
                      message: echo,
                    ),
                  ],
                ),
              );
              await tester.pump();
            }
            tester.binding.handleAppLifecycleStateChanged(
              AppLifecycleState.paused,
            );
            vm.onAppBackgrounded();
            completion.completeError(
              const RemoteChatSendOutcomeUnknownException(
                'Could not reach the server. Check your connection and try again.',
              ),
            );
            await tester.pump();
            if (cachedEcho) repo.cachedChatMessages = [echo];
            for (final state in [
              AppLifecycleState.hidden,
              AppLifecycleState.inactive,
              AppLifecycleState.resumed,
            ]) {
              tester.binding.handleAppLifecycleStateChanged(state);
            }
            await vm.onAppForegrounded();
            await tester.pump();
            expect(tester.widget<TextField>(input).controller!.text, isEmpty);
            expect(
              find.text(
                'Could not reach the server. Check your connection and try again.',
              ),
              findsNothing,
            );
            expect(
              vm
                  .messagesFor(repo.sendChatMessageCalls.single.target)
                  .single
                  .messageId,
              echo.messageId,
            );
            expect(repo.sendChatMessageCalls, hasLength(1));
            await tester.pumpWidget(const SizedBox.shrink());
            vm.dispose();
          },
        );
      }
    }
    testWidgets(
      'a delayed host echo confirms the first message after its acknowledgement is lost',
      (tester) async {
        usePhoneViewport(tester);
        final completion = Completer<RemoteChatSendResult>();
        final repo = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
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
        repo.sendChatMessageHandler = () => completion.future;
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        repo.eventsController.add(
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
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isFalse,
        );
        final input = find.byKey(const ValueKey('composer-draft'));
        await tester.enterText(input, 'Start the investigation');
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('composer-send')));
        await tester.pump();
        // A text send to a worktree without tabs mints its chat client-side.
        final chatId = repo.sendChatMessageCalls.single.target.chatId!;
        expect(chatId, startsWith('chat-m'));
        expect(repo.createChatTabTargets.single.chatId, chatId);
        final messageId =
            repo.sendChatMessageCalls.single.options!.userMessageId!;

        completion.completeError(
          const RemoteChatSendOutcomeUnknownException('Connection interrupted'),
        );
        await tester.pump();
        repo.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteChatMessageEvent(
                chatId: chatId,
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage(
                  messageId: messageId,
                  chatId: chatId,
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  text: 'Start the investigation',
                ),
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));

        expect(tester.widget<TextField>(input).controller!.text, isEmpty);
        expect(repo.sendChatMessageCalls, hasLength(1));
        final row = vm
            .messagesFor(
              RemoteWorktreeChatTarget(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                chatId: chatId,
              ),
            )
            .single;
        expect(row.messageId, messageId);
        expect(row.delivery, isNull);
        await tester.pumpWidget(const SizedBox.shrink());
        vm.dispose();
      },
    );
    for (final fails in [false, true]) {
      for (final nextDraft in ['', 'Next message']) {
        testWidgets(
          'clears draft immediately and preserves next draft ($fails, $nextDraft)',
          (tester) async {
            usePhoneViewport(tester);
            final completion = Completer<RemoteChatSendResult>();
            final repo = FakeRemoteControlRepository()
              ..sendChatMessageHandler = () => completion.future;
            final vm = RemoteControlViewModel(repository: repo);
            await vm.connect('123456');
            await tester.pumpWidget(
              buildSubject(
                vm,
                const RemoteChatScreen.standalone(
                  standaloneChat: RemoteStandaloneChat(
                    localId: 'chat-1',
                    projectLocalId: 'ws-1',
                    title: 'Chat',
                  ),
                ),
              ),
            );
            await tester.pump();
            final input = find.byKey(const ValueKey('composer-draft'));
            await tester.enterText(input, '  Deploy the fix  ');
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('composer-send')));
            expect(tester.widget<TextField>(input).controller!.text, isEmpty);
            expect(repo.sendChatMessageCalls.single.text, 'Deploy the fix');
            if (nextDraft.isNotEmpty) {
              await tester.enterText(input, nextDraft);
            }
            if (fails) {
              completion.completeError(
                const RemoteControlException('Send failed'),
              );
            } else {
              completion.complete(
                const RemoteChatSendResult(commandId: '', chatId: 'chat-1'),
              );
            }
            await tester.pump();
            // A failed text send stays in the transcript as a not-sent row;
            // the composer keeps only what the user typed afterwards.
            expect(tester.widget<TextField>(input).controller!.text, nextDraft);
            if (fails) {
              expect(find.text('Not sent'), findsOneWidget);
              expect(find.text('Send failed'), findsOneWidget);
              expect(find.byType(SnackBar), findsNothing);
            }
            await tester.pumpWidget(const SizedBox.shrink());
            vm.dispose();
          },
        );
      }
    }

    testWidgets('sends a message and streams the scripted reply', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(worktree: worktreeWithChats(viewModel)),
        ),
      );
      // The timed pump advances the fake clock so the mock's zero-latency
      // transcript request fires instead of leaking as a pending timer.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      await tester.enterText(find.byType(TextField), 'Deploy the fix');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      // Let the send round-trip and the scripted reply timers run for real.
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(find.text('Deploy the fix'), findsOneWidget);
      expect(
        find.textContaining('the diff is ready for review'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('standalone chats render their transcript', (tester) async {
      usePhoneViewport(tester);
      final viewModel = await connectedViewModel(tester);
      final projectedChat = viewModel
          .standaloneChatsFor('ws-app')
          .firstWhere((c) => c.localId == 'chat-arch');
      final chat = RemoteStandaloneChat(
        localId: projectedChat.localId,
        projectLocalId: projectedChat.projectLocalId,
        title: 'Raw chat title',
        description: '  ',
        workEntryTitle: 'Executor architecture',
      );

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.standalone(standaloneChat: chat),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('How should we break the executor circular dependency?'),
        findsOneWidget,
      );
      expect(find.textContaining('dynamic import'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.text('Executor architecture'),
        ),
        findsOneWidget,
      );
      // Standalone chats have no worktree tab chips.
      expect(find.text('PKCE implementation'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'selection stays latched across active-tab moves but falls back if removed',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        var activeChatId = 'chat-a';
        var includeChatA = true;
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
            if (includeChatA)
              RemoteChatSummary(
                chatId: 'chat-a',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Chat A',
                active: activeChatId == 'chat-a',
              ),
            RemoteChatSummary(
              chatId: 'chat-b',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
              active: activeChatId == 'chat-b',
            ),
          ],
          chatMessages: const [
            RemoteChatMessage(
              messageId: 'a-1',
              chatId: 'chat-a',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Answer in chat A',
            ),
            RemoteChatMessage(
              messageId: 'b-1',
              chatId: 'chat-b',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Answer in chat B',
            ),
          ],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pump();
        expect(find.text('Answer in chat A'), findsOneWidget);

        // The desktop's active tab moves to chat B; the open conversation
        // must not flip out from under the reader.
        activeChatId = 'chat-b';
        await tester.runAsync(() => viewModel.refresh());
        await tester.pump();

        expect(find.text('Answer in chat A'), findsOneWidget);
        expect(find.text('Answer in chat B'), findsNothing);

        expect(
          viewModel.isStreamingForChat(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              chatId: 'chat-a',
            ),
          ),
          isFalse,
        );

        // A transport failure leaves the selected tab and transcript intact.
        repository.closeChatTabError = const RemoteControlException(
          'Close failed',
        );
        await tester.closeTabFromSheet('chat-a');
        await tester.pump();
        expect(find.text('Close failed'), findsOneWidget);
        expect(find.text('Answer in chat A'), findsOneWidget);
        repository.closeChatTabError = null;

        final submission = Completer<void>();
        repository.beforeCloseChatTab = () => submission.future;
        await tester.closeTabFromSheet('chat-a');
        final closeTarget = repository.closeChatTabTargets.last;
        expect(closeTarget.workspaceLocalId, 'ws-1');
        expect(closeTarget.worktreeLocalId, 'wt-1');
        expect(closeTarget.chatId, 'chat-a');
        // Hide immediately while the desktop still projects the old tab.
        expect(find.text('Answer in chat A'), findsNothing);
        expect(find.text('Answer in chat B'), findsOneWidget);
        await viewModel.refresh();
        await tester.pump();
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsNothing);

        // An explicit selection while closing must survive a late rejection.
        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-b')));
        await tester.settleSheetDismiss();
        submission.complete();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.pump();
        repository.beforeCloseChatTab = null;
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                commandId: repository.closeChatTabCommandIds.single,
                message: 'Chat is busy',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pump();
        expect(find.text('Chat is busy'), findsOneWidget);
        expect(find.text('Answer in chat B'), findsOneWidget);
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsOneWidget);
        await tester.tap(find.text('Chat A'));
        await tester.settleSheetDismiss();
        await tester.closeTabFromSheet('chat-a');

        // Once the selected chat disappears from the authoritative list, the
        // screen must fall back instead of targeting and recreating its stale
        // id on the next send.
        includeChatA = false;
        await tester.runAsync(() => viewModel.refresh());
        await tester.pump();
        expect(find.text('Answer in chat A'), findsNothing);
        expect(find.text('Answer in chat B'), findsOneWidget);
        // Closing the last visible tab immediately stops targeting its chat,
        // and with no tabs left the FAB itself goes away.
        await tester.closeTabFromSheet('chat-b');
        expect(find.text('Answer in chat B'), findsNothing);
        expect(find.byKey(const ValueKey('chat-tabs-fab')), findsNothing);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets(
      'cold discovery retries without reopening the chat and offers manual recovery',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _FailingChatHydrationRepository()
          ..supportsForegroundChat = true;
        final vm = RemoteControlViewModel(
          repository: repository,
          hydrationRetryWindow: const Duration(seconds: 1),
        );
        await vm.connect('123456');
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );
        await tester.pumpWidget(
          buildSubject(
            vm,
            Builder(
              builder: (context) => TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        const RemoteChatScreen.worktree(worktree: worktree),
                  ),
                ),
                child: const Text('Open chat'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open chat'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        // CAN-3631: the first failure keeps loading until the retry fails.
        expect(find.text('Loading chats…'), findsOneWidget);
        expect(find.text('Transcript unavailable.'), findsNothing);
        expect(repository.requestChatTranscriptCalls, 1);
        await tester.pump(const Duration(milliseconds: 500));
        await tester.pump(const Duration(milliseconds: 500));
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.text('Transcript unavailable.'), findsOneWidget);
        await tester.enterText(find.byType(TextField), 'Keep my draft');
        await tester.pump();
        expect(
          tester
              .widget<IconButton>(
                find.descendant(
                  of: find.byKey(const ValueKey('composer-send')),
                  matching: find.byType(IconButton),
                ),
              )
              .onPressed,
          isNull,
        );
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 2);
        await tester.pump(const Duration(seconds: 20));
        expect(repository.requestChatTranscriptCalls, 2);
        await tester.tap(find.text('Retry'));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 3);
        repository.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                selectedChatOnly: true,
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.worktree,
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Recovered chat',
                    active: true,
                  ),
                ],
                chatMessages: [
                  RemoteChatMessage(
                    messageId: 'answer',
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    role: ChatRole.assistant,
                    status: ChatMessageStatus.complete,
                    text: 'Recovered conversation',
                  ),
                ],
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Recovered conversation'), findsOneWidget);
        expect(find.text('Retry'), findsNothing);
        await tester.pump(const Duration(seconds: 20));
        expect(repository.requestChatTranscriptCalls, 3);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'CAN-3631 a chat named during the discovery retry delay keeps two attempts',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true;
        final vm = RemoteControlViewModel(
          repository: repository,
          hydrationRetryWindow: const Duration(seconds: 1),
          hydrationTimeout: const Duration(seconds: 2),
        );
        await vm.connect('123456');
        addTearDown(vm.dispose);
        addTearDown(repository.eventsController.close);
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );
        await tester.pumpWidget(
          buildSubject(vm, const RemoteChatScreen.worktree(worktree: worktree)),
        );
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 1);
        await tester.pump(const Duration(seconds: 2));
        expect(find.text('Loading chats…'), findsOneWidget);

        // A summary-only delta names the chat before the retry is due.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateDeltaEvent(
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Named chat',
                    active: true,
                  ),
                ],
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 1);
        expect(find.text('Loading conversation…'), findsOneWidget);

        await tester.pump(const Duration(seconds: 1));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.text('Loading conversation…'), findsOneWidget);
        expect(find.text('Retry'), findsNothing);

        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(
          find.text('The conversation took too long to load. Try again.'),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsOneWidget);
        await tester.pump(const Duration(seconds: 20));
        expect(repository.requestChatTranscriptCalls, 2);

        await tester.tap(find.text('Retry'));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 3);
        expect(find.text('Retry'), findsNothing);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(find.text('Retry'), findsNothing);
        await tester.pump(const Duration(seconds: 1));
        expect(repository.requestChatTranscriptCalls, 4);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(find.text('Retry'), findsOneWidget);
        await tester.pump(const Duration(seconds: 20));
        expect(repository.requestChatTranscriptCalls, 4);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'foreground navigation reads tray data without a full projection request',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true;
        final viewModel = RemoteControlViewModel(repository: repository);
        await tester.runAsync(() => viewModel.connect('123456'));
        const worktree = RemoteWorktree(
          localId: 'wt-cold',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'selected',
            ),
          ),
        );
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 1);
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                selectedChatOnly: true,
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-cold',
                targetChatId: 'selected',
                targetChatScope: RemoteChatScope.worktree,
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'selected',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-cold',
                    title: 'Selected chat',
                    active: true,
                  ),
                ],
                chatMessages: [
                  RemoteChatMessage(
                    messageId: 'answer',
                    chatId: 'selected',
                    role: ChatRole.assistant,
                    status: ChatMessageStatus.complete,
                    text: 'The selected conversation is ready.',
                  ),
                ],
              ),
            ],
            nextCursor: 1,
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(repository.requestWorktreeStateCalls, 0);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(repository.requestChatTranscriptCalls, 1);
        expect(
          find.text('The selected conversation is ready.'),
          findsOneWidget,
        );
        expect(repository.snapshotFetches, 1);
        viewModel.dispose();
      },
    );

    testWidgets(
      'shows a loading state while the transcript round-trips to the desktop',
      (tester) async {
        usePhoneViewport(tester);
        // A fake whose requestChatTranscript never answers with a snapshot
        // event, freezing the hydration in-flight state.
        final repository = FakeRemoteControlRepository();
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));

        const chat = RemoteStandaloneChat(
          localId: 'chat-cold',
          projectLocalId: 'ws-1',
          title: 'Cold chat',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.standalone(standaloneChat: chat),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Loading conversation…'), findsOneWidget);
        expect(find.text('No messages yet.'), findsNothing);
        expect(tester.takeException(), isNull);

        // CAN-3631: the first timeout keeps loading while the automatic
        // retry is due; only the retry's timeout offers Retry.
        await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
        expect(find.text('Loading conversation…'), findsOneWidget);
        expect(find.text('Retry'), findsNothing);
        expect(find.text('No messages yet.'), findsNothing);
        await tester.pump(kRemoteHydrationRetryWindow);
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.text('Loading conversation…'), findsOneWidget);
        expect(find.text('Retry'), findsNothing);
        await tester.pump(kRemoteHydrationTimeout);
        await tester.pump();
        expect(
          find.text('The conversation took too long to load. Try again.'),
          findsOneWidget,
        );
        expect(find.text('Retry'), findsOneWidget);
        expect(find.text('Loading conversation…'), findsNothing);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    for (final timerDuringRead in [false, true]) {
      testWidgets(
        'opening an agent-created tab paints cached messages when its '
        'completion timer arrives ${timerDuringRead ? 'during the read' : 'first'}',
        (tester) async {
          usePhoneViewport(tester);
          final repository = _GatedCachedTranscriptRepository();
          repository.snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'agent-created',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
                title: 'Review changes',
                active: true,
              ),
            ],
          );
          final viewModel = RemoteControlViewModel(repository: repository);
          await tester.runAsync(() => viewModel.connect('123456'));
          void completeTurn() => repository.eventsController.add(
            const RemotePortalEventBatch(
              nextCursor: 1,
              events: [
                RemoteChatMessageEvent(
                  chatId: 'agent-created',
                  scope: RemoteChatScope.worktree,
                  workspaceLocalId: 'ws-1',
                  worktreeLocalId: 'wt-1',
                  message: RemoteChatMessage(
                    messageId: 'timer',
                    chatId: 'agent-created',
                    scope: RemoteChatScope.worktree,
                    role: ChatRole.system,
                    status: ChatMessageStatus.complete,
                    text: '',
                    parts: [
                      ChatPart(
                        kind: 'turn_timer',
                        data: {'startedAt': 1000, 'completedAt': 42000},
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );
          if (!timerDuringRead) {
            completeTurn();
            await tester.pump();
          }
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              RemoteChatScreen.worktree(
                worktree: viewModel.allWorktrees.single,
                initialChatId: 'agent-created',
              ),
            ),
          );
          await tester.pump();
          if (timerDuringRead) {
            completeTurn();
            await tester.pump();
          }
          await tester.pump();
          expect(find.text('Completed in 0:41'), findsOneWidget);
          repository.cachedTail.complete(const [
            RemoteChatMessage(
              messageId: 'prompt',
              chatId: 'agent-created',
              scope: RemoteChatScope.worktree,
              role: ChatRole.user,
              status: ChatMessageStatus.complete,
              text: 'Review the changes',
            ),
            RemoteChatMessage(
              messageId: 'answer',
              chatId: 'agent-created',
              scope: RemoteChatScope.worktree,
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Review finished',
            ),
          ]);
          await tester.pump();
          await tester.pump();
          await tester.pump();
          expect(repository.cachedChatFetches, 1);
          expect(find.text('Review the changes'), findsOneWidget);
          expect(find.text('Review finished'), findsOneWidget);
          expect(find.text('Completed in 0:41'), findsOneWidget);
          expect(repository.requestChatTranscriptCalls, 1);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
          viewModel.dispose();
        },
      );
    }

    testWidgets(
      'paints the server-cached tail while the transcript round-trips',
      (tester) async {
        usePhoneViewport(tester);
        RemoteChatMessage row(
          String id,
          String text, {
          ChatRole role = ChatRole.user,
        }) => RemoteChatMessage(
          messageId: id,
          chatId: 'chat-cold',
          scope: RemoteChatScope.standalone,
          role: role,
          status: ChatMessageStatus.complete,
          text: text,
        );
        final repository = FakeRemoteControlRepository()
          ..cachedChatMessages = [
            row('q1', 'Cached question.'),
            row('a1', 'Cached answer.', role: ChatRole.assistant),
            row('stale', 'Question the desktop no longer has.'),
          ];
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));

        const chat = RemoteStandaloneChat(
          localId: 'chat-cold',
          projectLocalId: 'ws-1',
          title: 'Cold chat',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.standalone(standaloneChat: chat),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(repository.requestChatTranscriptCalls, 1);
        expect(find.text('Cached question.'), findsOneWidget);
        expect(find.text('Cached answer.'), findsOneWidget);
        expect(find.text('Loading conversation…'), findsNothing);

        repository.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-cold',
                targetChatScope: RemoteChatScope.standalone,
                chatMessages: [
                  row('q1', 'Cached question.'),
                  row('a1', 'Cached answer.', role: ChatRole.assistant),
                  row('q2', 'Authoritative follow-up.'),
                ],
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Cached question.'), findsOneWidget);
        expect(find.text('Cached answer.'), findsOneWidget);
        expect(find.text('Authoritative follow-up.'), findsOneWidget);
        expect(find.text('Question the desktop no longer has.'), findsNothing);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    for (final platform in const [TargetPlatform.android, TargetPlatform.iOS]) {
      testWidgets('CAN-3945 a cached tail replaced by the desktop snapshot '
          'stays on the newest message without a scroll animation '
          '(${platform.name})', (tester) async {
        debugDefaultTargetPlatformOverride = platform;
        try {
          usePhoneViewport(tester);
          // Tall early turns and terse late ones: the lazy list's extent
          // estimate is thousands of pixels off until the real end lays out.
          RemoteChatMessage row(int index) => RemoteChatMessage(
            messageId: 'm$index',
            chatId: 'chat-cold',
            scope: RemoteChatScope.standalone,
            role: index.isEven ? ChatRole.user : ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: index < 60
                ? 'Message $index. ${'A long multi-paragraph body. ' * 50}'
                : 'Short message $index.',
          );
          final full = [for (var i = 0; i < 120; i++) row(i)];
          final repository = FakeRemoteControlRepository()
            ..cachedChatMessages = full.sublist(80);
          final viewModel = RemoteControlViewModel(
            repository: repository,
            stateRefreshDebounce: Duration.zero,
          );
          await tester.runAsync(() => viewModel.connect('123456'));

          const chat = RemoteStandaloneChat(
            localId: 'chat-cold',
            projectLocalId: 'ws-1',
            title: 'Cold chat',
          );
          await tester.pumpWidget(
            buildSubject(
              viewModel,
              const RemoteChatScreen.standalone(standaloneChat: chat),
            ),
          );
          await tester.pumpAndSettle();
          expect(find.text('Short message 119.'), findsOneWidget);
          final position = tester
              .widget<ListView>(
                find.byKey(const ValueKey('remote-chat-transcript')),
              )
              .controller!
              .position;
          expect(
            position.maxScrollExtent - position.pixels,
            lessThanOrEqualTo(1),
          );

          final recorded = await recordPaintedScrollFrames(
            tester,
            position,
            () async => repository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 1,
                events: [
                  RemoteStateSnapshotEvent(
                    scope: 'chat',
                    targetChatId: 'chat-cold',
                    targetChatScope: RemoteChatScope.standalone,
                    chatMessages: full,
                  ),
                ],
              ),
            ),
          );

          expectEveryFrameOnNewest(recorded);
          expect(find.text('Short message 119.'), findsOneWidget);
          expect(tester.takeException(), isNull);
          viewModel.dispose();
        } finally {
          debugDefaultTargetPlatformOverride = null;
        }
      });
    }

    // A short chat, one whose 50 kept rows overflow the screen, and one still
    // streaming on the desktop, whose live row lands before it is reopened.
    for (final (rows, liveFirst) in [(2, false), (50, false), (50, true)]) {
      testWidgets(
        'CAN-3373 a recently viewed $rows-row chat paints its persisted tail on '
        'the first frame after a cold start'
        '${liveFirst ? ' when a live row arrives first' : ''}',
        (tester) async {
          usePhoneViewport(tester);
          const chat = RemoteStandaloneChat(
            localId: 'chat-cold',
            projectLocalId: 'ws-1',
            title: 'Cold chat',
          );
          const target = RemoteStandaloneChatTarget(
            chatId: 'chat-cold',
            projectLocalId: 'ws-1',
          );
          RemoteChatMessage row(
            String id,
            String text, {
            ChatRole role = ChatRole.user,
          }) => RemoteChatMessage(
            messageId: id,
            chatId: 'chat-cold',
            scope: RemoteChatScope.standalone,
            role: role,
            status: ChatMessageStatus.complete,
            text: text,
          );
          // Each launch opens the same directory through new storage, on a
          // worker isolate, the way a new process does. Launches run outside
          // the fake-async zone so the storage's real I/O can complete.
          final directory = Directory.systemTemp.createTempSync('can3373');
          addTearDown(() => directory.deleteSync(recursive: true));
          late FileRemoteTranscriptStorage storage;
          RemoteControlViewModel launch(_ColdReopenRepository repository) {
            storage = FileRemoteTranscriptStorage(
              directory: () async => directory,
            );
            return RemoteControlViewModel(
              repository: repository,
              stateRefreshDebounce: Duration.zero,
              transcriptCache: RemoteTranscriptCache(
                storage: storage,
                accountScope: 'test:7',
              ),
            );
          }

          // First process: the user reads the chat and the desktop answers.
          final firstRepository = _ColdReopenRepository();
          late final RemoteControlViewModel first;
          await tester.runAsync(() async {
            first = launch(firstRepository);
            await first.connect('123456');
            first.ensureChatTranscript(target);
            first.reopenChatTranscript(target);
            firstRepository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 1,
                events: [
                  RemoteStateSnapshotEvent(
                    scope: 'chat',
                    targetChatId: 'chat-cold',
                    targetChatScope: RemoteChatScope.standalone,
                    chatMessages: [
                      for (var i = 1; i < rows; i++)
                        row('q$i', 'Persisted question $i.'),
                      row('a1', 'Persisted answer.', role: ChatRole.assistant),
                    ],
                  ),
                ],
              ),
            );
            await Future<void>.delayed(Duration.zero);
          });
          expect(first.messagesFor(target), hasLength(rows));
          expect(first.messagesFor(target).last.text, 'Persisted answer.');
          // The process ends; its pending write is flushed on the way out.
          await tester.runAsync(() async {
            first.dispose();
            await storage.flush();
          });

          // Cold start: neither the server cache nor the desktop has answered.
          final secondRepository = _ColdReopenRepository()
            ..withholdTranscripts = true;
          late final RemoteControlViewModel second;
          await tester.runAsync(() async {
            second = launch(secondRepository);
            await second.connect('123456');
            if (!liveFirst) return;
            secondRepository.eventsController.add(
              RemotePortalEventBatch(
                nextCursor: 2,
                events: [
                  RemoteChatMessageEvent(
                    chatId: 'chat-cold',
                    scope: RemoteChatScope.standalone,
                    message: RemoteChatMessage(
                      messageId: 'a2',
                      chatId: 'chat-cold',
                      scope: RemoteChatScope.standalone,
                      role: ChatRole.assistant,
                      status: ChatMessageStatus.streaming,
                      text: 'Live answer.',
                    ),
                  ),
                ],
              ),
            );
            await Future<void>.delayed(Duration.zero);
          });
          await tester.pumpWidget(
            buildSubject(
              second,
              const RemoteChatScreen.standalone(standaloneChat: chat),
            ),
          );

          // One pump: the persisted tail is on the first chat frame.
          expect(find.text('Persisted answer.'), findsOneWidget);
          if (liveFirst) expect(find.text('Live answer.'), findsOneWidget);
          expect(find.text('Loading conversation…'), findsNothing);
          expect(secondRepository.requestChatTranscriptCalls, 1);
          // The feed's first-landing gate shows it once the landing settles,
          // two frames later, with both transcript sources still withheld.
          await tester.pump();
          await tester.pump();
          expect(
            tester
                .widget<Opacity>(
                  find.byKey(
                    const ValueKey('remote-chat-transcript-visibility'),
                  ),
                )
                .opacity,
            1,
          );
          expect(find.text('Persisted answer.'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await tester.runAsync(() async {
            second.dispose();
            await storage.flush();
          });
        },
      );
    }

    testWidgets('shows transcript hydration failures with a retry action', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _FailingChatHydrationRepository();
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));

      const chat = RemoteStandaloneChat(
        localId: 'chat-failing',
        projectLocalId: 'ws-1',
        title: 'Failing chat',
      );
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          const RemoteChatScreen.standalone(standaloneChat: chat),
        ),
      );
      await tester.pump();
      await tester.pump();

      // CAN-3631: the first failure keeps loading until the retry fails.
      expect(find.text('Loading conversation…'), findsOneWidget);
      expect(find.text('Transcript unavailable.'), findsNothing);
      expect(find.text('Retry'), findsNothing);
      await tester.pump(kRemoteHydrationRetryWindow);
      await tester.pump();

      expect(repository.requestChatTranscriptCalls, 2);
      expect(find.text('Transcript unavailable.'), findsOneWidget);
      expect(find.text('No messages yet.'), findsNothing);
      expect(find.text('Retry'), findsOneWidget);

      // Retry starts a fresh load with both attempts available.
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();

      expect(repository.requestChatTranscriptCalls, 3);
      expect(find.text('Loading conversation…'), findsOneWidget);
      expect(find.text('Transcript unavailable.'), findsNothing);
      await tester.pump(kRemoteHydrationRetryWindow);
      await tester.pump();
      expect(repository.requestChatTranscriptCalls, 4);
      expect(find.text('Transcript unavailable.'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('cached transcript keeps hydration failure and retry visible', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..cachedChatMessages = const [
          RemoteChatMessage(
            messageId: 'cached',
            chatId: 'chat-cached',
            scope: RemoteChatScope.standalone,
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Cached answer',
          ),
        ];
      final viewModel = RemoteControlViewModel(
        repository: repository,
        hydrationTimeout: const Duration(seconds: 10),
        hydrationRetryWindow: const Duration(seconds: 1),
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      addTearDown(repository.eventsController.close);

      const chat = RemoteStandaloneChat(
        localId: 'chat-cached',
        projectLocalId: 'ws-1',
        title: 'Cached chat',
      );
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          const RemoteChatScreen.standalone(standaloneChat: chat),
        ),
      );
      await tester.pump(const Duration(seconds: 8));
      await tester.pump();
      expect(find.text('Cached answer'), findsOneWidget);

      const timedOut = 'The conversation took too long to load. Try again.';
      // CAN-3631: the first timeout leaves the cached text as it is.
      await tester.pump(const Duration(milliseconds: 2500));
      await tester.pump();
      expect(repository.requestChatTranscriptCalls, 1);
      expect(find.text('Cached answer'), findsOneWidget);
      expect(find.text(timedOut), findsNothing);
      expect(find.text('Retry'), findsNothing);

      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump();
      expect(repository.requestChatTranscriptCalls, 2);
      expect(find.text(timedOut), findsNothing);
      await tester.pump(const Duration(seconds: 9));
      await tester.pump();
      expect(find.text(timedOut), findsNothing);
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(find.text('Cached answer'), findsOneWidget);
      expect(find.text(timedOut), findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(find.text('Retry'));
      await tester.pump();
      expect(repository.requestChatTranscriptCalls, 3);
      expect(find.text(timedOut), findsNothing);
      expect(find.text('Cached answer'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('a reply after the final failure clears the banner', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository()
        ..cachedChatMessages = const [
          RemoteChatMessage(
            messageId: 'cached',
            chatId: 'chat-late',
            scope: RemoteChatScope.standalone,
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Cached answer',
          ),
        ];
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      addTearDown(repository.eventsController.close);

      const chat = RemoteStandaloneChat(
        localId: 'chat-late',
        projectLocalId: 'ws-1',
        title: 'Late chat',
      );
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          const RemoteChatScreen.standalone(standaloneChat: chat),
        ),
      );
      await tester.pump();
      await tester.pump(
        kRemoteHydrationTimeout +
            kRemoteHydrationRetryWindow +
            kRemoteHydrationTimeout,
      );
      await tester.pump();
      expect(repository.requestChatTranscriptCalls, 2);
      expect(
        find.text('The conversation took too long to load. Try again.'),
        findsOneWidget,
      );

      repository.eventsController.add(
        const RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: 'chat-late',
              targetChatScope: RemoteChatScope.standalone,
              chatMessages: [
                RemoteChatMessage(
                  messageId: 'cached',
                  chatId: 'chat-late',
                  scope: RemoteChatScope.standalone,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Cached answer',
                ),
                RemoteChatMessage(
                  messageId: 'late',
                  chatId: 'chat-late',
                  scope: RemoteChatScope.standalone,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Late reply',
                ),
              ],
            ),
          ],
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('Late reply'), findsOneWidget);
      expect(
        find.text('The conversation took too long to load. Try again.'),
        findsNothing,
      );
      expect(find.text('Retry'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    group('CAN-4427 cached transcript failure', () {
      const timedOut = 'The conversation took too long to load. Try again.';
      const banner = ValueKey('remote-transcript-hydration-failure');
      const chat = RemoteStandaloneChat(
        localId: 'chat-cached',
        projectLocalId: 'ws-1',
        title: 'Cached chat',
      );
      RemoteChatMessage row(String id, String text) => RemoteChatMessage(
        messageId: id,
        chatId: 'chat-cached',
        scope: RemoteChatScope.standalone,
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: text,
      );
      Finder dismissButton() => find.descendant(
        of: find.byKey(banner),
        matching: find.byTooltip('Dismiss'),
      );

      /// The cached chat on screen after both attempts timed out: 2s
      /// watchdog, 1s retry window.
      Future<(FakeRemoteControlRepository, RemoteControlViewModel)> failed(
        WidgetTester tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..cachedChatMessages = [row('cached', 'Cached answer')];
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 1),
          // The retry window is measured on the test's fake time.
          clock: () => tester.binding.clock.now(),
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        addTearDown(repository.eventsController.close);
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.standalone(standaloneChat: chat),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 2));
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.text('Cached answer'), findsOneWidget);
        expect(find.byKey(banner), findsOneWidget);
        expect(find.text(timedOut), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);
        return (repository, viewModel);
      }

      testWidgets('Dismiss hides the banner for that failure', (tester) async {
        final (repository, viewModel) = await failed(tester);
        expect(dismissButton(), findsOneWidget);
        // The padded touch target, not the 32px visual button.
        expect(
          tester
              .getSize(
                find.byKey(
                  const ValueKey('remote-transcript-hydration-dismiss'),
                ),
              )
              .shortestSide,
          greaterThanOrEqualTo(44),
        );

        await tester.tap(dismissButton());
        await tester.pump();
        expect(find.byKey(banner), findsNothing);
        expect(find.text('Cached answer'), findsOneWidget);
        expect(repository.requestChatTranscriptCalls, 2);

        // Rebuilds and other chats' changes keep it dismissed.
        repository.eventsController.add(
          const RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteChatMessageEvent(
                chatId: 'other',
                scope: RemoteChatScope.standalone,
                message: RemoteChatMessage(
                  messageId: 'other',
                  chatId: 'other',
                  scope: RemoteChatScope.standalone,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Other chat',
                ),
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(minutes: 1));
        expect(find.byKey(banner), findsNothing);
        expect(repository.requestChatTranscriptCalls, 2);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      });

      testWidgets('a live row clears the banner without Retry', (tester) async {
        final (repository, viewModel) = await failed(tester);
        repository.eventsController.add(
          RemotePortalEventBatch(
            nextCursor: 1,
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-cached',
                scope: RemoteChatScope.standalone,
                // A new prompt, so the cached answer stays its own turn.
                message: RemoteChatMessage(
                  messageId: 'live',
                  chatId: 'chat-cached',
                  scope: RemoteChatScope.standalone,
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  text: 'Live reply',
                ),
              ),
            ],
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Live reply'), findsOneWidget);
        expect(find.text('Cached answer'), findsOneWidget);
        expect(find.byKey(banner), findsNothing);
        expect(
          tester.getTopLeft(find.text('Cached answer')).dy,
          lessThan(tester.getTopLeft(find.text('Live reply')).dy),
        );
        await tester.pump(const Duration(minutes: 1));
        expect(repository.requestChatTranscriptCalls, 2);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      });

      testWidgets('returning to the chat after the retry window loads it '
          'again', (tester) async {
        final (repository, viewModel) = await failed(tester);
        final navigator = tester.state<NavigatorState>(find.byType(Navigator));

        // Back inside the retry window: nothing is sent.
        unawaited(
          navigator.push(
            MaterialPageRoute<void>(builder: (_) => const Text('Elsewhere')),
          ),
        );
        await tester.pumpAndSettle();
        navigator.pop();
        await tester.pumpAndSettle();
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.byKey(banner), findsOneWidget);

        unawaited(
          navigator.push(
            MaterialPageRoute<void>(builder: (_) => const Text('Elsewhere')),
          ),
        );
        await tester.pumpAndSettle();
        await tester.pump(const Duration(seconds: 1));
        navigator.pop();
        // The reopening follows the frame that shows the chat again.
        await tester.pump();
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 3);
        expect(find.byKey(banner), findsNothing);
        expect(find.text('Cached answer'), findsOneWidget);
        await tester.pumpAndSettle();

        // A new failure shows the banner again, with the same text.
        await tester.pump(const Duration(seconds: 2));
        await tester.pump(const Duration(seconds: 1));
        expect(repository.requestChatTranscriptCalls, 4);
        expect(find.byKey(banner), findsNothing);
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(find.text(timedOut), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      });

      testWidgets('a reconnect loads a worktree whose chats never loaded', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            standaloneChats: [],
            worktrees: [
              RemoteWorktree(
                localId: 'wt-1',
                workspaceLocalId: 'ws-1',
                branch: 'main',
              ),
            ],
          );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 1),
          clock: () => tester.binding.clock.now(),
        );
        // Connected in the test zone, so the reconnect grace runs on fake time.
        await viewModel.connect('123456');
        addTearDown(repository.eventsController.close);
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: viewModel.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(seconds: 2));
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 2));
        await tester.pump();
        expect(repository.requestChatTranscriptCalls, 2);
        expect(find.text(timedOut), findsOneWidget);
        expect(find.text('Retry'), findsOneWidget);

        repository.eventsLiveController.add(false);
        await tester.pump(const Duration(seconds: 3));
        expect(viewModel.linkState, RemoteLinkState.reconnecting);
        repository.eventsLiveController.add(true);
        await tester.pump();
        await tester.pump();

        // The screen knows no chat to load, so the discovery goes out again
        // instead of leaving an empty chat without Retry.
        expect(repository.requestChatTranscriptCalls, 3);
        expect(repository.requestChatTranscriptTargets.last.chatId, isNull);
        expect(find.text('Loading chats…'), findsOneWidget);
        expect(find.text(timedOut), findsNothing);
        await tester.pump(const Duration(milliseconds: 500));
        expect(repository.requestChatTranscriptCalls, 3);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        viewModel.dispose();
      });
    });

    testWidgets(
      'a pending question does not hide the loading transcript behind it',
      (tester) async {
        usePhoneViewport(tester);
        // The question arrives on the chat summary, independently of the
        // transcript round trip, which this fake never answers.
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = _pendingQuestionSnapshot;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-q',
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(repository.requestChatTranscriptCalls, 1);
        expect(find.text('Loading conversation…'), findsOneWidget);
        expect(find.text('Ship to prod?'), findsOneWidget);
        expect(tester.takeException(), isNull);

        viewModel.dispose();
      },
    );

    testWidgets(
      'a pending question does not hide a failed transcript load behind it',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _FailingChatHydrationRepository()
          ..snapshotBuilder = _pendingQuestionSnapshot;
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-q',
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        // CAN-3631: loading holds until the automatic retry also fails.
        expect(
          find.byKey(const ValueKey('transcript-status-loading')),
          findsOneWidget,
        );
        await tester.pump(kRemoteHydrationRetryWindow);
        await tester.pump();

        final transcriptStatus = find.byKey(
          const ValueKey('transcript-status-error'),
        );
        expect(transcriptStatus, findsOneWidget);
        expect(
          find.descendant(
            of: transcriptStatus,
            matching: find.text('Transcript unavailable.'),
          ),
          findsOneWidget,
        );
        expect(find.text('Ship to prod?'), findsOneWidget);

        await tester.tap(
          find.descendant(of: transcriptStatus, matching: find.text('Retry')),
        );
        await tester.pump();
        await tester.pump();

        expect(repository.requestChatTranscriptCalls, 3);
        expect(tester.takeException(), isNull);

        viewModel.dispose();
      },
    );

    testWidgets(
      'pending questions taller than the screen keep the failed transcript '
      'load and its retry in view',
      (tester) async {
        usePhoneViewport(tester);
        final repository = _FailingChatHydrationRepository()
          ..snapshotBuilder = () => _pendingQuestionSnapshot(questionCount: 6);
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(
              worktree: worktree,
              initialChatId: 'chat-q',
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump(kRemoteHydrationRetryWindow);
        await tester.pump();

        // The feed has settled on its newest row: the last question.
        expect(find.text('Ship to prod? (6)').hitTestable(), findsOneWidget);

        final retry = find
            .descendant(
              of: find.byKey(const ValueKey('transcript-status-error')),
              matching: find.text('Retry'),
            )
            .hitTestable();
        expect(retry, findsOneWidget);

        await tester.tap(retry);
        await tester.pump();
        await tester.pump();

        expect(repository.requestChatTranscriptCalls, 3);
        expect(tester.takeException(), isNull);

        viewModel.dispose();
      },
    );

    testWidgets('a worktree with no chats shows the new-chat empty state', (
      tester,
    ) async {
      usePhoneViewport(tester);
      const worktree = RemoteWorktree(
        localId: 'wt-bugfix',
        workspaceLocalId: 'ws-app',
        branch: 'bugfix',
      );
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [worktree],
          standaloneChats: [],
        );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await viewModel.connect('123456');

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pump();

      expect(find.text('Loading chats…'), findsOneWidget);
      expect(
        find.text('No chats yet — send a message to start one.'),
        findsNothing,
      );

      // Deliver the host's empty tab list explicitly instead of racing its
      // snapshot and follow-up reads against a wall-clock delay.
      repository.eventsController.add(
        const RemotePortalEventBatch(
          nextCursor: 1,
          events: [
            RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-app',
              targetWorktreeLocalId: 'wt-bugfix',
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('No chats yet — send a message to start one.'),
        findsOneWidget,
      );
      expect(find.text('Loading chats…'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      viewModel.dispose();
    });

    testWidgets(
      'shows a scroll-to-bottom button once scrolled up and returns to the '
      'bottom when tapped',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
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
          chatSummaries: const [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
          ],
          chatMessages: [
            for (var i = 0; i < 40; i += 1)
              RemoteChatMessage(
                messageId: 'm-$i',
                chatId: 'chat-a',
                role: i.isEven ? ChatRole.user : ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Message number $i in the conversation',
              ),
          ],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pumpAndSettle();

        final button = find.byKey(
          const ValueKey('remote-chat-scroll-to-bottom'),
        );
        final transcript = find.byKey(const ValueKey('remote-chat-transcript'));

        // The viewport reaches behind the chrome. A real first list item,
        // rather than list padding, clears the toolbar at the history edge.
        final appBar = find.byType(CanopyAppBar);
        expect(tester.getTopLeft(transcript).dy, 0);
        final list = tester.widget<ListView>(transcript);
        expect((list.padding! as EdgeInsets).top, 0);

        // A long transcript opens at the newest content.
        expect(list.controller!.position.maxScrollExtent, greaterThan(0));
        expect(
          list.controller!.position.pixels,
          list.controller!.position.maxScrollExtent,
        );

        await tester.drag(transcript, const Offset(0, 6000));
        await tester.pumpAndSettle();
        final topSpace = find.byKey(
          const ValueKey('remote-chat-top-inset-space'),
        );
        expect(topSpace, findsOneWidget);
        expect(
          tester.getSize(topSpace).height,
          tester.getSize(appBar).height + 8,
        );
        final oldest = find.byKey(const ValueKey('message-m-0'));
        final chromeBottom = tester.getBottomLeft(appBar).dy;
        expect(
          tester.getTopLeft(oldest).dy,
          greaterThanOrEqualTo(chromeBottom),
        );
        await tester.drag(transcript, const Offset(0, -40));
        await tester.pumpAndSettle();
        expect(tester.getTopLeft(oldest).dy, lessThan(chromeBottom));
        expect(tester.getBottomLeft(oldest).dy, greaterThan(0));
        list.controller!.jumpTo(list.controller!.position.maxScrollExtent);
        await tester.pumpAndSettle();

        // Anchored at the bottom: no button.
        expect(button, findsNothing);

        // Scroll up into history.
        await tester.drag(transcript, const Offset(0, 1600));
        await tester.pumpAndSettle();
        expect(button, findsOneWidget);

        // Tapping snaps back to the newest message and hides the button.
        await tester.tap(button);
        await tester.pumpAndSettle();
        expect(button, findsNothing);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets('starts a newly sent turn at the top of the transcript', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: const [],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('composer-draft')),
        'Start this turn at the top',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('composer-send')));
      await tester.pumpAndSettle();

      expect(repository.sendChatMessageCalls, hasLength(1));
      final userMessageId =
          repository.sendChatMessageCalls.single.options!.userMessageId!;
      final sent = find.byKey(ValueKey('message-$userMessageId'));
      final appBarBottom = tester.getBottomLeft(find.byType(CanopyAppBar)).dy;
      final composerTop = tester
          .getTopLeft(find.byKey(const ValueKey('chat-composer')))
          .dy;
      final sentTop = tester.getTopLeft(sent).dy;

      expect(sentTop, greaterThanOrEqualTo(appBarBottom));
      expect(sentTop, lessThan((appBarBottom + composerTop) / 2));
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('keeps a short completed chat top-aligned and non-scrollable', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: [
          RemoteChatMessage(
            messageId: 'user-latest',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Keep this prompt at the top',
          ),
          RemoteChatMessage(
            messageId: 'assistant-latest',
            chatId: 'chat-a',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text:
                'A completed response with enough content to reproduce the '
                'short reopened-chat layout shown on a phone.',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(
            worktree: viewModel.worktreesFor('ws-1').single,
          ),
        ),
      );
      await tester.pumpAndSettle();

      final prompt = find.byKey(const ValueKey('message-user-latest'));
      final transcript = tester.widget<ListView>(
        find.byKey(const ValueKey('remote-chat-transcript')),
      );
      final appBarBottom = tester.getBottomLeft(find.byType(CanopyAppBar)).dy;
      final promptTop = tester.getTopLeft(prompt).dy;
      expect(transcript.controller!.position.maxScrollExtent, 0);
      expect(promptTop, greaterThanOrEqualTo(appBarBottom));
      expect(promptTop, lessThan(appBarBottom + 48));
      expect(
        tester
            .getTopLeft(find.byKey(const ValueKey('message-assistant-latest')))
            .dy,
        greaterThan(promptTop),
      );
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets(
      'floating transcript actions share the composer gutter and stack',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
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
          chatSummaries: const [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
            RemoteChatSummary(
              chatId: 'chat-b',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
            ),
          ],
          chatMessages: [
            for (var i = 0; i < 40; i += 1)
              RemoteChatMessage(
                messageId: 'm-$i',
                chatId: 'chat-a',
                role: i.isEven ? ChatRole.user : ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Message number $i in the conversation',
              ),
          ],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pumpAndSettle();

        // Scroll up into history so both floating actions are on screen.
        await tester.drag(
          find.byKey(const ValueKey('remote-chat-transcript')),
          const Offset(0, 1600),
        );
        await tester.pumpAndSettle();

        final composer = tester.getRect(
          find.byKey(const ValueKey('chat-composer')),
        );
        final fab = tester.getRect(find.byKey(const ValueKey('chat-tabs-fab')));
        final scrollDown = tester.getRect(
          find.byKey(const ValueKey('remote-chat-scroll-to-bottom')),
        );
        final transcript = tester.widget<ListView>(
          find.byKey(const ValueKey('remote-chat-transcript')),
        );

        // The newest transcript content clears the action parked over its
        // bottom edge instead of rendering underneath it.
        expect(
          (transcript.padding! as EdgeInsets).bottom,
          8 + CanopyOverlayAction.stackOffset,
        );

        // The visual circle stays compact, but every floating action must
        // expose the mobile minimum touch target.
        expect(fab.width, greaterThanOrEqualTo(44));
        expect(fab.height, greaterThanOrEqualTo(44));
        expect(scrollDown.width, greaterThanOrEqualTo(44));
        expect(scrollDown.height, greaterThanOrEqualTo(44));

        // One right edge for the composer and both floating actions.
        expect(fab.right, composer.right);
        expect(scrollDown.right, composer.right);

        // The gutter above the composer matches the gutter beside it.
        final sideGutter =
            tester.view.physicalSize.width / tester.view.devicePixelRatio -
            composer.right;
        expect(composer.top - fab.bottom, sideGutter);

        // The two actions stack on the same gutter instead of overlapping.
        expect(fab.top - scrollDown.bottom, sideGutter);

        // The transparent edge belongs to the hit target, not only the
        // keyed layout box around the 40px visual circle.
        await tester.tapAt(fab.topLeft + const Offset(1, 1));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('new-chat-button')), findsOneWidget);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets(
      'shows a loading state while the chat-tab list round-trips to the '
      'desktop',
      (tester) async {
        usePhoneViewport(tester);
        // A fake whose requestWorktreeState never answers with a snapshot
        // event, freezing the hydration in-flight state.
        final repository = FakeRemoteControlRepository();
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));

        const worktree = RemoteWorktree(
          localId: 'wt-cold',
          workspaceLocalId: 'ws-1',
          branch: 'feature/cold-start',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Loading chats…'), findsOneWidget);
        expect(
          find.text('No chats yet — send a message to start one.'),
          findsNothing,
        );
        expect(tester.takeException(), isNull);

        // Dispose the pending worktree hydration timer.
        viewModel.dispose();
      },
    );

    testWidgets(
      'disables sending while the worktree chat tabs are still hydrating',
      (tester) async {
        usePhoneViewport(tester);
        // A fake whose requestWorktreeState never answers, so the chat-tab
        // list stays in-flight and the active chat id is unknown.
        final repository = FakeRemoteControlRepository();
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));

        const worktree = RemoteWorktree(
          localId: 'wt-cold',
          workspaceLocalId: 'ws-1',
          branch: 'feature/cold-start',
        );
        await tester.pumpWidget(
          buildSubject(
            viewModel,
            const RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Loading chats…'), findsOneWidget);

        // Sending now would mint a phantom new chat the desktop echoes to an
        // id this screen isn't showing, so the composer's send is disabled
        // until the tabs resolve.
        await tester.enterText(find.byType(TextField), 'Start something');
        await tester.pump();
        final sendButton = tester.widget<IconButton>(
          find.descendant(
            of: find.byKey(const ValueKey('composer-send')),
            matching: find.byType(IconButton),
          ),
        );
        expect(sendButton.onPressed, isNull);
        expect(tester.takeException(), isNull);

        // Dispose the pending worktree hydration timer.
        viewModel.dispose();
      },
    );

    testWidgets('renders a pending question card and submits the answer', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: false,
            pendingQuestions: [
              AskUserQuestionState(
                requestId: 'req-1',
                questions: [
                  AskUserQuestion(
                    id: 'q-1',
                    header: 'Deploy',
                    question: 'Ship to prod?',
                    options: ['Yes', 'No'],
                  ),
                ],
              ),
            ],
          ),
          RemoteChatSummary(
            chatId: 'chat-b',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat B',
            active: true,
          ),
        ],
        chatMessages: [
          RemoteChatMessage(
            messageId: 'u-1',
            chatId: 'chat-a',
            role: ChatRole.user,
            status: ChatMessageStatus.complete,
            text: 'Deploy when ready',
          ),
        ],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(
          viewModel,
          Builder(
            builder: (context) => Scaffold(
              body: WorktreeArchiveRow(
                worktree: worktree,
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        RemoteChatScreen.worktree(worktree: worktree),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('Question needs an answer'), findsNWidgets(2));
      await tester.tap(find.text('main'));

      await tester.pumpAndSettle();
      await tester.openTabsSheet();

      expect(
        find.byKey(const ValueKey('chat-question-chat-a')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('chat-question-chat-b')), findsNothing);
      final questionDot = find.descendant(
        of: find.byKey(const ValueKey('chat-question-chat-a')),
        matching: find.byType(Container),
      );
      expect(questionDot, findsOneWidget);
      expect(tester.getSize(questionDot), const Size(7, 7));
      expect(
        (tester.widget<Container>(questionDot).decoration as BoxDecoration)
            .color,
        StatusColors.light.warning,
      );
      await tester.tap(find.byKey(const ValueKey('chat-tab-chat-a')));
      await tester.finishSheetDismiss();
      expect(find.text('Ship to prod?'), findsOneWidget);
      expect(find.text('Deploy'), findsOneWidget);
      expect(
        tester.getBottomLeft(find.byKey(const ValueKey('chat-composer'))).dy,
        closeTo(tester.view.physicalSize.height / 3 - 8, 1),
      );

      // The card belongs to the transcript, not a fixed shelf above the
      // composer: it sits inside the feed's scrollable, below the agent's
      // last row, and scrolls away with the rest of the conversation.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('remote-chat-transcript')),
          matching: find.byKey(const ValueKey('question-req-1')),
        ),
        findsOneWidget,
      );

      // Submit is disabled until an option is chosen.
      final submitFinder = find.byKey(const ValueKey('question-submit-req-1'));
      expect(tester.widget<FilledButton>(submitFinder).onPressed, isNull);

      final yes = find.text('Yes');
      await tester.ensureVisible(yes);
      await tester.pump();
      await tester.tap(yes);
      await tester.pump();
      await tester.tap(submitFinder);
      await tester.pump();

      expect(repository.lastAnswerRequestId, 'req-1');
      final answer = repository.lastAnswerAnswers?.single;
      expect(answer?.questionId, 'q-1');
      expect(answer?.selectedOptions, ['Yes']);

      // The card hides optimistically once answered.
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('question-req-1')), findsNothing);
      await tester.openTabsSheet();
      expect(find.byKey(const ValueKey('chat-question-chat-a')), findsNothing);
      await tester.dismissTabsSheet();
      Navigator.of(tester.element(find.byType(RemoteChatScreen))).pop();
      await tester.pumpAndSettle();
      expect(find.byTooltip('Question needs an answer'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    /// Seeds one chat carrying a single pending question, so the card tests
    /// below only have to describe the question itself.
    Future<RemoteControlViewModel> pumpQuestion(
      WidgetTester tester,
      AskUserQuestion question, {
      FakeRemoteControlRepository? repo,
    }) async {
      usePhoneViewport(tester);
      final repository = repo ?? FakeRemoteControlRepository();
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
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
            pendingQuestions: [
              AskUserQuestionState(requestId: 'req-1', questions: [question]),
            ],
          ),
        ],
        chatMessages: const [],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;
      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();
      // Disposed inside the test body, not addTearDown: tear-down runs after
      // the harness checks for pending timers, and the hydration watchdog is
      // still armed for these message-less chats.
      return viewModel;
    }

    testWidgets('a single-select question renders desktop-style radio rows', (
      tester,
    ) async {
      const longOption =
          'Everything the chips had: title, unread dot and working spinner';
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'What should each tab row carry?',
          options: [longOption, 'Title and unread dot only'],
          optionDescriptions: ['Closest to today', ''],
        ),
      );

      // Desktop drops the banner title and the header close affordance; the
      // question itself is the heading.
      expect(find.text('The agent needs your input'), findsNothing);

      // One radio per option plus one for Other — Other is a peer choice, not
      // an always-open text box.
      expect(find.byType(Radio<int>), findsNWidgets(3));
      expect(find.text('Other'), findsOneWidget);
      expect(find.byType(Checkbox), findsNothing);

      // Labels wrap instead of being clipped to one line.
      expect(find.text(longOption), findsOneWidget);
      expect(tester.getSize(find.text(longOption)).height, greaterThan(30));
      expect(find.text('Closest to today'), findsOneWidget);

      // Desktop's two actions.
      expect(find.text('Submit'), findsOneWidget);
      expect(find.text('Dismiss'), findsOneWidget);
      viewModel.dispose();
    });

    testWidgets('the Other field appears only once Other is selected', (
      tester,
    ) async {
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'Ship it?',
          options: ['Yes', 'No'],
        ),
      );

      expect(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        findsNothing,
      );

      await tester.tap(find.text('Other'));
      await tester.pumpAndSettle();
      final field = find.byKey(const ValueKey('question-other-field-req-1-0'));
      expect(field, findsOneWidget);
      // Multiline, like desktop's 3-row textarea.
      expect(tester.widget<TextField>(field).maxLines, greaterThan(1));

      // Radio semantics: picking a real option deselects Other and takes the
      // field away with it.
      await tester.tap(find.text('Yes'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        findsNothing,
      );
      viewModel.dispose();
    });

    testWidgets('an Other answer submits as freeform text with no option', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'Ship it?',
          options: ['Yes', 'No'],
        ),
        repo: repository,
      );

      final submit = find.byKey(const ValueKey('question-submit-req-1'));
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);

      await tester.tap(find.text('Other'));
      await tester.pumpAndSettle();
      // Selecting Other alone is not an answer until something is typed.
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);

      await tester.enterText(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        'Ship it behind a flag',
      );
      await tester.pumpAndSettle();
      await tester.tap(submit);
      await tester.pump();

      final answer = repository.lastAnswerAnswers?.single;
      expect(answer?.selectedOptions, isEmpty);
      expect(answer?.freeformText, 'Ship it behind a flag');
      viewModel.dispose();
    });

    testWidgets('a multi-select question uses checkboxes and keeps Other', (
      tester,
    ) async {
      final repository = FakeRemoteControlRepository();
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'Which surfaces?',
          options: ['Desktop', 'Web'],
          multiSelect: true,
        ),
        repo: repository,
      );

      expect(find.byType(Checkbox), findsNWidgets(3));
      expect(find.byType(Radio<int>), findsNothing);

      await tester.tap(find.text('Desktop'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Other'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('question-other-field-req-1-0')),
        'Mobile too',
      );
      await tester.pumpAndSettle();

      // Multi-select keeps both: Other does not clear the concrete picks.
      await tester.tap(find.byKey(const ValueKey('question-submit-req-1')));
      await tester.pump();
      final answer = repository.lastAnswerAnswers?.single;
      expect(answer?.selectedOptions, ['Desktop']);
      expect(answer?.freeformText, 'Mobile too');
      viewModel.dispose();
    });

    testWidgets('a secret question obscures the Other field', (tester) async {
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'Paste the token',
          secret: true,
        ),
      );

      await tester.tap(find.text('Other'));
      await tester.pumpAndSettle();
      final field = find.byKey(const ValueKey('question-other-field-req-1-0'));
      expect(tester.widget<TextField>(field).obscureText, isTrue);
      // An obscured secret is a single-line field, never a 3-row textarea.
      expect(tester.widget<TextField>(field).maxLines, 1);
      viewModel.dispose();
    });

    testWidgets('a question with allowOther false offers no Other row', (
      tester,
    ) async {
      final viewModel = await pumpQuestion(
        tester,
        const AskUserQuestion(
          id: 'q-1',
          question: 'Ship it?',
          options: ['Yes', 'No'],
          allowOther: false,
        ),
      );

      expect(find.text('Other'), findsNothing);
      expect(find.byType(Radio<int>), findsNWidgets(2));
      viewModel.dispose();
    });

    testWidgets(
      'per-chat turnActive shows the working bar before transcript hydration',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
              isStreaming: false,
            ),
          ],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
              turnActive: true,
              turnElapsedMs: 550000,
            ),
          ],
          // The turn is live on the desktop but no transcript row has landed
          // on this client yet — the bar must still show.
          chatMessages: [],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        // Bounded pumps, not pumpAndSettle: the working bar animates for as
        // long as the chat runs, so it never settles.
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('remote-chat-working-indicator')),
          findsOneWidget,
        );
        expect(find.text('Working... 9:10'), findsOneWidget);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets(
      'the stop control stays off idle sibling tabs while another chat runs',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [
            RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
              isStreaming: true,
            ),
          ],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
            ),
            RemoteChatSummary(
              chatId: 'chat-b',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat B',
            ),
          ],
          chatMessages: [
            RemoteChatMessage(
              messageId: 'a-1',
              chatId: 'chat-a',
              role: ChatRole.assistant,
              status: ChatMessageStatus.streaming,
              text: 'Working on chat A…',
            ),
            RemoteChatMessage(
              messageId: 'b-1',
              chatId: 'chat-b',
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Chat B is idle.',
            ),
          ],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pump();
        await tester.pump();

        // The running (active) tab exposes the stop control.
        expect(find.byKey(const ValueKey('composer-stop')), findsOneWidget);

        // Switching to the idle sibling tab hides the bar: worktree-level
        // isStreaming must not leak onto tabs that are not running.
        await tester.selectTabFromSheet('Chat B');
        await tester.pump();
        expect(find.byKey(const ValueKey('composer-stop')), findsNothing);
        expect(find.byKey(const ValueKey('composer-send')), findsOneWidget);
        // The running chat still carries its own spinner in the tab sheet.
        await tester.openTabsSheet();
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('chat-tab-chat-a')),
            matching: find.byType(ThinkingSpinner),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    testWidgets('dismissing a question card calls dismissQuestion', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = FakeRemoteControlRepository();
      repository.snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [
          RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
            pendingQuestions: [
              AskUserQuestionState(
                requestId: 'req-2',
                questions: [
                  AskUserQuestion(
                    question: 'Need anything else?',
                    options: ['All good'],
                    allowOther: true,
                  ),
                ],
              ),
            ],
          ),
        ],
        chatMessages: [],
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      final worktree = viewModel.worktreesFor('ws-1').single;

      await tester.pumpWidget(
        buildSubject(viewModel, RemoteChatScreen.worktree(worktree: worktree)),
      );
      await tester.pumpAndSettle();

      await tester.openTabsSheet();
      expect(
        find.byKey(const ValueKey('chat-question-chat-a')),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const ValueKey('chat-tab-chat-a')));
      await tester.finishSheetDismiss();
      expect(find.text('Need anything else?'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('question-dismiss-req-2')));
      await tester.pumpAndSettle();

      await tester.openTabsSheet();
      expect(find.byKey(const ValueKey('chat-question-chat-a')), findsNothing);
      await tester.dismissTabsSheet();
      expect(repository.lastDismissRequestId, 'req-2');
      expect(find.text('Need anything else?'), findsNothing);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets(
      'multiple large pending questions stay scrollable on a phone viewport',
      (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository();
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
              chatId: 'chat-a',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: 'Chat A',
              active: true,
              pendingQuestions: [
                for (var requestIndex = 0; requestIndex < 3; requestIndex += 1)
                  AskUserQuestionState(
                    requestId: 'req-$requestIndex',
                    questions: [
                      AskUserQuestion(
                        header: 'Large request ${requestIndex + 1}',
                        question: 'Choose an option for request $requestIndex',
                        options: [
                          for (
                            var optionIndex = 0;
                            optionIndex < 12;
                            optionIndex += 1
                          )
                            'Option $requestIndex-$optionIndex',
                        ],
                      ),
                    ],
                  ),
              ],
            ),
          ],
          chatMessages: const [],
        );
        final viewModel = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => viewModel.connect('123456'));
        final worktree = viewModel.worktreesFor('ws-1').single;

        await tester.pumpWidget(
          buildSubject(
            viewModel,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        );
        await tester.pumpAndSettle();

        // The cards are transcript rows, so the transcript's own scrollable
        // (not a capped shelf above the composer) carries them. The newest
        // request is anchored at the bottom; older ones are a scroll away.
        final transcript = find.byKey(const ValueKey('remote-chat-transcript'));
        expect(transcript, findsOneWidget);
        expect(
          find.descendant(
            of: transcript,
            matching: find.byKey(const ValueKey('question-req-2')),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);

        final firstDismissButton = find.byKey(
          const ValueKey('question-dismiss-req-0'),
        );
        await tester.scrollUntilVisible(
          firstDismissButton,
          -300,
          // `.first`: depth-first order puts the list's own vertical
          // viewport ahead of the horizontal EditableText scrollables inside
          // each card's "Other…" field.
          scrollable: find
              .descendant(of: transcript, matching: find.byType(Scrollable))
              .first,
        );
        // scrollUntilVisible stops as soon as the row is BUILT; bring it fully
        // into the viewport, then clear the overlaid app bar before asserting
        // it can actually be tapped.
        await tester.ensureVisible(firstDismissButton);
        await tester.drag(transcript, const Offset(0, 100));
        await tester.pumpAndSettle();
        expect(firstDismissButton.hitTestable(), findsOneWidget);
        expect(tester.takeException(), isNull);
        viewModel.dispose();
      },
    );

    /// One connected worktree chat whose transcript is exactly [messages].
    Future<RemoteControlViewModel> seededChat(
      WidgetTester tester,
      List<RemoteChatMessage> messages,
    ) async {
      final repository = FakeRemoteControlRepository();
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
        chatSummaries: const [
          RemoteChatSummary(
            chatId: 'chat-a',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'Chat A',
            active: true,
          ),
        ],
        chatMessages: messages,
      );
      final viewModel = RemoteControlViewModel(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await tester.runAsync(() => viewModel.connect('123456'));
      return viewModel;
    }

    testWidgets('user bubbles render filename chips for message attachments', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await seededChat(tester, const [
        RemoteChatMessage(
          messageId: 'u-1',
          chatId: 'chat-a',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Look at this',
          attachments: [
            ChatMessageAttachment(
              attachmentId: 'path-1',
              filename: 'notes.md',
              mediaType: 'text/markdown',
            ),
          ],
        ),
      ]);
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(
            worktree: viewModel.worktreesFor('ws-1').single,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('message-attachment-path-1')),
        findsOneWidget,
      );
      expect(find.text('notes.md'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    testWidgets('an attachment-only user message is not filtered out', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final viewModel = await seededChat(tester, const [
        RemoteChatMessage(
          messageId: 'u-2',
          chatId: 'chat-a',
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: '',
          attachments: [
            ChatMessageAttachment(
              attachmentId: 'path-2',
              filename: 'screenshot.png',
              mediaType: 'image/png',
            ),
          ],
        ),
      ]);
      await tester.pumpWidget(
        buildSubject(
          viewModel,
          RemoteChatScreen.worktree(
            worktree: viewModel.worktreesFor('ws-1').single,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('user-bubble-u-2')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('message-attachment-path-2')),
        findsOneWidget,
      );
      expect(find.text('screenshot.png'), findsOneWidget);
      expect(tester.takeException(), isNull);
      viewModel.dispose();
    });

    group('chat tabs sheet', () {
      RemoteSessionSnapshot Function() twoChats({
        bool unreadB = false,
        bool streamingB = false,
        bool questionB = false,
      }) {
        return () => RemoteSessionSnapshot.fromJson({
          'workspaces': [
            {'localId': 'ws-1', 'name': 'Workspace'},
          ],
          'worktrees': [
            {'localId': 'wt-1', 'workspaceLocalId': 'ws-1', 'branch': 'main'},
          ],
          'standaloneChats': [],
          'chatSummaries': [
            {
              'chatId': 'chat-a',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat A',
              'active': true,
            },
            {
              'chatId': 'chat-b',
              'scope': 'worktree',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'title': 'Chat B',
              'hasUnread': unreadB,
              'turnActive': streamingB,
              // Always explicit: an omitted field means "preserve", so a
              // cleared question has to be sent as an empty list.
              'pendingQuestions': [
                if (questionB)
                  {
                    'requestId': 'req-b',
                    'questions': [
                      {
                        'id': 'q-1',
                        'question': 'Ship to prod?',
                        'options': ['Yes', 'No'],
                      },
                    ],
                  },
              ],
            },
          ],
          'chatMessages': [
            {
              'localMessageId': 'a-1',
              'localChatId': 'chat-a',
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'content': 'Answer in chat A',
            },
            {
              'localMessageId': 'b-1',
              'localChatId': 'chat-b',
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'content': 'Answer in chat B',
            },
          ],
        });
      }

      testWidgets('an open sheet follows live chat state', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats(streamingB: true);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        await tester.openTabsSheet();

        final rowB = find.byKey(const ValueKey('chat-tab-chat-b'));
        final spinnerB = find.descendant(
          of: rowB,
          matching: find.byType(ThinkingSpinner),
        );
        expect(spinnerB, findsOneWidget);
        // The working row for B keeps its progress indicator animating.
        await tester.pump(const Duration(seconds: 1));
        expect(tester.hasRunningAnimations, isTrue);
        expect(
          find.byKey(const ValueKey('chat-tab-close-chat-b')),
          findsNothing,
        );

        // The turn finishes while the sheet is still open. The row has to
        // follow it there — the sheet is a live view of the worktree, not a
        // photograph taken when the FAB was tapped.
        repository.snapshotBuilder = twoChats(unreadB: true);
        await vm.refresh();
        await tester.pump();
        expect(spinnerB, findsNothing);
        expect(
          find.byKey(const ValueKey('chat-tab-close-chat-b')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('chat-unread-chat-b')),
          findsOneWidget,
        );

        // A question arriving outranks the unread dot, still without
        // reopening.
        repository.snapshotBuilder = twoChats(unreadB: true, questionB: true);
        await vm.refresh();
        await tester.pump();
        expect(
          find.byKey(const ValueKey('chat-question-chat-b')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('chat-unread-chat-b')), findsNothing);

        // And a turn starting again reclaims the trailing slot.
        repository.snapshotBuilder = twoChats(streamingB: true);
        await vm.refresh();
        await tester.pump();
        expect(spinnerB, findsOneWidget);
        expect(
          find.byKey(const ValueKey('chat-tab-close-chat-b')),
          findsNothing,
        );

        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('rows are built from design-system controls', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats(unreadB: true);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        await tester.openTabsSheet();

        /// The size the glyphs actually render at, after every ambient
        /// `DefaultTextStyle` the sheet and its rows contribute.
        double? renderedFontSize(Finder text) => tester
            .widget<RichText>(
              find.descendant(of: text, matching: find.byType(RichText)),
            )
            .text
            .style
            ?.fontSize;

        expect(find.text('Chats'), findsOneWidget);
        expect(find.text('Conversations'), findsNothing);

        // Removal is the shared icon button with the Central cross glyph,
        // not a hand-rolled Material one.
        final closeA = find.byKey(const ValueKey('chat-tab-close-chat-a'));
        expect(
          tester.widget<CanopyIconButton>(closeA).glyph,
          CanopyGlyph.crossMedium,
        );
        // The control sits on the row's edge: its own touch padding is the
        // inset, so the row must not add a second one on top of it.
        final rowA = tester.getRect(
          find.byKey(const ValueKey('chat-tab-chat-a')),
        );
        final glyphA = tester.getRect(
          find.descendant(of: closeA, matching: find.byType(CanopyIcon)),
        );
        expect(rowA.right - glyphA.right, lessThan(16));
        // Still a full touch target.
        expect(tester.getSize(closeA).width, greaterThanOrEqualTo(44));
        expect(tester.getSize(closeA).height, greaterThanOrEqualTo(44));
        // The pressed/ink surface stays the design system's square control.
        // A tight width on the slot silently overrides the button's own
        // `fixedSize` and stretches it into a 48x32 rectangle.
        final inkA = tester.getSize(
          find.descendant(of: closeA, matching: find.byType(InkWell)),
        );
        expect(inkA.width, inkA.height);
        expect(inkA.width, CanopyIconButtonSize.small.dimension);

        // The unread dot reads as part of the title: immediately right of the
        // name, well before the close control.
        final titleB = find.text('Chat B');
        final dot = find.byKey(const ValueKey('chat-unread-chat-b'));
        expect(
          tester.getRect(dot).left,
          greaterThanOrEqualTo(tester.getRect(titleB).right),
        );
        expect(
          tester.getRect(dot).right,
          lessThan(
            tester
                .getRect(find.byKey(const ValueKey('chat-tab-close-chat-b')))
                .left,
          ),
        );

        // A long name gets a second line before it truncates.
        expect(tester.widget<Text>(titleB).maxLines, 2);

        // Names read one step below body: the sheet is a dense list to scan,
        // not prose.
        expect(renderedFontSize(titleB), 14);

        // Spacing separates the pinned action from the list; no rule does.
        expect(
          find.descendant(
            of: find.byType(BottomSheet),
            matching: find.byType(Divider),
          ),
          findsNothing,
        );

        // The primary action is the design-system button.
        final newChat = find.byKey(const ValueKey('new-chat-button'));
        expect(tester.widget<CanopyButton>(newChat).glyph, isNotNull);
        expect(tester.getSize(newChat).height, CanopyButton.height);
        // Its label outweighs the row titles it sits under.
        expect(renderedFontSize(find.text('New chat')), 16);

        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('the pinned action clears the bottom system inset', (
        tester,
      ) async {
        usePhoneViewport(tester);
        tester.view.padding = const FakeViewPadding(bottom: 34 * 3);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        await tester.openTabsSheet();

        final screenHeight =
            tester.view.physicalSize.height / tester.view.devicePixelRatio;
        final newChat = tester.getRect(
          find.byKey(const ValueKey('new-chat-button')),
        );
        expect(screenHeight - newChat.bottom, greaterThanOrEqualTo(34 + 16));

        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('the FAB opens a sheet that switches the open chat', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));

        // No tab strip above the transcript any more: the titles are only
        // reachable through the sheet.
        expect(find.text('Answer in chat A'), findsOneWidget);
        expect(find.text('Chat B'), findsNothing);

        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsOneWidget);
        expect(find.byKey(const ValueKey('chat-tab-chat-b')), findsOneWidget);
        expect(find.byKey(const ValueKey('new-chat-button')), findsOneWidget);

        await tester.tap(find.byKey(const ValueKey('chat-tab-chat-b')));
        await tester.finishSheetDismiss();
        await tester.pump(const Duration(milliseconds: 20));

        // Selecting dismisses the sheet and swaps the transcript.
        expect(find.byKey(const ValueKey('chat-tab-chat-b')), findsNothing);
        expect(find.text('Answer in chat B'), findsOneWidget);
        expect(find.text('Answer in chat A'), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('the FAB carries an unread dot while any tab is unread', (
        tester,
      ) async {
        usePhoneViewport(tester);
        var unread = true;
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => twoChats(unreadB: unread)();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        final unreadDot = find.byKey(const ValueKey('chat-tabs-unread'));
        expect(unreadDot, findsOneWidget);

        // The dot is decorative: tapping its visible area still activates the
        // action underneath instead of carving a dead spot out of the target.
        await tester.tapAt(tester.getCenter(unreadDot));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byKey(const ValueKey('new-chat-button')), findsOneWidget);
        await tester.dismissTabsSheet();

        unread = false;
        await tester.runAsync(() => vm.refresh());
        await tester.pump();
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsNothing);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('the FAB dot prefers an unanswered question over unread', (
        tester,
      ) async {
        usePhoneViewport(tester);
        var question = true;
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () =>
              twoChats(unreadB: true, questionB: question)();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));

        // A question is not cleared by reading, so it outranks unread for
        // the one dot the button carries.
        final questionDot = find.byKey(const ValueKey('chat-tabs-question'));
        expect(questionDot, findsOneWidget);
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsNothing);
        expect(
          (tester.widget<Container>(questionDot).decoration as BoxDecoration)
              .color,
          StatusColors.light.warning,
        );

        // Answered on the desktop: the dot falls back to the unread signal
        // the other tab still carries.
        question = false;
        await tester.runAsync(() => vm.refresh());
        await tester.pump();
        expect(find.byKey(const ValueKey('chat-tabs-question')), findsNothing);
        expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('a running tab shows a spinner and no close control', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats(streamingB: true);
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));
        await tester.openTabsSheet();

        final rowB = find.byKey(const ValueKey('chat-tab-chat-b'));
        expect(
          find.descendant(of: rowB, matching: find.byType(ThinkingSpinner)),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('chat-tab-close-chat-b')),
          findsNothing,
        );
        // The idle tab keeps its close control.
        final closeA = find.byKey(const ValueKey('chat-tab-close-chat-a'));
        expect(closeA, findsOneWidget);

        // Progress and close share one trailing slot: the spinner stands
        // exactly where the close control would be, at the same footprint,
        // rather than beside the name in the status position.
        final spinner = find.descendant(
          of: rowB,
          matching: find.byType(ThinkingSpinner),
        );
        expect(
          tester.getRect(spinner).center.dx,
          tester.getRect(closeA).center.dx,
        );
        expect(
          tester.getSize(spinner),
          tester.getSize(
            find.descendant(of: closeA, matching: find.byType(CanopyIcon)),
          ),
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('New chat in the sheet mints a conversation', (tester) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));

        await tester.startNewChatFromSheet();
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 5)),
        );
        await tester.finishSheetDismiss();

        expect(repository.createChatTabTargets, hasLength(1));
        expect(repository.createChatTabTargets.single.chatId, isNotEmpty);
        expect(find.byKey(const ValueKey('new-chat-button')), findsNothing);
        expect(
          find.text('New conversation — send a message to start it.'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('closing a tab from the sheet closes it optimistically', (
        tester,
      ) async {
        usePhoneViewport(tester);
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = twoChats();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await tester.runAsync(() => vm.connect('123456'));
        await tester.pumpWidget(
          buildSubject(
            vm,
            RemoteChatScreen.worktree(worktree: vm.allWorktrees.single),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 20));

        await tester.closeTabFromSheet('chat-b');
        await tester.pump(const Duration(milliseconds: 20));

        expect(repository.closeChatTabTargets.single.chatId, 'chat-b');
        // The sheet is gone, and reopening it no longer lists the closed tab
        // even though the desktop still projects it.
        await tester.openTabsSheet();
        expect(find.byKey(const ValueKey('chat-tab-chat-b')), findsNothing);
        expect(find.byKey(const ValueKey('chat-tab-chat-a')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
        await repository.eventsController.close();
      });

      testWidgets('cowork chats have no tab FAB', (tester) async {
        usePhoneViewport(tester);
        final vm = await connectedViewModel(tester);
        await tester.pumpWidget(
          buildSubject(
            vm,
            const RemoteChatScreen.standalone(
              standaloneChat: RemoteStandaloneChat(
                localId: 'chat-arch',
                projectLocalId: 'ws-app',
                title: 'Original title',
                description: 'Desktop label',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('chat-tabs-fab')), findsNothing);
        // No synthetic tab strip: the app bar is the only label, and it keeps
        // preferring the desktop's resolved description over the raw title.
        expect(
          find.descendant(
            of: find.byType(CanopyAppBar),
            matching: find.text('Desktop label'),
          ),
          findsOneWidget,
        );
        expect(find.text('Original title'), findsNothing);
        await tester.pumpWidget(const SizedBox());
        vm.dispose();
      });
    });
  });
}

final class _CapabilityRefreshingRepository
    extends FakeRemoteControlRepository {
  int restoreSessionCalls = 0;

  @override
  Future<RemoteConnection?> restoreSession() async {
    restoreSessionCalls += 1;
    supportsChatAttachments = true;
    return RemoteConnection(
      deviceLabel: 'Updated Desktop',
      pairedAt: DateTime(2026),
    );
  }
}

final class _SingleFileAttachmentPicker implements AttachmentPicker {
  @override
  Future<AttachmentPickResult> pickFiles({int maxFiles = 8}) async =>
      AttachmentPickResult(AttachmentPickerOutcome.picked, [
        PickedAttachment(
          filename: 'notes.txt',
          mediaType: 'text/plain',
          bytes: Uint8List.fromList([1, 2, 3]),
        ),
      ]);

  @override
  Future<AttachmentPickResult> pickFromCamera({int maxFiles = 8}) async =>
      AttachmentPickResult.cancelled;

  @override
  Future<AttachmentPickResult> pickFromPhotoLibrary({int maxFiles = 8}) async =>
      AttachmentPickResult.cancelled;
}

/// One worktree whose only chat awaits answers, with no transcript rows
/// cached yet. A single question reads `Ship to prod?`; with more, each is
/// numbered `Ship to prod? (n)`.
RemoteSessionSnapshot _pendingQuestionSnapshot({int questionCount = 1}) =>
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
          chatId: 'chat-q',
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat Q',
          active: true,
          pendingQuestions: [
            for (var i = 1; i <= questionCount; i++)
              AskUserQuestionState(
                requestId: questionCount == 1 ? 'req-q' : 'req-q-$i',
                questions: [
                  AskUserQuestion(
                    id: 'q-$i',
                    header: 'Deploy',
                    question: questionCount == 1
                        ? 'Ship to prod?'
                        : 'Ship to prod? ($i)',
                    options: const ['Yes', 'No', 'Later', 'Ask again'],
                  ),
                ],
              ),
          ],
        ),
      ],
    );

final class _FailingChatHydrationRepository
    extends FakeRemoteControlRepository {
  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    throw const RemoteControlException('Transcript unavailable.');
  }
}

/// A pairing with a stable server session id. While [withholdTranscripts],
/// neither the server-cached tail nor the desktop transcript ever answers.
final class _ColdReopenRepository extends FakeRemoteControlRepository {
  bool withholdTranscripts = false;

  @override
  Future<RemoteConnection> connect(String pairingCode) async =>
      RemoteConnection(
        deviceLabel: 'Test Desktop',
        pairedAt: DateTime(2026),
        sessionId: 'session-1',
      );

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) {
    cachedChatFetches++;
    if (withholdTranscripts) return Completer<List<RemoteChatMessage>>().future;
    return Future.value(const []);
  }

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) {
    requestChatTranscriptCalls += 1;
    if (withholdTranscripts) return Completer<String?>().future;
    return Future.value('transcript-command');
  }
}

final class _ProvisionalStandaloneAttachmentRepository
    extends FakeRemoteControlRepository {
  final List<RemoteStandaloneChatTarget> createTargets = [];

  @override
  Future<String> createStandaloneChat(RemoteStandaloneChatTarget target) async {
    createTargets.add(target);
    return 'create-standalone-${createTargets.length}';
  }
}

final class _DeferredCreateChatRepository extends FakeRemoteControlRepository {
  final List<Completer<String>> _createCompleters = [];

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) {
    createChatTabTargets.add(target);
    final completer = Completer<String>();
    _createCompleters.add(completer);
    return completer.future;
  }

  void failCreate(int index) {
    _createCompleters[index].completeError(
      const RemoteControlException('Creation unavailable.'),
    );
  }

  void completeCreate(int index, String commandId) {
    _createCompleters[index].complete(commandId);
  }
}

void _orphanCompletionTests() {
  for (final standalone in [false, true]) {
    for (final check in ['working', 'unread', 'completed-tool-control']) {
      testWidgets(
        '${standalone ? 'standalone' : 'worktree'} $check after final answer and completed timer',
        (tester) async {
          tester.view.physicalSize = const Size(1170, 2532);
          tester.view.devicePixelRatio = 3;
          addTearDown(tester.view.reset);
          final scope = standalone
              ? RemoteChatScope.standalone
              : RemoteChatScope.worktree;
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true;
          repo.snapshotBuilder = () => RemoteSessionSnapshot(
            workspaces: const [],
            worktrees: const [
              RemoteWorktree(
                localId: 'wt',
                workspaceLocalId: 'ws',
                branch: 'main',
                hasUnread: true,
              ),
            ],
            standaloneChats: [
              if (standalone)
                const RemoteStandaloneChat(
                  localId: 'chat',
                  projectLocalId: 'ws',
                  title: 'Completed chat',
                  hasUnread: true,
                  hasActiveChat: false,
                ),
            ],
            chatSummaries: [
              if (!standalone)
                RemoteChatSummary(
                  chatId: 'chat',
                  scope: scope,
                  workspaceLocalId: 'ws',
                  worktreeLocalId: 'wt',
                  title: 'Completed chat',
                  turnActive: false,
                  hasUnread: true,
                ),
            ],
          );
          final vm = RemoteControlViewModel(repository: repo);
          await tester.runAsync(() => vm.connect('123456'));
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
                theme: AppTheme.dark,
                home: standalone
                    ? RemoteChatScreen.standalone(
                        standaloneChat: vm.allStandaloneChats.single,
                      )
                    : RemoteChatScreen.worktree(
                        worktree: vm.allWorktrees.single,
                        initialChatId: 'chat',
                      ),
              ),
            ),
          );
          await tester.pump();
          RemoteChatMessage row(
            String id,
            ChatRole role, {
            String text = '',
            bool streaming = false,
            List<ChatPart> parts = const [],
          }) => RemoteChatMessage(
            messageId: id,
            chatId: 'chat',
            scope: scope,
            role: role,
            status: streaming
                ? ChatMessageStatus.streaming
                : ChatMessageStatus.complete,
            text: text,
            parts: parts,
          );
          void emit(List<RemoteChatMessage> rows, int cursor) =>
              repo.eventsController.add(
                RemotePortalEventBatch(
                  events: [
                    for (final message in rows)
                      RemoteChatMessageEvent(
                        chatId: 'chat',
                        scope: scope,
                        message: message,
                      ),
                  ],
                  nextCursor: cursor,
                ),
              );
          emit([
            row('user', ChatRole.user, text: 'Check the chat'),
            row(
              'timer',
              ChatRole.system,
              streaming: true,
              parts: const [
                ChatPart(
                  kind: 'turn_timer',
                  data: {'startedAt': 1000, 'completedAt': null},
                ),
              ],
            ),
            row(
              'unfinished-tool',
              ChatRole.system,
              streaming: check != 'completed-tool-control',
              parts: [
                const ChatPart(
                  kind: 'tool_use',
                  data: {
                    'toolUseId': 'graph',
                    'toolName': 'canopy_build_or_update_code_graph',
                    'input': '{}',
                  },
                ),
                if (check == 'completed-tool-control')
                  const ChatPart(
                    kind: 'tool_result',
                    data: {
                      'toolUseId': 'graph',
                      'output': 'Done',
                      'isError': false,
                    },
                  ),
              ],
            ),
          ], 1);
          await tester.pump();
          expect(
            find.byKey(const ValueKey('remote-chat-working-indicator')),
            findsOneWidget,
          );
          expect(repo.markReadCalls, isEmpty);
          if (!standalone) {
            expect(
              find.byKey(const ValueKey('chat-tabs-unread')),
              findsOneWidget,
            );
          }
          emit([
            row('answer', ChatRole.assistant, text: 'The turn is complete.'),
            row(
              'timer',
              ChatRole.system,
              parts: const [
                ChatPart(
                  kind: 'turn_timer',
                  data: {'startedAt': 1000, 'completedAt': 2000},
                ),
              ],
            ),
          ], 2);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 250));
          expect(tester.takeException(), isNull);
          expect(find.text('The turn is complete.'), findsOneWidget);
          final working = find
              .byKey(const ValueKey('remote-chat-working-indicator'))
              .evaluate()
              .length;
          final unread = standalone
              ? vm.allStandaloneChats.single.hasUnread
              : vm.allChatSummaries.single.hasUnread;
          final reads = repo.markReadCalls.toList();
          final unreadDots = find
              .byKey(const ValueKey('chat-tabs-unread'))
              .evaluate()
              .length;
          // Clean up before a red assertion so watchdog timers cannot mask it.
          await tester.pumpWidget(const SizedBox());
          vm.dispose();
          await tester.pump();
          if (check != 'unread') expect(working, 0);
          if (check != 'working') {
            expect(unread, isFalse);
            if (!standalone) expect(unreadDots, 0);
            expect(reads, hasLength(1));
            expect(reads.single.lastMessageId, 'answer');
          }
        },
      );
    }
  }
}
