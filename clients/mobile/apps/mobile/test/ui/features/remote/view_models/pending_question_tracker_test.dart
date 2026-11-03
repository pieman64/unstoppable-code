import 'package:mobile/ui/features/remote/view_models/pending_question_tracker.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import '../../../../support/fake_remote_control_repository.dart';

final class _GatedQuestionRepository extends FakeRemoteControlRepository {
  final answerCompleter = Completer<String>();

  @override
  Future<String> answerChatQuestion(
    RemoteWorktreeChatTarget target, {
    required String requestId,
    required List<AskUserQuestionAnswer> answers,
  }) => answerCompleter.future;
}

void main() {
  group('RemoteControlViewModel pending questions', () {
    RemoteSessionSnapshot snapshotWithQuestions({
      List<Map<String, dynamic>>? pendingQuestions,
    }) => RemoteSessionSnapshot.fromJson({
      'workspaces': const [],
      'worktrees': const [],
      'standaloneChats': const [],
      'chatMessages': const [],
      'chatSummaries': [
        {
          'chatId': 'chat-1',
          'scope': 'worktree',
          'title': 'Chat',
          'workspaceLocalId': 'ws-1',
          'worktreeLocalId': 'wt-1',
          'pendingQuestions': ?pendingQuestions,
        },
      ],
    });

    const target = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
    );

    test(
      'reset releases optimistic answers and invalidates the attention memo',
      () async {
        final repository = FakeRemoteControlRepository();
        addTearDown(repository.eventsController.close);
        final snapshot = snapshotWithQuestions(
          pendingQuestions: [
            {
              'requestId': 'req-reset',
              'answered': false,
              'questions': const [],
            },
          ],
        );
        var notifications = 0;
        final tracker = PendingQuestionTracker(
          repository: repository,
          notify: () => notifications++,
          snapshot: () => snapshot,
          commands: OwnedCommandRegistry(notify: () {}),
        );
        addTearDown(tracker.dispose);
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );
        final before = tracker.chatsNeedingAnswerFor(worktree);
        expect(before, {'chat-1'});
        expect(tracker.chatsNeedingAnswerFor(worktree), same(before));
        await tracker.dismissQuestion(target, requestId: 'req-reset');
        expect(notifications, 1);
        expect(tracker.pendingQuestionsFor(target), isEmpty);
        expect(tracker.worktreeNeedsAnswer(worktree), isFalse);
        tracker.reset();
        expect(
          tracker.pendingQuestionsFor(target).single.requestId,
          'req-reset',
        );
        expect(tracker.chatsNeedingAnswerFor(worktree), {'chat-1'});
        expect(tracker.chatsNeedingAnswerFor(worktree), isNot(same(before)));
      },
    );

    test(
      'pendingQuestionsFor returns unanswered questions for the chat',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => snapshotWithQuestions(
            pendingQuestions: [
              {
                'requestId': 'req-1',
                'answered': false,
                'questions': [
                  {
                    'question': 'Pick',
                    'options': ['A', 'B'],
                  },
                ],
              },
              {'requestId': 'req-2', 'answered': true, 'questions': const []},
            ],
          );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');
        expect(vm.pendingQuestionsFor(target).single.requestId, 'req-1');
        expect(
          vm.chatsNeedingAnswerFor(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          {'chat-1'},
        );
        expect(
          vm.worktreeNeedsAnswer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isTrue,
        );
        expect(
          vm.worktreeNeedsAnswer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'another-workspace',
              branch: 'main',
            ),
          ),
          isFalse,
        );
      },
    );

    test('chatsNeedingAnswerFor is scoped and memoized', () async {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => RemoteSessionSnapshot.fromJson({
          'workspaces': const [],
          'worktrees': const [],
          'standaloneChats': const [],
          'chatMessages': const [],
          'chatSummaries': [
            for (final worktreeId in ['wt-1', 'wt-2'])
              {
                'chatId': 'chat-1',
                'scope': 'worktree',
                'title': 'Chat',
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': worktreeId,
                'pendingQuestions': worktreeId == 'wt-1'
                    ? [
                        {
                          'requestId': 'req-1',
                          'answered': false,
                          'questions': const [],
                        },
                      ]
                    : const [],
              },
          ],
        });
      final vm = RemoteControlViewModel(repository: repository);
      await vm.connect('123456');
      const owningWorktree = RemoteWorktree(
        localId: 'wt-1',
        workspaceLocalId: 'ws-1',
        branch: 'main',
      );
      const unrelatedWorktree = RemoteWorktree(
        localId: 'wt-2',
        workspaceLocalId: 'ws-1',
        branch: 'other',
      );
      final first = vm.chatsNeedingAnswerFor(owningWorktree);
      expect(first, {'chat-1'});
      expect(vm.chatsNeedingAnswerFor(unrelatedWorktree), isEmpty);
      // Row builders read this once per worktree per frame; recomputing the
      // set over every summary on each read is the cost being pinned here.
      expect(
        identical(first, vm.chatsNeedingAnswerFor(owningWorktree)),
        isTrue,
      );
    });

    test(
      'answerQuestion optimistically hides the request and calls the repo',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => snapshotWithQuestions(
            pendingQuestions: [
              {'requestId': 'req-1', 'answered': false, 'questions': const []},
            ],
          );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');
        await vm.answerQuestion(
          target,
          requestId: 'req-1',
          answers: const [
            AskUserQuestionAnswer(question: 'Pick', selectedOptions: ['A']),
          ],
        );
        expect(repository.lastAnswerRequestId, 'req-1');
        expect(vm.pendingQuestionsFor(target), isEmpty);
        expect(
          vm.chatsNeedingAnswerFor(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isEmpty,
        );
        expect(
          vm.worktreeNeedsAnswer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isFalse,
        );
      },
    );

    test('dismissQuestion optimistically hides the request', () async {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => snapshotWithQuestions(
          pendingQuestions: [
            {'requestId': 'req-1', 'answered': false, 'questions': const []},
          ],
        );
      final vm = RemoteControlViewModel(repository: repository);
      await vm.connect('123456');
      await vm.dismissQuestion(target, requestId: 'req-1');
      expect(repository.lastDismissRequestId, 'req-1');
      expect(vm.pendingQuestionsFor(target), isEmpty);
      expect(
        vm.chatsNeedingAnswerFor(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        isEmpty,
      );
      expect(
        vm.worktreeNeedsAnswer(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        isFalse,
      );
    });

    test('an asynchronous answer failure restores the question card', () async {
      final repository = FakeRemoteControlRepository()
        ..snapshotBuilder = () => snapshotWithQuestions(
          pendingQuestions: [
            {'requestId': 'req-1', 'answered': false, 'questions': const []},
          ],
        );
      final vm = RemoteControlViewModel(repository: repository);
      await vm.connect('123456');
      await vm.answerQuestion(target, requestId: 'req-1', answers: const []);
      expect(vm.pendingQuestionsFor(target), isEmpty);
      expect(
        vm.chatsNeedingAnswerFor(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        isEmpty,
      );
      expect(
        vm.worktreeNeedsAnswer(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        isFalse,
      );

      repository.eventsController.add(
        const RemotePortalEventBatch(
          events: [
            RemoteCommandFailedEvent(
              message: 'The answer was rejected.',
              commandId: 'fake-cmd-1',
            ),
          ],
          nextCursor: 1,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(vm.pendingQuestionsFor(target).single.requestId, 'req-1');
      expect(
        vm.chatsNeedingAnswerFor(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        {'chat-1'},
      );
      expect(
        vm.worktreeNeedsAnswer(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'ws-1',
            branch: 'main',
          ),
        ),
        isTrue,
      );
      expect(
        vm.worktreeNeedsAnswer(
          const RemoteWorktree(
            localId: 'wt-1',
            workspaceLocalId: 'another-workspace',
            branch: 'main',
          ),
        ),
        isFalse,
      );
      expect(vm.commandFailureMessage, 'The answer was rejected.');
    });

    test(
      'an answer failure racing ahead of submit acknowledgement restores the card',
      () async {
        final repository = _GatedQuestionRepository()
          ..snapshotBuilder = () => snapshotWithQuestions(
            pendingQuestions: [
              {
                'requestId': 'req-race',
                'answered': false,
                'questions': const [],
              },
            ],
          );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');

        final answer = vm.answerQuestion(
          target,
          requestId: 'req-race',
          answers: const [],
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.pendingQuestionsFor(target), isEmpty);
        expect(
          vm.chatsNeedingAnswerFor(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isEmpty,
        );
        expect(
          vm.worktreeNeedsAnswer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isFalse,
        );
        repository.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteCommandFailedEvent(
                message: 'The answer failed early.',
                commandId: 'cmd-race',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        repository.answerCompleter.complete('cmd-race');

        await expectLater(answer, throwsA(isA<RemoteControlException>()));
        expect(vm.pendingQuestionsFor(target).single.requestId, 'req-race');
      },
    );

    test(
      'a re-fetch omitting pendingQuestions preserves cached questions',
      () async {
        var includeQuestions = true;
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => snapshotWithQuestions(
          pendingQuestions: includeQuestions
              ? [
                  {
                    'requestId': 'req-1',
                    'answered': false,
                    'questions': const [],
                  },
                ]
              : null,
        );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');
        includeQuestions = false;
        await vm.refresh();
        expect(vm.pendingQuestionsFor(target), hasLength(1));
      },
    );

    test(
      'a truncated chat snapshot merges the tail instead of replacing',
      () async {
        final repository = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
        );
        await vm.connect('123456');

        Map<String, dynamic> wireMessage(String id, String text) => {
          'messageId': id,
          'chatId': 'chat-1',
          'scope': 'worktree',
          'role': 'assistant',
          'status': 'complete',
          'text': text,
        };

        // Seed a newer row via a live chat event that races ahead of the
        // truncated snapshot containing its predecessor.
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.chat.event',
                'payload': {
                  'chatId': 'chat-1',
                  'scope': 'worktree',
                  'message': wireMessage('msg-new', 'newer live row'),
                },
              },
            ],
            'nextCursor': 1,
          }),
        );
        await Future<void>.delayed(Duration.zero);

        const chatTarget = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-1',
        );
        expect(vm.messagesFor(chatTarget), hasLength(1));

        // The snapshot must insert the missing earlier row before the cached
        // live row while keeping the duplicate newer row only once.
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.snapshot',
                'payload': {
                  'scope': 'chat',
                  'target': {'chatLocalId': 'chat-1'},
                  'chatMessagesTruncated': true,
                  'chatMessages': [
                    wireMessage('msg-middle', 'earlier snapshot row'),
                    wireMessage('msg-new', 'newer snapshot row'),
                  ],
                },
              },
            ],
            'nextCursor': 2,
          }),
        );
        await Future<void>.delayed(Duration.zero);

        var texts = vm.messagesFor(chatTarget).map((m) => m.text).toList();
        expect(texts, ['earlier snapshot row', 'newer snapshot row']);

        // A newer live row can arrive after the desktop assembled the next
        // snapshot tail. It must stay after that tail instead of being moved
        // ahead of it as a presumed cached prefix.
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.chat.event',
                'payload': {
                  'chatId': 'chat-1',
                  'scope': 'worktree',
                  'message': wireMessage('msg-latest', 'latest live row'),
                },
              },
            ],
            'nextCursor': 3,
          }),
        );
        await Future<void>.delayed(Duration.zero);
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.snapshot',
                'payload': {
                  'scope': 'chat',
                  'target': {'chatLocalId': 'chat-1'},
                  'chatMessagesTruncated': true,
                  'chatMessages': [
                    wireMessage('msg-middle', 'earlier snapshot row'),
                    wireMessage('msg-new', 'newer snapshot row'),
                  ],
                },
              },
            ],
            'nextCursor': 4,
          }),
        );
        await Future<void>.delayed(Duration.zero);

        texts = vm.messagesFor(chatTarget).map((m) => m.text).toList();
        expect(texts, [
          'earlier snapshot row',
          'newer snapshot row',
          'latest live row',
        ]);

        // A full (non-truncated) snapshot stays authoritative and replaces.
        repository.eventsController.add(
          RemotePortalEventBatch.fromJson({
            'events': [
              {
                'type': 'portal.state.snapshot',
                'payload': {
                  'scope': 'chat',
                  'target': {'chatLocalId': 'chat-1'},
                  'chatMessages': [wireMessage('msg-new', 'the full window')],
                },
              },
            ],
            'nextCursor': 5,
          }),
        );
        await Future<void>.delayed(Duration.zero);

        texts = vm.messagesFor(chatTarget).map((m) => m.text).toList();
        expect(texts, ['the full window']);
      },
    );

    test(
      'an explicit empty pendingQuestions clears cached questions',
      () async {
        var includeQuestions = true;
        final repository = FakeRemoteControlRepository();
        repository.snapshotBuilder = () => snapshotWithQuestions(
          pendingQuestions: includeQuestions
              ? [
                  {
                    'requestId': 'req-1',
                    'answered': false,
                    'questions': const [],
                  },
                ]
              : const [],
        );
        final vm = RemoteControlViewModel(repository: repository);
        await vm.connect('123456');
        includeQuestions = false;
        await vm.refresh();
        expect(vm.pendingQuestionsFor(target), isEmpty);
        expect(
          vm.chatsNeedingAnswerFor(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isEmpty,
        );
        expect(
          vm.worktreeNeedsAnswer(
            const RemoteWorktree(
              localId: 'wt-1',
              workspaceLocalId: 'ws-1',
              branch: 'main',
            ),
          ),
          isFalse,
        );
      },
    );
  });
}
