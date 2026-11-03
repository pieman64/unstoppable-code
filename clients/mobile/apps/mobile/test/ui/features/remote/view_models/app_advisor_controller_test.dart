import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_app_advisor.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/app_advisor_controller.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';

import '../../../../support/fake_remote_control_repository.dart';

RemoteAppAdvisorChat _chat(
  String chatId, {
  String? workEntryId,
  String? workEntryTitle,
  int? workEntryOrder,
  int? order,
  bool? active,
  bool? turnActive,
  List<Map<String, dynamic>>? pendingQuestions,
}) => RemoteAppAdvisorChat.fromJson({
  'chatId': chatId,
  'title': 'Chat $chatId',
  'workEntryId': ?workEntryId,
  'workEntryTitle': ?workEntryTitle,
  'workEntryOrder': ?workEntryOrder,
  'order': ?order,
  'active': ?active,
  'turnActive': ?turnActive,
  'pendingQuestions': ?pendingQuestions,
});

RemoteChatMessage _message(
  String chatId,
  String messageId, {
  ChatRole role = ChatRole.assistant,
  ChatMessageStatus status = ChatMessageStatus.complete,
  String text = '',
  int? createdAtMs,
}) => RemoteChatMessage.fromWireJson({
  'messageId': messageId,
  'chatId': chatId,
  'role': role.name,
  'status': status.wire,
  'text': text,
  'createdAtMs': ?createdAtMs,
});

Map<String, dynamic> _question(String requestId) => {
  'requestId': requestId,
  'questions': [
    {'question': 'Ship it?'},
  ],
};

void main() {
  late FakeRemoteControlRepository repository;
  late OwnedCommandRegistry commands;
  late bool connected;
  late int notifications;
  late int ids;

  RemoteAppAdvisorController build() => RemoteAppAdvisorController(
    advisorCommands: repository.appAdvisor,
    commands: commands,
    isConnected: () => connected,
    notify: () => notifications++,
    clock: () => DateTime.utc(2026, 10, 18),
    mintId: () => 'id-${++ids}',
  );

  void complete(String commandId, [Map<String, dynamic>? result]) =>
      commands.handleCompleted(commandId, result, projectionSequence: 0);

  void fail(String commandId, String message) =>
      commands.handleFailed(commandId, message, projectionSequence: 0);

  setUp(() {
    repository = FakeRemoteControlRepository()..supportsAppAdvisor = true;
    commands = OwnedCommandRegistry(notify: () {});
    connected = true;
    notifications = 0;
    ids = 0;
  });

  group('late command outcomes after fresh recovery', () {
    test(
      'first-send rejection releases the composer and permits resend',
      () async {
        final advisor = build();
        addTearDown(advisor.dispose);
        final first = advisor.send(text: 'Keep my text');
        final outcome = expectLater(
          first,
          throwsA(isA<RemoteControlException>()),
        );
        await pumpEventQueue();
        advisor.reloadAfterSkippedEvents();
        commands.invalidateAfterSkippedEvents();
        await outcome;
        fail('advisor-1', 'Rejected by desktop');
        expect(advisor.isStartingChat, isFalse);
        final row = advisor.messagesFor('').single;
        expect(row.delivery, ChatDelivery.notSent);
        final retry = advisor.resend(null, row.messageId);
        await pumpEventQueue();
        complete('advisor-2', {'chatId': 'retry-chat'});
        expect(await retry, 'retry-chat');
        final next = advisor.send(text: 'A separate chat');
        await pumpEventQueue();
        complete('advisor-3', {'chatId': 'new-chat'});
        expect(await next, 'new-chat');
      },
    );

    test('existing-chat rejection makes retained text resendable', () async {
      final advisor = build()
        ..applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1')]));
      addTearDown(advisor.dispose);
      await advisor.send(chatId: 'c1', text: 'Keep this too');
      advisor.reloadAfterSkippedEvents();
      commands.invalidateAfterSkippedEvents();
      fail('advisor-1', 'Rejected by desktop');
      final row = advisor.messagesFor('c1').single;
      expect(row.delivery, ChatDelivery.notSent);
      expect(await advisor.resend('c1', row.messageId), 'c1');
      expect(repository.appAdvisorCommands, hasLength(2));
    });

    test('tab rejection rolls back the retained pending tab', () async {
      final advisor = build()
        ..applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1')]));
      addTearDown(advisor.dispose);
      final tab = advisor.createTab(advisor.entries.single);
      await pumpEventQueue();
      advisor.reloadAfterSkippedEvents();
      commands.invalidateAfterSkippedEvents();
      fail('advisor-1', 'Tab rejected');
      expect(advisor.entries.single.tabs.map((tab) => tab.chatId), ['c1']);
      expect(advisor.actionError, 'Tab rejected');
      expect(
        advisor.entries.single.tabs.any((item) => item.chatId == tab),
        isFalse,
      );
    });
  });

  group('hydration', () {
    test('requests state and settles on the untargeted snapshot', () async {
      final advisor = build();
      await advisor.hydrate();
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.state.request',
        'scope': 'app_advisor',
      });
      expect(advisor.isHydrating, isTrue);

      advisor.applySnapshot(
        RemoteAppAdvisorSnapshotEvent(
          chats: [
            _chat(
              'b1',
              workEntryId: 'b',
              workEntryTitle: 'Second',
              workEntryOrder: 1,
              order: 1,
            ),
            _chat(
              'a1',
              workEntryId: 'a',
              workEntryTitle: 'First',
              workEntryOrder: 0,
            ),
            _chat(
              'b0',
              workEntryId: 'b',
              workEntryOrder: 1,
              order: 0,
              active: true,
            ),
          ],
          chatMessages: [
            _message('a1', 'm2', createdAtMs: 2000),
            _message('a1', 'm1', createdAtMs: 1000),
          ],
        ),
      );

      expect(advisor.isHydrated, isTrue);
      expect(advisor.isHydrating, isFalse);
      final [first, second] = advisor.entries;
      expect(first.title, 'First');
      expect(second.title, 'Second');
      expect([for (final tab in second.tabs) tab.chatId], ['b0', 'b1']);
      expect(second.activeChatId, 'b0');
      expect(
        [for (final row in advisor.messagesFor('a1')) row.messageId],
        ['m1', 'm2'],
      );
    });

    test('an untargeted snapshot replaces the list', () {
      final advisor = build()
        ..applySnapshot(
          RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1'), _chat('c2')]),
        )
        ..applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: [_chat('c2')]));
      expect([for (final entry in advisor.entries) entry.key], ['c2']);
    });

    test('a rejected request shows an error', () async {
      final advisor = build();
      await advisor.hydrate();
      fail('advisor-1', 'Orchestrator is unavailable in this desktop build.');
      expect(advisor.isHydrating, isFalse);
      expect(
        advisor.hydrationError,
        'Orchestrator is unavailable in this desktop build.',
      );
    });

    test('a timed-out hydration failure cannot settle its retry', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.hydrate();
        async.flushMicrotasks();
        async.elapse(kRemoteAppAdvisorHydrationTimeout);
        advisor.hydrate();
        async.flushMicrotasks();
        fail('advisor-1', 'Old failure');
        expect(advisor.isHydrating, isTrue);
        expect(advisor.hydrationError, isNull);
        async.elapse(kRemoteAppAdvisorHydrationTimeout);
        expect(advisor.hydrationError, kRemoteAppAdvisorHydrationFailed);
        advisor.dispose();
      });
    });

    test('a discarded pairing hydration cannot fail the new pairing', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.hydrate();
        async.flushMicrotasks();
        advisor.reset();
        advisor.hydrate();
        async.flushMicrotasks();
        fail('advisor-1', 'Old pairing');
        expect(advisor.isHydrating, isTrue);
        expect(advisor.hydrationError, isNull);
        advisor.dispose();
      });
    });

    for (final resetPairing in [false, true]) {
      test('late hydration submit failure is ignored, reset=$resetPairing', () {
        fakeAsync((async) {
          final advisor = build();
          final gate = Completer<void>();
          repository.appAdvisorSubmitGate = gate;
          advisor.hydrate();
          async.flushMicrotasks();
          if (resetPairing) {
            advisor.reset();
          } else {
            async.elapse(kRemoteAppAdvisorHydrationTimeout);
          }
          repository.appAdvisorSubmitGate = null;
          advisor.hydrate();
          async.flushMicrotasks();
          gate.completeError(const RemoteControlException('Old submit failed'));
          async.flushMicrotasks();
          expect(advisor.isHydrating, isTrue);
          expect(advisor.hydrationError, isNull);
          advisor.dispose();
        });
      });
    }

    test('an unanswered request times out', () {
      fakeAsync((async) {
        final advisor = RemoteAppAdvisorController(
          advisorCommands: repository.appAdvisor,
          commands: commands,
          isConnected: () => connected,
          notify: () {},
        );
        advisor.hydrate();
        async.elapse(kRemoteAppAdvisorHydrationTimeout);
        expect(advisor.hydrationError, kRemoteAppAdvisorHydrationFailed);
      });
    });
  });

  group('snapshot revisions', () {
    test('an unversioned persisted seed cannot rewind a live revision', () {
      final advisor = build()
        ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]))
        ..applyMessage(
          RemoteAppAdvisorMessageEvent(
            chatId: 'c1',
            message: _message(
              'c1',
              'm1',
              text: 'Live',
              createdAtMs: 1000,
            ).withUpdatedAt(DateTime.fromMillisecondsSinceEpoch(3000)),
          ),
        )
        ..applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [_chat('c1')],
            chatMessages: [
              _message('c1', 'm1', text: 'Persisted', createdAtMs: 1000),
            ],
          ),
        );
      expect(advisor.messagesFor('c1').single.text, 'Live');
    });

    for (final targeted in [false, true]) {
      test('delayed snapshot preserves newer live row, targeted=$targeted', () {
        final advisor = build()
          ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]))
          ..applyMessage(
            RemoteAppAdvisorMessageEvent(
              chatId: 'c1',
              message: _message(
                'c1',
                'm1',
                text: 'Live',
                createdAtMs: 1000,
              ).withUpdatedAt(DateTime.fromMillisecondsSinceEpoch(3000)),
            ),
          )
          ..applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [_chat('c1')],
              targetChatId: targeted ? 'c1' : null,
              chatMessages: [
                _message(
                  'c1',
                  'm1',
                  text: 'Stale',
                  createdAtMs: 1000,
                ).withUpdatedAt(DateTime.fromMillisecondsSinceEpoch(2000)),
              ],
            ),
          );
        expect(advisor.messagesFor('c1').single.text, 'Live');
        advisor.applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [_chat('c1')],
            targetChatId: targeted ? 'c1' : null,
            chatMessages: [
              _message(
                'c1',
                'm1',
                text: 'Newer',
                createdAtMs: 1000,
              ).withUpdatedAt(DateTime.fromMillisecondsSinceEpoch(4000)),
            ],
          ),
        );
        expect(advisor.messagesFor('c1').single.text, 'Newer');
      });
    }
  });

  group('streaming', () {
    for (final rejected in [false, true]) {
      test(
        'pending follow-up preserves active turn, rejected=$rejected',
        () async {
          final advisor = build()
            ..applySnapshot(
              RemoteAppAdvisorSnapshotEvent(
                chats: [_chat('c1')],
                chatMessages: [
                  _message(
                    'c1',
                    'reply',
                    status: ChatMessageStatus.streaming,
                    createdAtMs: 1000,
                  ),
                ],
              ),
            );
          expect(advisor.isRunning('c1'), isTrue);
          await advisor.send(chatId: 'c1', text: 'Follow up');
          if (rejected) {
            fail('advisor-1', 'Busy');
            expect(
              advisor.messagesFor('c1').last.delivery,
              ChatDelivery.notSent,
            );
          }
          expect(advisor.isRunning('c1'), isTrue);
          advisor.applyMessage(
            RemoteAppAdvisorMessageEvent(
              chatId: 'c1',
              message: _message('c1', 'reply', createdAtMs: 1000),
            ),
          );
          expect(advisor.isRunning('c1'), isFalse);
        },
      );
    }

    test('upserts messages in place, including turn-timer frames', () {
      final advisor = build();
      advisor.applyMessage(
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: _message(
            'c1',
            'u1:turn-timer',
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
          ),
        ),
      );
      advisor.applyMessage(
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: _message(
            'c1',
            'a1',
            status: ChatMessageStatus.streaming,
            text: 'Work',
          ),
        ),
      );
      expect(advisor.isRunning('c1'), isTrue);

      advisor
        ..applyMessage(
          RemoteAppAdvisorMessageEvent(
            chatId: 'c1',
            message: _message('c1', 'a1', text: 'Working on it'),
          ),
        )
        ..applyMessage(
          RemoteAppAdvisorMessageEvent(
            chatId: 'c1',
            message: _message('c1', 'u1:turn-timer', role: ChatRole.system),
          ),
        );

      final rows = advisor.messagesFor('c1');
      expect([for (final row in rows) row.messageId], ['u1:turn-timer', 'a1']);
      expect(rows.last.text, 'Working on it');
      expect(advisor.isRunning('c1'), isFalse);
    });

    test('a delta keeps cached questions when it omits them', () {
      final advisor = build()
        ..applyDelta(
          RemoteAppAdvisorDeltaEvent(
            chats: [
              _chat('c1', pendingQuestions: [_question('q1')]),
            ],
          ),
        )
        ..applyDelta(
          RemoteAppAdvisorDeltaEvent(chats: [_chat('c1', turnActive: true)]),
        );
      expect(advisor.pendingQuestionsFor('c1').single.requestId, 'q1');
      expect(advisor.isRunning('c1'), isTrue);

      advisor.applyDelta(
        RemoteAppAdvisorDeltaEvent(chats: [_chat('c1', pendingQuestions: [])]),
      );
      expect(advisor.pendingQuestionsFor('c1'), isEmpty);
    });
  });

  group('review regressions', () {
    for (final echoFirst in [false, true]) {
      test(
        'existing-chat transport uncertainty reconciles, echoFirst=$echoFirst',
        () async {
          final advisor = build();
          final gate = Completer<void>();
          repository.appAdvisorSubmitGate = gate;
          final sent = advisor.send(chatId: 'c1', text: 'Only once');
          final failure = expectLater(
            sent,
            throwsA(isA<RemoteControlException>()),
          );
          void echo() => advisor.applyMessage(
            RemoteAppAdvisorMessageEvent(
              chatId: 'c1',
              message: _message(
                'c1',
                'id-1',
                role: ChatRole.user,
                text: 'Only once',
                createdAtMs: 1000,
              ),
            ),
          );
          if (echoFirst) echo();
          gate.completeError(
            const RemoteChatSendOutcomeUnknownException('Response lost'),
          );
          await failure;
          expect(
            advisor.messagesFor('c1').single.delivery,
            echoFirst ? isNull : ChatDelivery.uncertain,
          );
          await advisor.resend('c1', 'id-1');
          expect(repository.appAdvisorCommands, hasLength(1));
          if (!echoFirst) echo();
          expect(advisor.messagesFor('c1').single.delivery, isNull);
          advisor.dispose();
        },
      );
    }

    test(
      'an unrelated first send does not block existing-chat resend',
      () async {
        final advisor = build();
        await advisor.send(chatId: 'c1', text: 'Retry me');
        fail('advisor-1', 'Busy');
        advisor.send(text: 'New chat').ignore();
        await Future<void>.delayed(Duration.zero);
        expect(advisor.isStartingChat, isTrue);
        await advisor.resend('c1', 'id-1');
        expect(repository.appAdvisorCommands.last['chatId'], 'c1');
        expect(repository.appAdvisorCommands.last['userMessageId'], 'id-1');
        advisor.dispose();
      },
    );

    for (final source in ['message', 'snapshot']) {
      test('a lost first-send response reconciles a late $source', () async {
        final advisor = build();
        repository.appAdvisorError =
            const RemoteChatSendOutcomeUnknownException('Response lost');
        await expectLater(
          advisor.send(text: 'Only once'),
          throwsA(isA<RemoteControlException>()),
        );
        expect(advisor.isStartingChat, isTrue);
        expect(advisor.messagesFor('').single.delivery, ChatDelivery.uncertain);
        await advisor.resend(null, 'id-1');
        expect(repository.appAdvisorCommands, hasLength(1));
        final echo = _message(
          'new-1',
          'id-1',
          role: ChatRole.user,
          text: 'Only once',
        );
        if (source == 'message') {
          advisor.applyMessage(
            RemoteAppAdvisorMessageEvent(chatId: 'new-1', message: echo),
          );
        } else {
          advisor.applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [_chat('new-1')],
              chatMessages: [echo],
            ),
          );
        }
        expect(advisor.isStartingChat, isFalse);
        expect(advisor.messagesFor(''), isEmpty);
        expect(advisor.messagesFor('new-1').single.delivery, isNull);
        await advisor.send(chatId: 'new-1', text: 'Next');
        expect(repository.appAdvisorCommands.last['chatId'], 'new-1');
        advisor.dispose();
      });
    }

    for (final positioned in [false, true]) {
      test(
        'follow-up overlay preserves canonical order, positioned=$positioned',
        () async {
          final advisor = build();
          void echo(String id, ChatRole role, int position) =>
              advisor.applyMessage(
                RemoteAppAdvisorMessageEvent(
                  chatId: 'c1',
                  message: _message(
                    'c1',
                    id,
                    role: role,
                    text: id,
                    createdAtMs: positioned ? position : null,
                  ),
                ),
              );
          echo('u1', ChatRole.user, 1000);
          echo('a1', ChatRole.assistant, 2000);
          await advisor.send(chatId: 'c1', text: 'Follow up');
          echo('a2', ChatRole.assistant, 3000);
          expect(advisor.messagesFor('c1').map((row) => row.messageId), [
            'u1',
            'a1',
            'a2',
            'id-1',
          ]);
          echo('id-1', ChatRole.user, 4000);
          echo('a3', ChatRole.assistant, 5000);
          final turns = groupChatTurns(advisor.messagesFor('c1'));
          expect(turns.map((turn) => turn.user?.messageId), ['u1', 'id-1']);
          expect(turns.first.assistantMessages.map((row) => row.messageId), [
            'a1',
            'a2',
          ]);
          expect(turns.last.assistantMessages.single.messageId, 'a3');
          expect(advisor.messagesFor('c1').map((row) => row.messageId), [
            'u1',
            'a1',
            'a2',
            'id-1',
            'a3',
          ]);
          advisor.dispose();
        },
      );
    }

    test(
      'the first-send deadline settles while its HTTP submission is still pending',
      () {
        fakeAsync((async) {
          final gate = Completer<void>();
          repository.appAdvisorSubmitGate = gate;
          final advisor = build();
          Object? failure;
          advisor.send(text: 'Slow submission').catchError((Object error) {
            failure = error;
            return '';
          });
          async.elapse(kRemoteAppAdvisorFirstSendTimeout);
          expect(failure, isA<RemoteControlException>());
          gate.complete();
          async.flushMicrotasks();
          complete('advisor-1', {'chatId': 'late-chat'});
          expect(
            advisor.messagesFor('late-chat').single.text,
            'Slow submission',
          );
          advisor.dispose();
        });
      },
    );

    test(
      'a resend rejection buffered before submission settles keeps its text',
      () {
        fakeAsync((async) {
          final advisor = build();
          advisor.send(chatId: 'c1', text: 'Keep me');
          async.flushMicrotasks();
          fail('advisor-1', 'Busy');
          final gate = Completer<void>();
          repository.appAdvisorSubmitGate = gate;
          advisor.resend('c1', 'id-1');
          fail('advisor-2', 'Still busy');
          gate.complete();
          async.flushMicrotasks();
          expect(advisor.messagesFor('c1').single.text, 'Keep me');
          expect(
            advisor.messagesFor('c1').single.delivery,
            ChatDelivery.notSent,
          );
        });
      },
    );

    test('a timed-out attempt can be explicitly rejected then retried', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.send(text: 'Keep me').ignore();
        async.flushMicrotasks();
        async.elapse(kRemoteAppAdvisorFirstSendTimeout);
        expect(advisor.isStartingChat, isTrue);
        fail('advisor-1', 'Rejected');
        expect(advisor.isStartingChat, isFalse);
        expect(advisor.messagesFor('').single.delivery, ChatDelivery.notSent);
        advisor.resend(null, 'id-1');
        async.flushMicrotasks();
        complete('advisor-2', {'chatId': 'new-1'});
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands, hasLength(2));
        expect(advisor.messagesFor('new-1').single.text, 'Keep me');
        expect(advisor.messagesFor(''), isEmpty);
      });
    });

    test('dismissing an uncertain send releases the new-chat composer', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.send(text: 'Keep me').ignore();
        async.flushMicrotasks();
        async.elapse(kRemoteAppAdvisorFirstSendTimeout);
        advisor.discardFailedMessage('', 'id-1');
        expect(advisor.messagesFor(''), isEmpty);
        expect(advisor.isStartingChat, isFalse);
        advisor.send(text: 'New request').ignore();
        async.flushMicrotasks();
        complete('advisor-1', {'chatId': 'old-1'});
        expect(advisor.isStartingChat, isTrue);
        complete('advisor-2', {'chatId': 'new-1'});
        async.flushMicrotasks();
        expect(advisor.messagesFor('new-1').single.text, 'New request');
      });
    });

    test(
      'a retried send reuses its message id and never duplicates a failed row',
      () async {
        final advisor = build();
        await advisor.send(chatId: 'c1', text: 'Keep me');
        fail('advisor-1', 'Busy');
        repository.appAdvisorError = const RemoteControlException('Still busy');
        await advisor.resend('c1', 'id-1');
        expect(repository.appAdvisorCommands.last['userMessageId'], 'id-1');
        expect(advisor.messagesFor('c1'), hasLength(1));
        expect(advisor.messagesFor('c1').single.delivery, ChatDelivery.notSent);
        await advisor.resend('c1', 'id-1');
        expect(advisor.messagesFor('c1'), hasLength(1));
        expect(advisor.messagesFor('c1').single.delivery, isNull);
      },
    );

    test('a pinned Agent settles so a later desktop model wins', () async {
      RemoteAppAdvisorChat model(String id) =>
          RemoteAppAdvisorChat.fromJson({'chatId': 'c1', 'model': id});
      final advisor = build()
        ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [model('sonnet')]));
      await advisor.setModel('c1', 'agent');
      advisor.applyDelta(
        RemoteAppAdvisorDeltaEvent(chats: [model('agent@sonnet')]),
      );
      advisor.applyDelta(RemoteAppAdvisorDeltaEvent(chats: [model('opus')]));
      expect(advisor.modelFor('c1'), 'opus');
      await advisor.setModel('c1', 'agent');
      expect(repository.appAdvisorCommands, hasLength(2));
    });

    test('a pinned first-send model also settles when already projected', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.send(text: 'Start', model: 'agent').ignore();
        async.flushMicrotasks();
        advisor.applyDelta(
          RemoteAppAdvisorDeltaEvent(
            chats: [
              RemoteAppAdvisorChat.fromJson({
                'chatId': 'new-1',
                'model': 'agent@sonnet',
              }),
            ],
          ),
        );
        complete('advisor-1', {'chatId': 'new-1'});
        async.flushMicrotasks();
        advisor.applyDelta(
          RemoteAppAdvisorDeltaEvent(
            chats: [
              RemoteAppAdvisorChat.fromJson({
                'chatId': 'new-1',
                'model': 'opus',
              }),
            ],
          ),
        );
        expect(advisor.modelFor('new-1'), 'opus');
      });
    });

    for (final source in ['completion', 'echo', 'snapshot']) {
      test(
        'a timed-out first send reconciles late $source without resending',
        () {
          fakeAsync((async) {
            final advisor = build();
            advisor.send(text: 'Only once').ignore();
            async.flushMicrotasks();
            async.elapse(kRemoteAppAdvisorFirstSendTimeout);
            expect(
              advisor.messagesFor('').single.delivery,
              ChatDelivery.uncertain,
            );
            advisor.resend(null, 'id-1');
            async.flushMicrotasks();
            expect(repository.appAdvisorCommands, hasLength(1));
            if (source == 'snapshot') {
              advisor.applySnapshot(
                RemoteAppAdvisorSnapshotEvent(
                  chats: [_chat('late-chat')],
                  chatMessages: [
                    _message(
                      'late-chat',
                      'id-1',
                      role: ChatRole.user,
                      text: 'Only once',
                    ),
                  ],
                ),
              );
            } else if (source == 'echo') {
              advisor.applyMessage(
                RemoteAppAdvisorMessageEvent(
                  chatId: 'late-chat',
                  message: _message(
                    'late-chat',
                    'id-1',
                    role: ChatRole.user,
                    text: 'Only once',
                  ),
                ),
              );
            } else {
              complete('advisor-1', {'chatId': 'late-chat'});
            }
            async.flushMicrotasks();
            expect(advisor.messagesFor(''), isEmpty);
            expect(advisor.messagesFor('late-chat').single.text, 'Only once');
            expect(advisor.messagesFor('late-chat').single.delivery, isNull);
            expect(advisor.isStartingChat, isFalse);
            advisor.resend(null, 'id-1');
            async.flushMicrotasks();
            expect(repository.appAdvisorCommands, hasLength(1));
          });
        },
      );
    }

    for (final outcome in ['submit failure', 'queued failure']) {
      test('old pairing $outcome cannot change the new session', () async {
        final gate = Completer<void>();
        repository.appAdvisorSubmitGate = gate;
        final advisor = build();
        final pending = advisor.cancel('c1');
        advisor.reset();
        if (outcome == 'submit failure') {
          gate.completeError(const RemoteControlException('Old pairing'));
        } else {
          gate.complete();
        }
        await pending;
        fail('advisor-1', 'Old pairing');
        expect(advisor.actionError, isNull);
        expect(notifications, 1);
      });
    }

    test('a removal-only delta forgets the chat and transcript', () async {
      final advisor = build()
        ..applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [_chat('c1')],
            chatMessages: [_message('c1', 'm1', text: 'History')],
          ),
        );
      final event = RemotePortalEventBatch.fromJson({
        'events': [
          {
            'type': 'portal.state.delta',
            'payload': {
              'scope': 'app_advisor',
              'removed': [
                {'entityType': 'app_advisor_chat', 'localId': 'c1'},
              ],
            },
          },
        ],
      }).events.single;
      expect(advisor.applyDelta(event as RemoteAppAdvisorDeltaEvent), isTrue);
      expect(advisor.entries, isEmpty);
      expect(advisor.messagesFor('c1'), isEmpty);
      advisor.applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]));
      expect(advisor.needsChatLoad('c1'), isTrue);
      advisor.dispose();
    });

    for (final resetPairing in [false, true]) {
      test(
        'settings returned after recovery are discarded, reset=$resetPairing',
        () async {
          final gate = Completer<void>();
          repository.appAdvisorSettingsGate = gate;
          repository.appAdvisorSettings = {'model': 'old-desktop'};
          final advisor = build();
          final pending = advisor.loadSettings();
          if (resetPairing) {
            advisor.reset();
          } else {
            advisor.reloadAfterSkippedEvents();
          }
          repository.appAdvisorSettingsGate = null;
          repository.appAdvisorSettings = {'model': 'new-desktop'};
          await advisor.loadSettings();
          gate.complete();
          await pending;
          expect(advisor.defaultModel, 'new-desktop');
        },
      );

      test(
        'late settings completion after recovery is discarded, reset=$resetPairing',
        () async {
          repository.appAdvisorSettings = null;
          final advisor = build();
          await advisor.loadSettings();
          if (resetPairing) {
            advisor.reset();
          } else {
            advisor.reloadAfterSkippedEvents();
          }
          repository.appAdvisorSettings = {'model': 'new-desktop'};
          await advisor.loadSettings();
          complete('settings-1', {'model': 'old-desktop'});
          expect(advisor.defaultModel, 'new-desktop');
        },
      );
    }
  });

  group('send', () {
    test(
      'first-send recovery survives snapshots, repeated rejection and reset',
      () {
        fakeAsync((async) {
          final advisor = build();
          advisor.send(text: 'Keep me').ignore();
          async.flushMicrotasks();
          fail('advisor-1', 'Busy');
          async.flushMicrotasks();
          advisor.applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: []));
          expect(advisor.messagesFor('').single.text, 'Keep me');

          advisor.resend(null, 'id-1', model: 'opus');
          async.flushMicrotasks();
          expect(repository.appAdvisorCommands.last['text'], 'Keep me');
          expect(repository.appAdvisorCommands.last['model'], 'opus');
          expect(
            repository.appAdvisorCommands.last.containsKey('chatId'),
            isFalse,
          );
          fail('advisor-2', 'Still busy');
          async.flushMicrotasks();
          expect(advisor.messagesFor(''), hasLength(1));
          expect(advisor.messagesFor('').single.delivery, ChatDelivery.notSent);
          advisor.reset();
          expect(advisor.messagesFor(''), isEmpty);
        });
      },
    );

    test(
      'a later successful first send keeps earlier rejected text reachable',
      () {
        fakeAsync((async) {
          final advisor = build();
          advisor.send(text: 'Earlier submission').ignore();
          async.flushMicrotasks();
          fail('advisor-1', 'Busy');
          async.flushMicrotasks();
          advisor.send(text: 'Newer submission').ignore();
          async.flushMicrotasks();
          complete('advisor-2', {'chatId': 'new-1'});
          async.flushMicrotasks();
          expect(advisor.messagesFor(''), isEmpty);
          expect(advisor.messagesFor('new-1').map((row) => row.text), [
            'Earlier submission',
            'Newer submission',
          ]);
          expect(
            advisor.messagesFor('new-1').first.delivery,
            ChatDelivery.notSent,
          );
          expect(advisor.messagesFor('new-1').first.chatId, 'new-1');
        });
      },
    );

    test(
      'a rejected first send stays recoverable until explicitly discarded',
      () {
        fakeAsync((async) {
          final advisor = build();
          advisor.send(text: 'Keep me').ignore();
          async.flushMicrotasks();
          fail('advisor-1', 'Busy');
          async.flushMicrotasks();
          expect(advisor.messagesFor('').single.text, 'Keep me');
          expect(advisor.messagesFor('').single.delivery, ChatDelivery.notSent);
          advisor.discardFailedMessage('', 'id-1');
          expect(advisor.messagesFor(''), isEmpty);
        });
      },
    );

    test('an existing chat shows the message at once and keeps it when '
        'echoed', () async {
      final advisor = build();
      expect(await advisor.send(chatId: 'c1', text: 'Hi'), 'c1');
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.app_advisor.send',
        'chatId': 'c1',
        'userMessageId': 'id-1',
        'text': 'Hi',
      });
      expect(advisor.messagesFor('c1').single.text, 'Hi');

      advisor.applyMessage(
        RemoteAppAdvisorMessageEvent(
          chatId: 'c1',
          message: _message('c1', 'id-1', role: ChatRole.user, text: 'Hi'),
        ),
      );
      expect(advisor.messagesFor('c1'), hasLength(1));
    });

    test(
      'a late desktop rejection preserves the message for recovery',
      () async {
        final advisor = build();
        await advisor.send(chatId: 'c1', text: 'Hi');
        fail('advisor-1', 'Connect Cursor/Copilot in the desktop app.');
        expect(advisor.messagesFor('c1').single.text, 'Hi');
        expect(advisor.messagesFor('c1').single.delivery, ChatDelivery.notSent);
        expect(
          advisor.actionError,
          'Connect Cursor/Copilot in the desktop app.',
        );
      },
    );

    test(
      'resend keeps a failed row on rejection and discard removes it',
      () async {
        final advisor = build();
        await advisor.send(chatId: 'c1', text: 'Keep me');
        fail('advisor-1', 'Busy');
        repository.appAdvisorError = const RemoteControlException('Still busy');
        await advisor.resend('c1', 'id-1');
        expect(advisor.messagesFor('c1').single.text, 'Keep me');
        expect(advisor.messagesFor('c1').single.delivery, ChatDelivery.notSent);
        advisor.discardFailedMessage('c1', 'id-1');
        expect(advisor.messagesFor('c1'), isEmpty);
      },
    );

    test('a rejected submit preserves the original transcript row', () async {
      final advisor = build();
      repository.appAdvisorError = const RemoteControlException('Busy.');
      await expectLater(
        advisor.send(chatId: 'c1', text: 'Hi'),
        throwsA(isA<RemoteControlException>()),
      );
      expect(advisor.messagesFor('c1').single.text, 'Hi');
      expect(advisor.messagesFor('c1').single.delivery, ChatDelivery.notSent);
      expect(advisor.actionError, 'Busy.');
    });

    test('a new chat omits the chat id and binds to the returned one', () {
      fakeAsync((async) {
        final advisor = build();
        String? bound;
        advisor
            .send(workEntryId: 'e1', text: 'Start')
            .then((chatId) => bound = chatId);
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands.single, {
          'type': 'portal.app_advisor.send',
          'userMessageId': 'id-1',
          'text': 'Start',
          'workEntryId': 'e1',
        });
        expect(advisor.isStartingChat, isTrue);
        expect(advisor.startingMessage?.text, 'Start');

        complete('advisor-1', {'ok': true, 'chatId': 'new-1'});
        async.flushMicrotasks();
        expect(bound, 'new-1');
        expect(advisor.isStartingChat, isFalse);
        expect(advisor.messagesFor('new-1').single.text, 'Start');
      });
    });

    test('a new chat also binds from its echoed message', () {
      fakeAsync((async) {
        final advisor = build();
        String? bound;
        advisor.send(text: 'Start').then((chatId) => bound = chatId);
        async.flushMicrotasks();
        advisor.applyMessage(
          RemoteAppAdvisorMessageEvent(
            chatId: 'new-2',
            message: _message(
              'new-2',
              'id-1',
              role: ChatRole.user,
              text: 'Start',
            ),
          ),
        );
        async.flushMicrotasks();
        expect(bound, 'new-2');
        expect(advisor.messagesFor('new-2'), hasLength(1));
      });
    });

    test('a new chat deadline retains an uncertain attempt', () {
      fakeAsync((async) {
        final advisor = RemoteAppAdvisorController(
          advisorCommands: repository.appAdvisor,
          commands: commands,
          isConnected: () => connected,
          notify: () {},
        );
        Object? error;
        advisor.send(text: 'Start').catchError((Object e) {
          error = e;
          return '';
        });
        async.elapse(kRemoteAppAdvisorFirstSendTimeout);
        expect(error, isA<RemoteControlException>());
        expect(advisor.isStartingChat, isTrue);
        expect(advisor.actionError, isNull);
        expect(
          advisor.messagesFor('').single.deliveryNote,
          kRemoteAppAdvisorFirstSendUnconfirmed,
        );
      });
    });
  });

  group('tabs and stop', () {
    test('cancel sends the chat id', () async {
      await build().cancel('c1');
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.app_advisor.cancel',
        'chatId': 'c1',
      });
    });

    test('a new tab shows at once and goes when the desktop rejects it', () {
      fakeAsync((async) {
        final advisor = build()
          ..applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [_chat('c1', workEntryId: 'e1')],
            ),
          );
        final entry = advisor.entries.single;
        final chatId = advisor.createTab(entry);
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands.single, {
          'type': 'portal.app_advisor.create_tab',
          'chatId': chatId,
          'workEntryId': 'e1',
        });
        expect(advisor.entryFor(chatId)?.key, 'e1');
        expect(
          [for (final tab in advisor.tabsFor(entry)) tab.chatId],
          ['c1', chatId],
        );

        fail('advisor-1', 'Could not create the tab.');
        expect(advisor.tabsFor(advisor.entries.single), hasLength(1));
        expect(advisor.actionError, 'Could not create the tab.');
        expect(advisor.entryFor(chatId), isNull);
      });
    });

    test('a projected tab replaces its placeholder', () {
      fakeAsync((async) {
        final advisor = build()
          ..applyDelta(
            RemoteAppAdvisorDeltaEvent(chats: [_chat('c1', workEntryId: 'e1')]),
          );
        final chatId = advisor.createTab(advisor.entries.single);
        async.flushMicrotasks();
        advisor.applyDelta(
          RemoteAppAdvisorDeltaEvent(
            chats: [_chat(chatId, workEntryId: 'e1', order: 1)],
          ),
        );
        expect(advisor.tabsFor(advisor.entries.single), hasLength(2));
      });
    });
  });

  group('model', () {
    RemoteAppAdvisorChat withModel(String model) =>
        RemoteAppAdvisorChat.fromJson({
          'chatId': 'c1',
          'title': 'Chat c1',
          'model': model,
        });

    test('shows the chosen model until the desktop projects it', () async {
      final advisor = build()
        ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [withModel('sonnet')]));
      expect(advisor.modelFor('c1'), 'sonnet');

      await advisor.setModel('c1', 'opus');
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.app_advisor.set_model',
        'chatId': 'c1',
        'model': 'opus',
      });
      expect(advisor.modelFor('c1'), 'opus');

      // An unrelated re-projection keeps the pending choice on screen.
      advisor.applyDelta(
        RemoteAppAdvisorDeltaEvent(chats: [withModel('sonnet')]),
      );
      expect(advisor.modelFor('c1'), 'opus');

      advisor.applyDelta(
        RemoteAppAdvisorDeltaEvent(chats: [withModel('opus')]),
      );
      expect(advisor.modelFor('c1'), 'opus');
      // Settled: a later desktop change wins.
      advisor.applyDelta(
        RemoteAppAdvisorDeltaEvent(chats: [withModel('haiku')]),
      );
      expect(advisor.modelFor('c1'), 'haiku');
    });

    test(
      'fresh recovery drops a rejected submitted choice but keeps unsent choices',
      () async {
        final advisor = build()
          ..applyDelta(
            RemoteAppAdvisorDeltaEvent(chats: [withModel('sonnet')]),
          );
        await advisor.setModel('c1', 'opus');
        final unsent = advisor.createTab(advisor.entries.single);
        await advisor.setModel(unsent, 'haiku');
        advisor.reloadAfterSkippedEvents();
        fail('advisor-1', 'This model is blocked by your organization.');
        advisor.applySnapshot(
          RemoteAppAdvisorSnapshotEvent(chats: [withModel('sonnet')]),
        );
        expect(advisor.modelFor('c1'), 'sonnet');
        expect(advisor.modelFor(unsent), 'haiku');
        advisor.dispose();
      },
    );

    test('a rejected choice reverts and shows why', () async {
      final advisor = build()
        ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [withModel('sonnet')]));
      await advisor.setModel('c1', 'opus');
      fail('advisor-1', 'This model is blocked by your organization.');
      expect(advisor.modelFor('c1'), 'sonnet');
      expect(
        advisor.actionError,
        'This model is blocked by your organization.',
      );
    });
  });

  group('default and unsent model choices', () {
    test('a tab with no model shows the Advisor default', () async {
      repository.appAdvisorSettings = {'model': 'sonnet'};
      final advisor = build();
      await advisor.hydrate();
      expect(repository.appAdvisorSettingsReads, 1);
      advisor.applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]));
      expect(advisor.defaultModel, 'sonnet');
      expect(advisor.modelFor('c1'), 'sonnet');
      expect(advisor.modelFor(null), 'sonnet');
    });

    test('a default the desktop answers late still lands', () async {
      repository.appAdvisorSettings = null;
      final advisor = build();
      await advisor.hydrate();
      expect(advisor.defaultModel, isNull);
      complete('settings-1', {'model': 'opus'});
      expect(advisor.defaultModel, 'opus');
    });

    test('a model chosen for a tab still being created goes with its first '
        'send', () {
      fakeAsync((async) {
        final advisor = build()
          ..applyDelta(
            RemoteAppAdvisorDeltaEvent(chats: [_chat('c1', workEntryId: 'e1')]),
          );
        final chatId = advisor.createTab(advisor.entries.single);
        async.flushMicrotasks();
        advisor.setModel(chatId, 'opus');
        async.flushMicrotasks();
        expect(
          repository.appAdvisorCommands.map((c) => c['type']),
          isNot(contains('portal.app_advisor.set_model')),
        );
        expect(advisor.modelFor(chatId), 'opus');

        advisor.send(chatId: chatId, text: 'Hi');
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands.last['model'], 'opus');

        advisor.send(chatId: chatId, text: 'Again');
        async.flushMicrotasks();
        expect(
          repository.appAdvisorCommands.last.containsKey('model'),
          isFalse,
        );
      });
    });

    test('a new chat sends its model and keeps showing it', () {
      fakeAsync((async) {
        final advisor = build();
        advisor.send(text: 'Start', model: 'opus');
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands.single['model'], 'opus');
        complete('advisor-1', {'ok': true, 'chatId': 'new-1'});
        async.flushMicrotasks();
        expect(advisor.modelFor('new-1'), 'opus');
      });
    });
  });

  group('background and per-chat loading', () {
    test('prefetch loads the list once', () async {
      final advisor = build();
      advisor.prefetch();
      advisor.prefetch();
      await Future<void>.delayed(Duration.zero);
      expect(
        repository.appAdvisorCommands.single['type'],
        'portal.state.request',
      );
      advisor.applySnapshot(
        RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1')]),
      );
      advisor.prefetch();
      await Future<void>.delayed(Duration.zero);
      expect(repository.appAdvisorCommands, hasLength(1));
    });

    test('prefetch does nothing for an older desktop', () async {
      repository.supportsAppAdvisor = false;
      build().prefetch();
      await Future<void>.delayed(Duration.zero);
      expect(repository.appAdvisorCommands, isEmpty);
    });

    test(
      'opening a chat the list seeded partly loads just that chat',
      () async {
        final advisor = build()
          ..applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [_chat('c1')],
              chatMessagesTruncated: true,
            ),
          );
        expect(advisor.needsChatLoad('c1'), isTrue);
        await advisor.loadChat('c1');
        await advisor.loadChat('c1');
        expect(repository.appAdvisorCommands.single, {
          'type': 'portal.state.request',
          'scope': 'app_advisor',
          'target': {'chatLocalId': 'c1'},
        });
        expect(advisor.isLoadingChat('c1'), isTrue);

        advisor.applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [_chat('c1')],
            targetChatId: 'c1',
            chatMessages: [_message('c1', 'm1', text: 'Full history')],
            chatMessagesTruncated: true,
          ),
        );
        expect(advisor.isLoadingChat('c1'), isFalse);
        expect(advisor.needsChatLoad('c1'), isFalse);
        expect(advisor.messagesFor('c1').single.text, 'Full history');
      },
    );

    test('a complete list seed needs no per-chat load', () {
      final advisor = build()
        ..applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1')]));
      expect(advisor.needsChatLoad('c1'), isFalse);
    });

    test('a tab the desktop has not created is not requested', () async {
      final advisor = build();
      expect(advisor.needsChatLoad('pending'), isFalse);
      await advisor.loadChat('pending');
      expect(repository.appAdvisorCommands, isEmpty);
    });

    test('a chat load timeout requires explicit retry', () {
      fakeAsync((async) {
        final advisor = build()
          ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]));
        advisor.loadChat('c1');
        async.flushMicrotasks();
        async.elapse(kRemoteAppAdvisorHydrationTimeout);
        expect(advisor.needsChatLoad('c1'), isFalse);
        expect(advisor.chatLoadError('c1'), isNotNull);
        advisor.retryChatLoad('c1');
        async.flushMicrotasks();
        expect(repository.appAdvisorCommands, hasLength(2));
        // A delayed rejection from the first attempt cannot settle the retry.
        fail('advisor-1', 'Old failure');
        expect(advisor.isLoadingChat('c1'), isTrue);
        advisor.applyDelta(
          RemoteAppAdvisorDeltaEvent(chats: const [], removedChatIds: ['c1']),
        );
        expect(advisor.isLoadingChat('c1'), isFalse);
        expect(advisor.chatLoadError('c1'), isNull);
        async.elapse(kRemoteAppAdvisorHydrationTimeout);
        expect(advisor.chatLoadError('c1'), isNull);
        advisor.dispose();
      });
    });

    test(
      'submit failure blocks automatic loads until explicit retry',
      () async {
        final advisor = build()
          ..applyDelta(RemoteAppAdvisorDeltaEvent(chats: [_chat('c1')]));
        repository.appAdvisorError = const RemoteControlException('Offline');
        await advisor.loadChat('c1');
        expect(advisor.chatLoadError('c1'), 'Offline');
        expect(advisor.needsChatLoad('c1'), isFalse);
        await advisor.retryChatLoad('c1');
        expect(advisor.isLoadingChat('c1'), isTrue);
        advisor.dispose();
      },
    );

    test(
      'a failed chat load stops loading without automatic retries',
      () async {
        final advisor = build()
          ..applySnapshot(
            RemoteAppAdvisorSnapshotEvent(
              chats: [_chat('c1')],
              chatMessagesTruncated: true,
            ),
          );
        await advisor.loadChat('c1');
        fail('advisor-1', 'Orchestrator chat is not resolvable: c1');
        expect(advisor.isLoadingChat('c1'), isFalse);
        expect(advisor.needsChatLoad('c1'), isFalse);
        await advisor.loadChat('c1');
        expect(repository.appAdvisorCommands, hasLength(1));
      },
    );
  });

  group('questions', () {
    RemoteAppAdvisorController withQuestion() => build()
      ..applyDelta(
        RemoteAppAdvisorDeltaEvent(
          chats: [
            _chat('c1', pendingQuestions: [_question('q1')]),
          ],
        ),
      );

    test('answer hides the card and sends the answer', () async {
      final advisor = withQuestion();
      await advisor.answerQuestion(
        'c1',
        requestId: 'q1',
        answers: const [
          AskUserQuestionAnswer(question: 'Ship it?', selectedOptions: ['Yes']),
        ],
      );
      expect(advisor.pendingQuestionsFor('c1'), isEmpty);
      expect(repository.appAdvisorCommands.single, {
        'type': 'portal.app_advisor.answer_question',
        'chatId': 'c1',
        'requestId': 'q1',
        'answers': [
          {
            'question': 'Ship it?',
            'selectedOptions': ['Yes'],
          },
        ],
      });
    });

    test('a rejected answer brings the card back', () async {
      final advisor = withQuestion();
      await advisor.answerQuestion('c1', requestId: 'q1', answers: const []);
      fail(
        'advisor-1',
        'Orchestrator question is no longer awaiting an answer.',
      );
      expect(advisor.pendingQuestionsFor('c1').single.requestId, 'q1');
      expect(
        advisor.actionError,
        'Orchestrator question is no longer awaiting an answer.',
      );
    });

    test('a dismiss rejected before it is sent brings the card back', () async {
      final advisor = withQuestion();
      repository.appAdvisorError = const RemoteControlException('Offline.');
      await advisor.dismissQuestion('c1', requestId: 'q1');
      expect(advisor.pendingQuestionsFor('c1'), hasLength(1));
      expect(advisor.actionError, 'Offline.');
    });
  });

  group('availability', () {
    test('an older desktop gets no Advisor command', () async {
      repository.supportsAppAdvisor = false;
      final advisor = build();
      expect(advisor.isSupported, isFalse);
      await advisor.hydrate();
      await advisor.cancel('c1');
      await expectLater(
        advisor.send(chatId: 'c1', text: 'Hi'),
        throwsA(isA<RemoteControlException>()),
      );
      expect(repository.appAdvisorCommands, isEmpty);
    });

    test('disconnected, commands are refused and cached chats stay', () async {
      final advisor = build()
        ..applySnapshot(
          RemoteAppAdvisorSnapshotEvent(
            chats: [_chat('c1')],
            chatMessages: [_message('c1', 'm1', text: 'Kept')],
          ),
        );
      connected = false;
      expect(advisor.canAct, isFalse);
      await advisor.cancel('c1');
      await advisor.hydrate();
      expect(repository.appAdvisorCommands, isEmpty);
      expect(advisor.entries, hasLength(1));
      expect(advisor.messagesFor('c1').single.text, 'Kept');
    });

    test('reset forgets the session', () {
      final advisor = build()
        ..applySnapshot(RemoteAppAdvisorSnapshotEvent(chats: [_chat('c1')]))
        ..reset();
      expect(advisor.entries, isEmpty);
      expect(advisor.isHydrated, isFalse);
    });
  });
}
