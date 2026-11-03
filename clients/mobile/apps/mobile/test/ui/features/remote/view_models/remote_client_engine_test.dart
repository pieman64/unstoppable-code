// Deterministic sequences across the assembled engine: each one crosses
// collaborators (send, registry, session, hydration, create, transcript) and
// pins the ordering and ownership rules the facade relied on before its
// state moved into them.
import 'dart:async';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/data/models/remote_watcher.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/chat/view_models/chat_attachment_draft.dart';
import 'package:mobile/ui/features/remote/view_models/chat_send_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_activity_load_tracker.dart';
import 'package:mobile/ui/features/remote/view_models/remote_session_controller.dart'
    show RemoteLinkState;

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_engine_harness.dart';

const _chat = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: 'wt-1',
  chatId: 'chat-1',
);

RemoteChatMessage _row(
  String messageId, {
  ChatRole role = ChatRole.assistant,
  ChatMessageStatus status = ChatMessageStatus.complete,
  String text = 'hello',
}) => RemoteChatMessage(
  messageId: messageId,
  chatId: 'chat-1',
  scope: RemoteChatScope.worktree,
  role: role,
  status: status,
  text: text,
);

RemotePortalEventBatch _batch(List<RemotePortalEvent> events) =>
    RemotePortalEventBatch(events: events, nextCursor: 1);

RemoteStateSnapshotEvent _chatSnapshot(List<RemoteChatMessage> rows) =>
    RemoteStateSnapshotEvent(
      scope: 'chat',
      targetChatId: 'chat-1',
      targetChatScope: RemoteChatScope.worktree,
      chatMessages: rows,
    );

Future<void> _pump() => Future<void>.delayed(Duration.zero);

List<String> _ids(RemoteClientEngine engine) => [
  for (final message in engine.transcripts.messagesFor(_chat))
    message.messageId,
];

/// Holds every request a session switch can race until the test releases
/// it.
final class _GatedRepository extends FakeRemoteControlRepository {
  _GatedRepository() {
    sendChatMessageHandler = () => send.future;
    requestOverviewStateHandler = () => overview.future;
  }

  final send = Completer<RemoteChatSendResult>();
  final transcript = Completer<String?>();
  final overview = Completer<void>();

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) {
    requestChatTranscriptCalls += 1;
    return transcript.future;
  }
}

/// Holds a chat-tab creation until the test releases it.
final class _DeferredTabRepository extends FakeRemoteControlRepository {
  final createTab = Completer<String>();

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) =>
      createTab.future;
}

final class _SequencedHydrationRepository extends FakeRemoteControlRepository {
  _SequencedHydrationRepository() {
    supportsForegroundChat = true;
  }

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    return requestChatTranscriptCalls == 1 ? 'foreground' : 'transcript';
  }
}

final class _GatedCachedTailRepository extends FakeRemoteControlRepository {
  final cache = Completer<List<RemoteChatMessage>>();

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) {
    cachedChatFetches++;
    return cache.future;
  }
}

void main() {
  test(
    'connect defers Advisor until foreground chat hydration completes',
    () async {
      final repository = FakeRemoteControlRepository()
        ..supportsAppAdvisor = true
        ..snapshotBuilder = (() => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
          refreshing: true,
        ));
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      await _pump();
      expect(repository.appAdvisorCommands, isEmpty);
      expect(repository.appAdvisorSettingsReads, 0);
      engine.hydration.ensureChatTranscript(_chat);
      await _pump();
      expect(repository.appAdvisorCommands, isEmpty);
      repository.eventsController.add(
        _batch([
          _chatSnapshot([_row('latest')]),
        ]),
      );
      await _pump();
      expect(repository.appAdvisorCommands, isNotEmpty);
      expect(repository.appAdvisorSettingsReads, 1);
      engine.dispose();
    },
  );

  test(
    'a fresh HTTP overview releases summary warming without a push',
    () async {
      final repository = FakeRemoteControlRepository()
        ..supportsWorktreeChatSummariesScope = true;
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      engine.hydration.ensureChatSummariesIndex(background: true);
      await Future<void>.delayed(const Duration(milliseconds: 350));
      expect(repository.requestWorktreeChatSummariesStateCalls, 1);
      engine.dispose();
    },
  );

  test('a current cursor cannot prove an unseeded partial tail', () async {
    final repository = FakeRemoteControlRepository()
      ..snapshotBuilder = (() => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [],
        standaloneChats: [],
        eventCursor: 10,
      ))
      ..cachedChatCursor = 10
      ..cachedChatStale = false
      ..cachedChatMessages = [_row('live-only')];
    final engine = buildRemoteEngine(repository: repository);
    await engine.session.connect('123456');
    engine.hydration.ensureChatTranscript(_chat);
    await _pump();
    expect(repository.requestChatTranscriptCalls, 1);
    engine.dispose();
  });

  group('cached tail freshness', () {
    RemoteSessionSnapshot shell({int? cursor = 10}) => RemoteSessionSnapshot(
      workspaces: const [],
      worktrees: const [],
      standaloneChats: const [],
      eventCursor: cursor,
    );

    for (final (name, overviewCursor, tailCursor, stale, rows, expected) in [
      ('current', 10, 10, false, [_row('cached')], 0),
      ('ahead', 10, 12, false, [_row('cached')], 0),
      ('behind', 10, 9, false, [_row('cached')], 1),
      ('stale', 10, 10, true, [_row('cached')], 1),
      ('missing', 10, 10, false, <RemoteChatMessage>[], 1),
      ('legacy overview', null, 10, false, [_row('cached')], 1),
      ('legacy tail', 10, null, false, [_row('cached')], 1),
      ('unusable cursor', 0, 0, false, [_row('cached')], 1),
      (
        'wrong chat',
        10,
        10,
        false,
        [
          RemoteChatMessage(
            messageId: 'foreign',
            chatId: 'another',
            scope: RemoteChatScope.worktree,
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'foreign',
          ),
        ],
        1,
      ),
    ]) {
      test('$name tail requests $expected desktop snapshots', () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = (() => shell(cursor: overviewCursor))
          ..cachedChatHasSeed = true
          ..cachedChatCursor = tailCursor
          ..cachedChatStale = stale
          ..cachedChatMessages = rows;
        final engine = buildRemoteEngine(repository: repository);
        await engine.session.connect('123456');
        engine.hydration.ensureChatTranscript(_chat);
        await _pump();
        expect(repository.requestChatTranscriptCalls, expected);
        expect(
          engine.hydration.tabListBaselineFor(
            remoteWorktreeKey('ws-1', 'wt-1'),
          ),
          expected == 0 ? isNull : isNotNull,
        );
        engine.dispose();
      });
    }

    for (final snapshot in [false, true]) {
      test(
        'older ${snapshot ? "snapshot" : "live replay"} cannot regress a verified tail',
        () async {
          final repository = FakeRemoteControlRepository()
            ..snapshotBuilder = (() => shell())
            ..cachedChatHasSeed = true
            ..cachedChatCursor = 12
            ..cachedChatStale = false
            ..cachedChatMessages = [
              _row('cached', text: 'Latest cached answer'),
            ];
          final engine = buildRemoteEngine(repository: repository);
          await engine.session.connect('123456');
          engine.hydration.ensureChatTranscript(_chat);
          await _pump();
          repository.eventsController.add(
            RemotePortalEventBatch.fromJson({
              'nextCursor': 14,
              'events': [
                {
                  'type': snapshot
                      ? 'portal.state.snapshot'
                      : 'portal.chat.event',
                  'cursor': 11,
                  'payload': snapshot
                      ? {
                          'scope': 'chat',
                          'target': {
                            'workspaceLocalId': 'ws-1',
                            'worktreeLocalId': 'wt-1',
                            'chatLocalId': 'chat-1',
                          },
                          'chatMessages': [
                            {
                              'messageId': 'cached',
                              'chatId': 'chat-1',
                              'scope': 'worktree',
                              'role': 'assistant',
                              'status': 'complete',
                              'text': 'Older replay',
                            },
                          ],
                        }
                      : {
                          'chatId': 'chat-1',
                          'scope': 'worktree',
                          'message': {
                            'messageId': 'cached',
                            'chatId': 'chat-1',
                            'scope': 'worktree',
                            'role': 'assistant',
                            'status': 'complete',
                            'text': 'Older replay',
                          },
                        },
                },
              ],
            }),
          );
          await _pump();
          expect(
            engine.transcripts.messagesFor(_chat).single.text,
            'Latest cached answer',
          );
          expect(repository.requestChatTranscriptCalls, 0);
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteChatMessageEvent(
                  chatId: 'chat-1',
                  cursor: 15,
                  message: _row('cached', text: 'New live answer'),
                ),
              ],
              nextCursor: 15,
            ),
          );
          await _pump();
          expect(
            engine.transcripts.messagesFor(_chat).single.text,
            'New live answer',
          );
          expect(repository.requestChatTranscriptCalls, 0);
          engine.dispose();
        },
      );
    }

    test(
      'legacy live delivery reconciles through the desktop snapshot',
      () async {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = (() => shell())
          ..cachedChatHasSeed = true
          ..cachedChatCursor = 10
          ..cachedChatStale = false
          ..cachedChatMessages = [_row('cached')];
        final engine = buildRemoteEngine(repository: repository);
        await engine.session.connect('123456');
        engine.hydration.ensureChatTranscript(_chat);
        await _pump();
        repository.eventsController.add(
          RemotePortalEventBatch(
            events: [
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                message: _row('cached', text: 'Legacy live'),
              ),
            ],
            nextCursor: 11,
          ),
        );
        await _pump();
        expect(repository.requestChatTranscriptCalls, 1);
        repository.eventsController.add(
          _batch([
            _chatSnapshot([_row('cached', text: 'Reconciled')]),
          ]),
        );
        await _pump();
        expect(engine.transcripts.messagesFor(_chat).single.text, 'Reconciled');
        engine.dispose();
      },
    );

    for (final sameChat in [false, true]) {
      test(
        'a raced event for ${sameChat ? "this" : "another"} chat rechecks the watermark',
        () async {
          final repository = _GatedCachedTailRepository()
            ..snapshotBuilder = (() => shell())
            ..cachedChatHasSeed = true
            ..cachedChatCursor = 10
            ..cachedChatStale = false;
          final engine = buildRemoteEngine(repository: repository);
          await engine.session.connect('123456');
          engine.hydration.ensureChatTranscript(_chat);
          await _pump();
          repository.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateDeltaEvent(
                  cursor: 11,
                  chatSummaries: [
                    RemoteChatSummary(
                      chatId: sameChat ? 'chat-1' : 'other',
                      scope: RemoteChatScope.worktree,
                      title: 'Updated',
                    ),
                  ],
                ),
              ],
              nextCursor: 11,
            ),
          );
          await _pump();
          repository.cache.complete([_row('cached')]);
          await _pump();
          expect(repository.requestChatTranscriptCalls, sameChat ? 1 : 0);
          engine.dispose();
        },
      );
    }

    test(
      'a cache result after re-pair cannot start or settle hydration',
      () async {
        final repository = _GatedCachedTailRepository()
          ..snapshotBuilder = (() => shell())
          ..cachedChatHasSeed = true
          ..cachedChatCursor = 10
          ..cachedChatStale = false;
        final engine = buildRemoteEngine(repository: repository);
        await engine.session.connect('123456');
        engine.hydration.ensureChatTranscript(_chat);
        await _pump();
        await engine.session.disconnect();
        await engine.session.connect('654321');
        repository.cache.complete([_row('old')]);
        await _pump();
        expect(repository.requestChatTranscriptCalls, 0);
        expect(_ids(engine), isEmpty);
        engine.dispose();
      },
    );
  });

  test('summary warming waits for a completed foreground projection', () async {
    final repository = FakeRemoteControlRepository()
      ..supportsWorktreeChatSummariesScope = true
      ..snapshotBuilder = (() => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [],
        standaloneChats: [],
        refreshing: true,
      ));
    final engine = buildRemoteEngine(repository: repository);
    await engine.session.connect('123456');
    engine.hydration.ensureChatSummariesIndex(background: true);
    await Future<void>.delayed(const Duration(milliseconds: 350));
    expect(repository.requestWorktreeChatSummariesStateCalls, 0);
    repository.eventsController.add(
      _batch([const RemoteStateSnapshotEvent(scope: 'overview')]),
    );
    await _pump();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    expect(repository.requestWorktreeChatSummariesStateCalls, 1);
    engine.dispose();
  });

  test('a targeted snapshot settles only its originating hydration', () async {
    final repository = _SequencedHydrationRepository();
    final engine = buildRemoteEngine(repository: repository);
    await engine.session.connect('123456');
    engine.hydration.ensureForegroundWorktreeChat(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
    );
    engine.hydration.ensureChatTranscript(_chat);
    await _pump();
    final worktree = remoteWorktreeKey('ws-1', 'wt-1');
    expect(repository.requestChatTranscriptCalls, 2);
    expect(engine.hydration.tabListBaselineFor(worktree), isNotNull);

    repository.eventsController.add(
      _batch([
        const RemoteStateSnapshotEvent(
          commandId: 'transcript',
          scope: 'chat',
          selectedChatOnly: true,
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
          targetChatId: 'chat-1',
          targetChatScope: RemoteChatScope.worktree,
        ),
      ]),
    );
    await _pump();
    expect(engine.hydration.tabListBaselineFor(worktree), isNotNull);

    repository.eventsController.add(
      _batch([
        const RemoteStateSnapshotEvent(
          commandId: 'foreground',
          scope: 'chat',
          selectedChatOnly: true,
          targetWorkspaceLocalId: 'ws-1',
          targetWorktreeLocalId: 'wt-1',
          targetChatId: 'chat-1',
          targetChatScope: RemoteChatScope.worktree,
        ),
      ]),
    );
    await _pump();
    expect(engine.hydration.tabListBaselineFor(worktree), isNull);
    engine.dispose();
  });

  group('unknown send delivery', () {
    Future<(FakeRemoteControlRepository, RemoteClientEngine)>
    connected() async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      repository.sendChatMessageHandler = () async {
        throw const RemoteChatSendOutcomeUnknownException(
          'Connection interrupted',
        );
      };
      return (repository, engine);
    }

    test(
      'waits out the background, then confirms only the exact message id',
      () async {
        final (repository, engine) = await connected();
        engine.session.onAppBackgrounded();

        final send = engine.sends.sendChatMessage(_chat, 'run the tests');
        await _pump();
        final id =
            repository.sendChatMessageCalls.single.options!.userMessageId!;
        expect(repository.cachedChatFetches, 0);
        expect(_ids(engine), [id]);
        expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);

        repository.cachedChatMessages = [
          _row('other', role: ChatRole.user, text: 'run the tests'),
          _row(id, role: ChatRole.user, text: 'run the tests'),
        ];
        await engine.session.onAppForegrounded();
        final result = await send;

        expect(result.chatId, 'chat-1');
        expect(repository.cachedChatFetches, 1);
        expect(repository.sendChatMessageCalls, hasLength(1));
        expect(_ids(engine), [id]);
        expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);
        engine.dispose();
      },
    );

    test(
      'a text match or running turn leaves the send unresolved, never resent',
      () async {
        final (repository, engine) = await connected();
        engine.session.onAppBackgrounded();

        final send = engine.sends.sendChatMessage(_chat, 'run the tests');
        final outcome = expectLater(
          send,
          throwsA(isA<RemoteChatSendNotSentException>()),
        );
        await _pump();
        repository.cachedChatMessages = [
          _row('other', role: ChatRole.user, text: 'run the tests'),
          _row('turn', status: ChatMessageStatus.streaming, text: 'Working'),
        ];
        await engine.session.onAppForegrounded();
        await outcome;

        expect(repository.sendChatMessageCalls, hasLength(1));
        expect(_ids(engine), isEmpty);
        final id =
            repository.sendChatMessageCalls.single.options!.userMessageId!;
        final row = engine.messagesFor(_chat).single;
        expect(row.messageId, id);
        expect(row.delivery, ChatDelivery.uncertain);
        expect(engine.sends.isAwaitingAgentTurn(_chat), isFalse);
        engine.dispose();
      },
    );
  });

  group('terminal before submit response', () {
    test(
      'a completion is claimed on registration; foreign terminals stay hidden',
      () async {
        final repository = FakeRemoteControlRepository();
        final engine = buildRemoteEngine(repository: repository);
        await engine.session.connect('123456');
        repository.sendChatMessageHandler = () async {
          repository.eventsController.add(
            _batch(const [
              RemoteCommandCompletedEvent(commandId: 'send-1'),
              RemoteCommandFailedEvent(
                commandId: 'other-client',
                message: 'Not ours',
              ),
            ]),
          );
          await _pump();
          return const RemoteChatSendResult(
            commandId: 'send-1',
            chatId: 'chat-1',
          );
        };

        final result = await engine.sends.sendChatMessage(_chat, 'hello');

        expect(result.commandId, 'send-1');
        expect(engine.commands.hasCompleted('send-1'), isTrue);
        expect(engine.commands.hasFailed('other-client'), isFalse);
        expect(engine.commands.failureMessage, isNull);
        expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);
        engine.dispose();
      },
    );

    test('a failure rejects the send and retracts its bubble', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      repository.sendChatMessageHandler = () async {
        repository.eventsController.add(
          _batch(const [
            RemoteCommandFailedEvent(
              commandId: 'send-2',
              message: 'The desktop rejected the send.',
            ),
          ]),
        );
        await _pump();
        return const RemoteChatSendResult(
          commandId: 'send-2',
          chatId: 'chat-1',
        );
      };

      await expectLater(
        engine.sends.sendChatMessage(_chat, 'hello'),
        throwsA(
          isA<RemoteControlException>().having(
            (error) => error.message,
            'message',
            'The desktop rejected the send.',
          ),
        ),
      );

      expect(_ids(engine), isEmpty);
      expect(engine.sends.isAwaitingAgentTurn(_chat), isFalse);
      expect(engine.commands.failureMessage, 'The desktop rejected the send.');
      engine.dispose();
    });
  });

  group('old session work', () {
    test('cannot change the session that replaced it', () async {
      final repository = _GatedRepository();
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        worktreeCreateRecoveryInterval: Duration.zero,
        worktreeCreateTimeout: Duration.zero,
      );
      await engine.session.connect('123456');
      final generation = engine.session.sessionGeneration;

      final send = engine.sends.sendChatMessage(_chat, 'old session');
      engine.hydration.ensureChatTranscript(_chat);
      final create = expectLater(
        engine.worktreeCreates.createWorktree(workspaceLocalId: 'ws-1'),
        throwsA(isA<RemoteControlException>()),
      );
      await _pump();
      expect(_ids(engine), hasLength(1));
      expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);
      expect(engine.hydration.isChatTranscriptLoading(_chat), isTrue);
      expect(engine.worktreeCreates.isCreatingWorktree, isTrue);

      await engine.session.disconnect();
      await engine.session.connect('654321');
      expect(engine.session.sessionGeneration, greaterThan(generation));

      repository.send.complete(
        const RemoteChatSendResult(commandId: 'old-send', chatId: 'chat-1'),
      );
      repository.transcript.complete('old-transcript');
      repository.overview.complete();
      await send;
      await create;
      await _pump();

      expect(_ids(engine), isEmpty);
      expect(engine.sends.isAwaitingAgentTurn(_chat), isFalse);
      expect(engine.hydration.isChatTranscriptLoading(_chat), isFalse);
      expect(engine.hydration.chatHydrationError(_chat), isNull);
      expect(engine.worktreeCreates.isCreatingWorktree, isFalse);
      expect(repository.createWorktreeCalls, hasLength(1));
      engine.dispose();
    });

    test('previous session acknowledgement cannot register a replacement '
        'session command', () async {
      final repository = _DeferredTabRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      const newTab = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'chat-new',
      );
      final create = engine.sends.createChatTab(newTab);
      await _pump();

      await engine.session.disconnect();
      await engine.session.connect('654321');
      repository.createTab.complete('old-create');
      await create;
      repository.eventsController.add(
        _batch(const [
          RemoteCommandFailedEvent(
            commandId: 'old-create',
            message: 'The old tab failed.',
          ),
        ]),
      );
      await _pump();

      expect(engine.commands.hasFailed('old-create'), isFalse);
      expect(engine.commands.failureMessage, isNull);
      engine.dispose();
    });

    test('reports no change once the engine is disposed', () {
      fakeAsync((async) {
        final repository = _GatedRepository();
        var changes = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          onChanged: () => changes += 1,
          stateRefreshDebounce: Duration.zero,
          worktreeCreateRecoveryInterval: Duration.zero,
          worktreeCreateTimeout: Duration.zero,
          clock: async.getClock(DateTime(2026, 9, 30, 12)).now,
        );
        engine.session.connect('123456');
        async.flushMicrotasks();

        Object? sendError;
        Object? createError;
        engine.sends
            .sendChatMessage(_chat, 'old session')
            .then(
              (_) {},
              onError: (Object error) {
                sendError = error;
              },
            );
        engine.hydration.ensureChatTranscript(_chat);
        engine.worktreeCreates
            .createWorktree(workspaceLocalId: 'ws-1')
            .then(
              (_) {},
              onError: (Object error) {
                createError = error;
              },
            );
        async.flushMicrotasks();
        expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);

        engine.dispose();
        final changesAtDispose = changes;
        repository.send.complete(
          const RemoteChatSendResult(commandId: 'old-send', chatId: 'chat-1'),
        );
        repository.transcript.complete('old-transcript');
        repository.overview.complete();
        async.elapse(kRemoteTurnStartGrace * 2);
        async.flushMicrotasks();

        expect(changes, changesAtDispose);
        expect(sendError, isNull);
        expect(createError, isA<RemoteControlException>());
        expect(repository.createWorktreeCalls, hasLength(1));
      });
    });
  });

  group('chat ids', () {
    test('are minted beside message ids, in desktop-valid formats', () {
      final engine = buildRemoteEngine(
        repository: FakeRemoteControlRepository(),
        clock: () => DateTime.fromMillisecondsSinceEpoch(1791230000000),
      );
      final validId = RegExp(r'^[a-z0-9][a-z0-9-]*$');
      final worktreeId = engine.sends.mintChatId(RemoteChatScope.worktree);
      final standaloneId = engine.sends.mintChatId(RemoteChatScope.standalone);

      expect(worktreeId, matches(RegExp(r'^chat-m1791230000000-[0-9a-f]{6}$')));
      expect(standaloneId, matches(RegExp(r'^cc-[0-9a-z]+-[0-9a-z]+$')));
      expect(
        standaloneId,
        startsWith('cc-${1791230000000.toRadixString(36)}-'),
      );
      expect(worktreeId, matches(validId));
      expect(standaloneId, matches(validId));
      engine.dispose();
    });

    test(
      'come from the injected factory, for tabs and first sends alike',
      () async {
        final repository = FakeRemoteControlRepository();
        var minted = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          chatId: (scope, _) => '${scope.name}-${++minted}',
        );
        await engine.session.connect('123456');
        final tabs = engine.chatTabs(onChanged: () {}, onCreateFailed: (_) {});
        const worktree = RemoteWorktree(
          localId: 'wt-1',
          workspaceLocalId: 'ws-1',
          branch: 'main',
        );

        expect(tabs.create(worktree).chatId, 'worktree-1');
        await _pump();
        await engine.sends.sendChatMessage(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          'hello',
        );
        expect(repository.createChatTabTargets.map((target) => target.chatId), [
          'worktree-1',
          'worktree-2',
        ]);
        expect(
          engine.sends.mintChatId(RemoteChatScope.standalone),
          'standalone-3',
        );
        tabs.dispose();
        engine.dispose();
      },
    );
  });

  group('retained attachment outcomes', () {
    const newTab = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-new',
    );
    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'main',
    );
    List<ChatAttachmentDraft> drafts() => [
      ChatAttachmentDraft(
        localId: 'draft',
        filename: 'notes.txt',
        mediaType: 'text/plain',
        bytes: Uint8List(1),
        status: ChatAttachmentStatus.ready,
      ),
    ];

    test(
      'a rejected tab creation restores its batches in the worktree',
      () async {
        final repository = FakeRemoteControlRepository();
        final engine = buildRemoteEngine(repository: repository);
        await engine.session.connect('123456');
        final createId = await engine.sends.createChatTab(newTab);
        engine.retainPendingChatAttachments(
          commandId: 'send-1',
          target: newTab,
          drafts: drafts(),
          provisionalCreateCommandId: createId,
        );
        expect(
          engine.takeRestorableChatAttachments(
            target: _chat,
            worktree: worktree,
          ),
          isEmpty,
        );

        repository.eventsController.add(
          _batch([
            RemoteCommandFailedEvent(commandId: createId, message: 'No tab'),
          ]),
        );
        await _pump();

        expect(
          engine
              .takeRestorableChatAttachments(target: _chat, worktree: worktree)
              .map((batch) => batch.commandId),
          ['send-1'],
        );
        engine.dispose();
      },
    );

    test('outcomes that raced ahead of retention still restore', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      repository.sendChatMessageHandler = () async =>
          const RemoteChatSendResult(commandId: 'send-2', chatId: 'chat-1');
      await engine.sends.sendChatMessage(
        _chat,
        'with a file',
        options: const RemoteChatSendOptions(
          attachments: [
            ChatAttachmentRef(
              attachmentId: 'a',
              filename: 'notes.txt',
              mediaType: 'text/plain',
              size: 1,
              contentSha256: 'x',
              storageKind: 'blob',
              source: '/a',
            ),
          ],
        ),
      );
      repository.eventsController.add(
        _batch(const [
          RemoteCommandFailedEvent(commandId: 'send-2', message: 'Rejected'),
        ]),
      );
      await _pump();

      engine.retainPendingChatAttachments(
        commandId: 'send-2',
        target: _chat,
        drafts: drafts(),
      );

      expect(
        engine
            .takeRestorableChatAttachments(target: _chat)
            .map((batch) => batch.commandId),
        ['send-2'],
      );
      engine.dispose();
    });
  });

  group('authoritative repair of missed live events', () {
    for (final truncated in [false, true]) {
      test(
        'an idle send survives an earlier ${truncated ? 'truncated' : 'full'} '
        'snapshot after its echo and timer',
        () async {
          final repository = FakeRemoteControlRepository();
          final engine = buildRemoteEngine(repository: repository);
          addTearDown(engine.dispose);
          await engine.session.connect('123456');
          repository.eventsController.add(
            _batch([
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: _row('earlier'),
              ),
            ]),
          );
          await _pump();
          engine.hydration.ensureChatTranscript(_chat);
          await _pump();
          expect(repository.requestChatTranscriptCalls, 1);
          await engine.sends.sendChatMessage(_chat, 'continue');
          final id =
              repository.sendChatMessageCalls.single.options!.userMessageId!;
          final timer = RemoteChatMessage.fromWireJson({
            'messageId': '$id:turn-timer',
            'chatId': 'chat-1',
            'scope': 'worktree',
            'role': 'system',
            'status': 'streaming',
            'text': '',
            'parts': [
              {
                'kind': 'turn_timer',
                'data': {'startedAt': 1792800000000},
              },
            ],
          });
          repository.eventsController.add(
            _batch([
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: _row(id, role: ChatRole.user, text: 'continue'),
              ),
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: timer,
              ),
            ]),
          );
          await _pump();
          expect(engine.unsent.byId(id), isNull);
          expect(engine.sends.isAwaitingAgentTurn(_chat), isFalse);
          repository.eventsController.add(
            _batch([
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.worktree,
                chatMessages: [_row('earlier')],
                chatMessagesTruncated: truncated,
              ),
            ]),
          );
          await _pump();
          expect(_ids(engine), ['earlier', id, '$id:turn-timer']);
          expect(engine.messagesFor(_chat).any((m) => m.isStreaming), isTrue);

          repository.eventsController.add(
            _batch([
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: _row(
                  'reply',
                  status: ChatMessageStatus.streaming,
                  text: 'Working',
                ),
              ),
            ]),
          );
          await _pump();
          expect(engine.messagesFor(_chat).last.text, 'Working');
          repository.eventsController.add(
            _batch([
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: _row('reply', text: 'Done'),
              ),
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: RemoteChatMessage.fromWireJson({
                  'messageId': '$id:turn-timer',
                  'chatId': 'chat-1',
                  'scope': 'worktree',
                  'role': 'system',
                  'status': 'complete',
                  'text': '',
                }),
              ),
            ]),
          );
          await _pump();
          expect(engine.messagesFor(_chat).any((m) => m.isStreaming), isFalse);
        },
      );
    }

    for (final delivery in ['snapshot', 'live replay', 'state read']) {
      test(
        'an earlier same-text $delivery does not retire a new idle send',
        () async {
          final repository = FakeRemoteControlRepository();
          final engine = buildRemoteEngine(repository: repository);
          addTearDown(engine.dispose);
          await engine.session.connect('123456');
          final old = _row(
            'old-continue',
            role: ChatRole.user,
            text: 'continue',
          );
          repository.eventsController.add(
            _batch([
              _chatSnapshot([old]),
            ]),
          );
          await _pump();
          await engine.sends.sendChatMessage(_chat, 'continue');
          final id =
              repository.sendChatMessageCalls.single.options!.userMessageId!;
          if (delivery == 'state read') {
            repository.snapshotBuilder = () => RemoteSessionSnapshot(
              workspaces: const [],
              worktrees: const [],
              standaloneChats: const [],
              chatMessages: [old],
            );
            await engine.refresh();
          } else {
            repository.eventsController.add(
              _batch([
                if (delivery == 'snapshot')
                  _chatSnapshot([old])
                else
                  RemoteChatMessageEvent(
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    message: old,
                  ),
              ]),
            );
            await _pump();
          }
          expect(_ids(engine), ['old-continue', id]);
          repository.eventsController.add(
            _batch([
              RemoteChatMessageEvent(
                chatId: 'chat-1',
                scope: RemoteChatScope.worktree,
                message: _row(id, role: ChatRole.user, text: 'continue'),
              ),
            ]),
          );
          await _pump();
          expect(_ids(engine), ['old-continue', id]);
          expect(engine.unsent.byId(id), isNull);
        },
      );
    }

    test('only new turn evidence releases the awaiting-turn bridge', () async {
      final repository = FakeRemoteControlRepository();
      final engine = buildRemoteEngine(repository: repository);
      await engine.session.connect('123456');
      repository.eventsController.add(
        _batch([
          _chatSnapshot([_row('reply-0')]),
        ]),
      );
      await _pump();

      await engine.sends.sendChatMessage(_chat, 'next');
      final id = repository.sendChatMessageCalls.single.options!.userMessageId!;
      final echo = _row(id, role: ChatRole.user, text: 'next');
      expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);

      // The live rows for this turn were missed. A repair carrying only the
      // earlier reply and the user echo proves no turn yet.
      repository.eventsController.add(
        _batch([
          _chatSnapshot([_row('reply-0'), echo]),
        ]),
      );
      await _pump();
      expect(_ids(engine), ['reply-0', id]);
      expect(engine.sends.isAwaitingAgentTurn(_chat), isTrue);

      repository.eventsController.add(
        _batch([
          _chatSnapshot([_row('reply-0'), echo, _row('reply-1')]),
        ]),
      );
      await _pump();
      expect(_ids(engine), ['reply-0', id, 'reply-1']);
      expect(engine.sends.isAwaitingAgentTurn(_chat), isFalse);
      engine.dispose();
    });
  });

  group('chatRevision', () {
    RemoteChatSummary summary(
      String chatId,
      String worktreeLocalId, {
      bool turnActive = false,
      int? turnElapsedMs,
    }) => RemoteChatSummary(
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: worktreeLocalId,
      title: chatId,
      turnActive: turnActive,
      turnElapsedMs: turnElapsedMs,
    );

    RemoteChatMessageEvent live(String chatId, String messageId) =>
        RemoteChatMessageEvent(
          chatId: chatId,
          scope: RemoteChatScope.worktree,
          message: RemoteChatMessage(
            messageId: messageId,
            chatId: chatId,
            scope: RemoteChatScope.worktree,
            role: ChatRole.assistant,
            status: ChatMessageStatus.streaming,
            text: 'streaming',
          ),
        );

    Future<(FakeRemoteControlRepository, RemoteClientEngine)>
    connected() async {
      final repository = FakeRemoteControlRepository()
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
            summary('chat-1', 'wt-1'),
            summary('chat-2', 'wt-1'),
            summary('chat-3', 'wt-2'),
          ],
        );
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      return (repository, engine);
    }

    test('unrelated changes leave the chat revision unchanged', () async {
      final (repository, engine) = await connected();
      final before = engine.chatRevision(_chat);
      var changes = 0;
      final unwatch = engine.sends.watchChanges(() => changes++);
      repository.eventsController.add(
        _batch([
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
          live('chat-2', 'sibling-row'),
          live('chat-3', 'other-worktree-row'),
          RemoteStateDeltaEvent(
            chatSummaries: [
              summary('chat-3', 'wt-2', turnActive: true, turnElapsedMs: 1000),
            ],
          ),
          const RemoteCommandCompletedEvent(commandId: 'unrelated'),
        ]),
      );
      await _pump();
      unwatch();

      expect(changes, greaterThan(0), reason: 'the batch applied');
      expect(engine.prState.prProgressFor('ws-1', 'wt-1'), isNotNull);
      expect(engine.chatRevision(_chat), before);
      engine.dispose();
    });

    test('each change to the chat changes its revision', () async {
      final (repository, engine) = await connected();
      var last = engine.chatRevision(_chat);
      void expectChanged(String step) {
        final next = engine.chatRevision(_chat);
        expect(next, isNot(last), reason: step);
        last = next;
      }

      repository.eventsController.add(_batch([live('chat-1', 'row-1')]));
      await _pump();
      expectChanged('a live row');

      repository.eventsController.add(
        _batch([
          RemoteStateDeltaEvent(
            chatSummaries: [summary('chat-1', 'wt-1', turnActive: true)],
          ),
        ]),
      );
      await _pump();
      expectChanged('its summary row');

      await engine.sends.sendChatMessage(_chat, 'next');
      expectChanged('a send');

      unawaited(
        engine.questions.answerQuestion(
          _chat,
          requestId: 'req-1',
          answers: const [],
        ),
      );
      expectChanged('a local question resolution');

      await engine.session.disconnect();
      expectChanged('a session reset');
      engine.dispose();
    });

    test('an expired awaiting-turn bridge changes the revision', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = buildRemoteEngine(
          repository: repository,
          clock: () => async.getClock(DateTime(2026)).now(),
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        unawaited(engine.sends.sendChatMessage(_chat, 'next'));
        async.flushMicrotasks();
        final awaiting = engine.chatRevision(_chat);
        expect(awaiting.awaitingTurn, isTrue);

        async.elapse(kRemoteTurnStartGrace);
        expect(engine.chatRevision(_chat).awaitingTurn, isFalse);
        expect(engine.chatRevision(_chat), isNot(awaiting));
        engine.dispose();
      });
    });

    test('a chatless target has a constant revision', () async {
      final (repository, engine) = await connected();
      const chatless = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      final before = engine.chatRevision(chatless);
      repository.eventsController.add(_batch([live('chat-1', 'row-1')]));
      await _pump();
      expect(engine.chatRevision(chatless), before);
      engine.dispose();
    });
  });

  group('CAN-4427 transcript failure recovery', () {
    const timedOut = 'The conversation took too long to load. Try again.';

    /// A connected engine whose chat load already failed twice.
    RemoteClientEngine failedChat(
      FakeAsync async,
      FakeRemoteControlRepository repository,
    ) {
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
        hydrationTimeout: const Duration(seconds: 2),
        hydrationRetryWindow: const Duration(seconds: 1),
      );
      unawaited(engine.session.connect('123456'));
      async.flushMicrotasks();
      engine.hydration.ensureChatTranscript(_chat);
      async.elapse(const Duration(seconds: 2 + 1 + 2));
      expect(repository.requestChatTranscriptCalls, 2);
      expect(engine.hydration.chatHydrationError(_chat), timedOut);
      return engine;
    }

    test('a live row for the chat clears its failure without Retry', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = failedChat(async, repository);

        // Another chat's live row and a generic snapshot's cached rows do
        // not prove this chat loaded.
        repository.eventsController.add(
          _batch([
            RemoteChatMessageEvent(
              chatId: 'chat-2',
              scope: RemoteChatScope.worktree,
              message: RemoteChatMessage(
                messageId: 'other',
                chatId: 'chat-2',
                scope: RemoteChatScope.worktree,
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'other chat',
              ),
            ),
            RemoteStateSnapshotEvent(
              scope: 'overview',
              chatMessages: [_row('cached-1')],
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), timedOut);
        expect(_ids(engine), ['cached-1']);

        repository.eventsController.add(
          _batch([
            RemoteChatMessageEvent(
              chatId: 'chat-1',
              scope: RemoteChatScope.worktree,
              message: _row('live-1'),
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        expect(engine.chatRevision(_chat).hydrationError, isNull);
        expect(_ids(engine), ['cached-1', 'live-1']);

        // Recovery is not a retry cycle: rebuilds request nothing.
        engine.hydration.ensureChatTranscript(_chat);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 2);
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        engine.dispose();
      });
    });

    test('a matching empty snapshot clears the failure', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = failedChat(async, repository);
        repository.eventsController.add(_batch([_chatSnapshot(const [])]));
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        expect(engine.hydration.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 2);
        engine.dispose();
      });
    });

    test('a reconnected event stream reloads the failed chat once', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = failedChat(async, repository);

        // Heartbeats on a live stream are not a recovery.
        repository.eventsLiveController.add(true);
        repository.eventsController.add(_batch(const []));
        async.flushMicrotasks();
        engine.hydration.ensureChatTranscript(_chat);
        expect(engine.hydration.chatHydrationError(_chat), timedOut);
        expect(repository.requestChatTranscriptCalls, 2);

        repository.eventsLiveController.add(false);
        async.elapse(const Duration(seconds: 3));
        expect(engine.session.linkState, RemoteLinkState.reconnecting);
        expect(engine.hydration.chatHydrationError(_chat), timedOut);

        repository.eventsLiveController.add(true);
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        engine.hydration.ensureChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 3);
        engine.hydration.ensureChatTranscript(_chat);
        repository.eventsLiveController.add(true);
        async.flushMicrotasks();
        expect(repository.requestChatTranscriptCalls, 3);
        engine.dispose();
      });
    });

    test('a desktop back from reconnecting reloads the failed chat', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = failedChat(async, repository);
        RemotePortalEventBatch status(RemotePortalConnectionStatus value) =>
            RemotePortalEventBatch(
              events: const [],
              nextCursor: 1,
              connectionStatus: value,
            );

        repository.eventsController.add(
          status(RemotePortalConnectionStatus.active),
        );
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), timedOut);

        repository.eventsController.add(
          status(RemotePortalConnectionStatus.reconnecting),
        );
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), timedOut);

        repository.eventsController.add(
          status(RemotePortalConnectionStatus.active),
        );
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        engine.hydration.ensureChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 3);
        engine.dispose();
      });
    });

    test('a reconnect sends a discovery that found no chat again', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true;
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 1),
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        bool loading() => engine.hydration.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        engine.hydration.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.elapse(const Duration(seconds: 2 + 1 + 2));
        expect(engine.hydration.foregroundChatError('ws-1', 'wt-1'), timedOut);
        expect(repository.requestChatTranscriptCalls, 2);

        repository.eventsLiveController.add(false);
        async.elapse(const Duration(seconds: 3));
        expect(engine.session.linkState, RemoteLinkState.reconnecting);
        repository.eventsLiveController.add(true);
        async.flushMicrotasks();

        // No chat is known, so no rebuild would load one: the discovery
        // goes out again by itself, once.
        expect(engine.hydration.foregroundChatError('ws-1', 'wt-1'), isNull);
        expect(repository.requestChatTranscriptCalls, 3);
        expect(repository.requestChatTranscriptTargets.last.chatId, isNull);
        expect(loading(), isTrue);
        engine.hydration.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        repository.eventsLiveController.add(true);
        async.flushMicrotasks();
        expect(repository.requestChatTranscriptCalls, 3);
        engine.dispose();
      });
    });

    test('another chat snapshot keeps a discovery failure with its chat', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true;
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 1),
          // The retry window is measured on the test's fake time.
          clock: async.getClock(DateTime(2026, 10, 24)).now,
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        const other = RemoteWorktreeChatTarget(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          chatId: 'chat-2',
        );
        RemoteChatSummary tab(String chatId, {required bool active}) =>
            RemoteChatSummary(
              chatId: chatId,
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              title: chatId,
              active: active,
            );
        RemoteStateSnapshotEvent snapshotOf(String chatId) =>
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              targetChatId: chatId,
              targetChatScope: RemoteChatScope.worktree,
            );

        // The desktop names chat-1 during the discovery's last attempt,
        // and the discovery then fails for it.
        engine.hydration.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.elapse(const Duration(seconds: 2 + 1));
        repository.eventsController.add(
          _batch([
            RemoteStateSnapshotEvent(
              scope: 'worktree_chat_summaries',
              chatSummaries: [
                tab('chat-1', active: true),
                tab('chat-2', active: false),
              ],
            ),
          ]),
        );
        async.flushMicrotasks();
        engine.hydration.ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        expect(
          [
            for (final target in repository.requestChatTranscriptTargets)
              target.chatId,
          ],
          [null, null],
        );
        expect(engine.hydration.chatHydrationError(_chat), timedOut);

        // chat-2 loads on its own; its snapshot leaves chat-1's failure.
        engine.hydration.ensureChatTranscript(other);
        expect(repository.requestChatTranscriptTargets.last.chatId, 'chat-2');
        repository.eventsController.add(_batch([snapshotOf('chat-2')]));
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(other), isNull);
        expect(engine.hydration.chatHydrationError(_chat), timedOut);
        expect(engine.chatRevision(_chat).hydrationError, timedOut);

        // Back on chat-1 inside the retry window: nothing goes out.
        engine.hydration
          ..reopenChatTranscript(_chat)
          ..ensureChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 3);
        expect(engine.hydration.chatHydrationError(_chat), timedOut);

        // After the window, a reopening loads chat-1 itself, once.
        async.elapse(const Duration(seconds: 1));
        engine.hydration
          ..reopenChatTranscript(_chat)
          ..ensureChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 4);
        expect(repository.requestChatTranscriptTargets.last.chatId, 'chat-1');
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        repository.eventsController.add(_batch([snapshotOf('chat-1')]));
        async.flushMicrotasks();
        expect(engine.hydration.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 4);
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        engine.dispose();
      });
    });

    test('any chat snapshot answers a discovery that named no chat', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository()
          ..supportsForegroundChat = true;
        final engine = buildRemoteEngine(
          repository: repository,
          stateRefreshDebounce: Duration.zero,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 1),
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        engine.hydration.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.elapse(const Duration(seconds: 2 + 1 + 2));
        expect(engine.hydration.foregroundChatError('ws-1', 'wt-1'), timedOut);

        repository.eventsController.add(
          _batch([
            const RemoteStateSnapshotEvent(
              scope: 'chat',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              targetChatId: 'chat-2',
              targetChatScope: RemoteChatScope.worktree,
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(engine.hydration.foregroundChatError('ws-1', 'wt-1'), isNull);
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 2);
        engine.dispose();
      });
    });

    test('a new pairing starts without the old failure', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository();
        final engine = failedChat(async, repository);
        unawaited(engine.session.disconnect());
        async.flushMicrotasks();
        unawaited(engine.session.connect('654321'));
        async.flushMicrotasks();
        expect(engine.hydration.chatHydrationError(_chat), isNull);
        engine.hydration.ensureChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 3);
        engine.dispose();
      });
    });
  });

  group('CAN-3643 same-pairing metadata refresh', () {
    test('a superseded worktree follow-up still settles hydration', () async {
      var heartbeat = 0;
      final repository = _GatedNextSnapshotRepository()
        ..connectedSessionId = 'session-1'
        ..sessionMetadataBuilder = () => RemoteConnection(
          deviceLabel: 'Test Desktop',
          pairedAt: DateTime(2026),
          sessionId: 'session-1',
          lastSeenAt: DateTime.utc(2026, 10, 5, 12, 0, ++heartbeat),
        );
      final engine = buildRemoteEngine(
        repository: repository,
        stateRefreshDebounce: Duration.zero,
      );
      await engine.session.connect('123456');
      final generation = engine.session.sessionGeneration;
      engine.hydration.ensureWorktreeState(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      );
      final supersededRead = Completer<void>();
      repository.gateNextSnapshot = supersededRead;
      repository.eventsController.add(
        _batch([
          const RemoteStateSnapshotEvent(
            scope: 'worktree',
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: 'wt-1',
          ),
        ]),
      );
      await _pump();
      expect(
        engine.hydration.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isTrue,
      );

      // A heartbeat read replaces the metadata for the same pairing, then a
      // newer read supersedes the follow-up's held snapshot.
      final connection = engine.session.connection;
      await engine.session.refreshConnectionMetadata();
      expect(engine.session.connection, isNot(same(connection)));
      expect(await engine.refresh(), isTrue);
      supersededRead.complete();
      await _pump();
      await _pump();

      expect(engine.session.sessionGeneration, generation);
      expect(
        engine.hydration.isWorktreeChatsLoading(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        ),
        isFalse,
      );
      engine.dispose();
    });
  });

  group('CAN-4875 event-driven follow-ups', () {
    const summary = RemoteChatSummary(
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Chat',
    );
    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'main',
    );

    FakeRemoteControlRepository connected(FakeAsync async) {
      final repository = FakeRemoteControlRepository()
        ..supportsPrActions = true
        ..snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [worktree],
          standaloneChats: [],
          chatSummaries: [summary],
        );
      return repository;
    }

    test('a worktree snapshot with its tabs reads only the worktree slices '
        'once, after the snapshot', () {
      fakeAsync((async) {
        final repository = connected(async);
        final engine = buildRemoteEngine(repository: repository);
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        final overviewReads = repository.snapshotFetches;
        engine.hydration.refreshChangedFiles(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.flushMicrotasks();
        expect(repository.requestWorktreeStateCalls, 1);
        // No read before the desktop projected the worktree.
        expect(repository.fetchWorktreeStateSlicesCalls, 0);

        repository.eventsController.add(
          _batch([
            const RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              chatSummaries: [summary],
            ),
          ]),
        );
        async.elapse(const Duration(seconds: 5));
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(repository.snapshotFetches, overviewReads);
        expect(
          engine.hydration.changedFilesStatus('wt-1').phase,
          ChangedFilesLoadPhase.loaded,
        );
        expect(
          engine.hydration.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isFalse,
        );
        engine.dispose();
      });
    });

    test('a first worktree snapshot without tabs reads the overview once', () {
      fakeAsync((async) {
        final repository = FakeRemoteControlRepository()
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [worktree],
            standaloneChats: [],
          );
        final engine = buildRemoteEngine(repository: repository);
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        final overviewReads = repository.snapshotFetches;
        engine.hydration.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.flushMicrotasks();
        repository.eventsController.add(
          _batch([
            const RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ]),
        );
        async.elapse(const Duration(seconds: 5));
        expect(repository.snapshotFetches, overviewReads + 1);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(
          engine.hydration.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isFalse,
        );

        // Once hydrated, a re-projection needs no overview read.
        engine.hydration.refreshChangedFiles(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.flushMicrotasks();
        repository.eventsController.add(
          _batch([
            const RemoteStateSnapshotEvent(
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
            ),
          ]),
        );
        async.elapse(const Duration(seconds: 5));
        expect(repository.snapshotFetches, overviewReads + 1);
        expect(repository.fetchWorktreeStateSlicesCalls, 2);
        engine.dispose();
      });
    });

    test('a repeated projection shares its held read; a newer one reads '
        'again', () {
      fakeAsync((async) {
        final repository = connected(async);
        final engine = buildRemoteEngine(repository: repository);
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        final overviewReads = repository.snapshotFetches;
        engine.hydration.refreshChangedFiles(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.flushMicrotasks();
        RemoteStateSnapshotEvent projection(String eventId) =>
            RemoteStateSnapshotEvent(
              eventId: eventId,
              scope: 'worktree',
              targetWorkspaceLocalId: 'ws-1',
              targetWorktreeLocalId: 'wt-1',
              chatSummaries: const [summary],
            );
        repository.worktreeStateSlices = {
          'wt-1': {
            'changedFiles': {
              'wt-1': {
                'uncommitted': [
                  {'filePath': 'lib/a.dart', 'status': 'modified'},
                ],
              },
            },
          },
        };
        final gate = repository.worktreeStateSlicesGate = Completer<void>();
        repository.eventsController.add(_batch([projection('evt-1')]));
        async.flushMicrotasks();
        repository.eventsController.add(_batch([projection('evt-1')]));
        async.flushMicrotasks();
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(
          engine.hydration.changedFilesStatus('wt-1').phase,
          ChangedFilesLoadPhase.loading,
        );

        repository.worktreeStateSlicesGate = null;
        gate.complete();
        async.elapse(const Duration(seconds: 5));
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(repository.snapshotFetches, overviewReads);
        expect(
          engine.hydration.changedFilesStatus('wt-1').phase,
          ChangedFilesLoadPhase.loaded,
        );
        expect(
          [
            for (final file
                in engine.hydration.worktreeActivityFor('wt-1').changedFiles)
              file.filePath,
          ],
          ['lib/a.dart'],
        );
        expect(
          engine.hydration.isWorktreeChatsLoading(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
          isFalse,
        );

        // A newer projection is a new landing, so its read goes out.
        repository.worktreeStateSlices = {
          'wt-1': {
            'changedFiles': {
              'wt-1': {
                'uncommitted': [
                  {'filePath': 'lib/b.dart', 'status': 'modified'},
                ],
              },
            },
          },
        };
        repository.eventsController.add(_batch([projection('evt-2')]));
        async.elapse(const Duration(seconds: 5));
        expect(repository.fetchWorktreeStateSlicesCalls, 2);
        expect(
          [
            for (final file
                in engine.hydration.worktreeActivityFor('wt-1').changedFiles)
              file.filePath,
          ],
          ['lib/b.dart'],
        );
        engine.dispose();
      });
    });

    test('a hook event updates the open drawer and a stale read keeps it', () {
      fakeAsync((async) {
        final repository = connected(async)
          ..worktreeStateSlices = {
            'wt-1': {
              'hookDescriptors': [
                {
                  'workspaceLocalId': 'ws-1',
                  'worktreeLocalId': 'wt-1',
                  'hookKey': 'hook-lint',
                  'name': 'Lint on save',
                  'paused': false,
                },
              ],
            },
          };
        var changes = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          onChanged: () => changes++,
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        bool paused() => engine.hydration
            .worktreeActivityFor('wt-1')
            .hookDescriptors
            .single
            .paused;
        expect(paused(), isFalse);

        // A read with the old projection is in flight when the pause lands.
        final gate = repository.worktreeStateSlicesGate = Completer<void>();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        final before = changes;
        repository.eventsController.add(
          _batch([
            const RemoteHookDescriptorEvent(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
              hookKey: 'hook-lint',
              descriptor: {
                'workspaceLocalId': 'ws-1',
                'worktreeLocalId': 'wt-1',
                'hookKey': 'hook-lint',
                'name': 'Lint on save',
                'paused': true,
              },
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(paused(), isTrue);
        expect(changes, greaterThan(before));
        repository.worktreeStateSlicesGate = null;
        gate.complete();
        async.flushMicrotasks();
        expect(paused(), isTrue);
        engine.dispose();
      });
    });

    test('a background process delta updates the held slices and a stale '
        'read keeps it (CAN-5253)', () {
      fakeAsync((async) {
        final repository = connected(async)
          ..worktreeStateSlices = {
            'wt-1': {
              'backgroundProcesses': [backgroundProcessJson(localId: 'bg-a')],
            },
          };
        var changes = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          onChanged: () => changes++,
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        List<(String, RemoteBackgroundProcessStatus)> rows() => [
          for (final row
              in engine.hydration
                  .worktreeActivityFor('wt-1')
                  .backgroundProcesses)
            (row.localId, row.status),
        ];
        expect(rows(), [('bg-a', RemoteBackgroundProcessStatus.running)]);

        // A read with the old projection is in flight when the delta lands.
        final gate = repository.worktreeStateSlicesGate = Completer<void>();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        final before = changes;
        repository.eventsController.add(
          _batch([
            RemoteStateDeltaEvent(
              cursor: 5,
              scope: 'worktree',
              shell: RemoteShellDelta(
                backgroundProcessRemovals: const [
                  RemoteShellRemoval(
                    type: RemoteShellEntityType.backgroundProcess,
                    localId: 'bg-a',
                    parentLocalId: 'ws-1:wt-1',
                  ),
                ],
                backgroundProcesses: [
                  RemoteBackgroundProcess.fromJson(
                    backgroundProcessJson(localId: 'bg-b', status: 'queued'),
                  )!,
                  // Same worktree id, another workspace: not these slices.
                  RemoteBackgroundProcess.fromJson(
                    backgroundProcessJson(
                      localId: 'bg-c',
                      workspaceLocalId: 'ws-2',
                    ),
                  )!,
                ],
              ),
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(rows(), [('bg-b', RemoteBackgroundProcessStatus.queued)]);
        expect(changes, greaterThan(before));
        repository.worktreeStateSlicesGate = null;
        gate.complete();
        async.flushMicrotasks();
        expect(rows(), [('bg-b', RemoteBackgroundProcessStatus.queued)]);
        engine.dispose();
      });
    });

    test('a watcher delta updates the held slices and a stale '
        'read keeps it (CAN-5267)', () {
      fakeAsync((async) {
        final repository = connected(async)
          ..worktreeStateSlices = {
            'wt-1': {
              'watchers': [watcherJson(id: 'bg-a')],
            },
          };
        var changes = 0;
        final engine = buildRemoteEngine(
          repository: repository,
          onChanged: () => changes++,
        );
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        List<(String, String)> rows() => [
          for (final row
              in engine.hydration.worktreeActivityFor('wt-1').watchers)
            (row.id, row.status),
        ];
        expect(rows(), [('bg-a', 'active')]);

        // A read with the old projection is in flight when the delta lands.
        final gate = repository.worktreeStateSlicesGate = Completer<void>();
        unawaited(
          engine.hydration.refreshWorktreeActivity(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          ),
        );
        async.flushMicrotasks();
        final before = changes;
        repository.eventsController.add(
          _batch([
            RemoteStateDeltaEvent(
              cursor: 5,
              scope: 'worktree',
              shell: RemoteShellDelta(
                watcherRemovals: const [
                  RemoteShellRemoval(
                    type: RemoteShellEntityType.watcher,
                    localId: 'bg-a',
                    parentLocalId: 'ws-1:wt-1',
                  ),
                ],
                watchers: [
                  RemoteWatcher.fromJson(
                    watcherJson(id: 'bg-b', status: 'delivery_failed'),
                  )!,
                  // Same worktree id, another workspace: not these slices.
                  RemoteWatcher.fromJson(
                    watcherJson(id: 'bg-c', projectId: 'ws-2'),
                  )!,
                ],
              ),
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(rows(), [('bg-b', 'delivery_failed')]);
        expect(changes, greaterThan(before));
        repository.worktreeStateSlicesGate = null;
        gate.complete();
        async.flushMicrotasks();
        expect(rows(), [('bg-b', 'delivery_failed')]);
        repository.eventsController.add(
          _batch([
            const RemoteStateDeltaEvent(
              cursor: 6,
              scope: 'worktree',
              shell: RemoteShellDelta(
                watcherRemovals: [
                  RemoteShellRemoval(
                    type: RemoteShellEntityType.watcher,
                    localId: 'bg-b',
                  ),
                ],
              ),
            ),
          ]),
        );
        async.flushMicrotasks();
        expect(rows(), isEmpty);
        engine.dispose();
      });
    });

    test('a hook pause reads no overview', () {
      fakeAsync((async) {
        final repository = connected(async);
        final engine = buildRemoteEngine(repository: repository);
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        final overviewReads = repository.snapshotFetches;
        unawaited(
          engine.prState.setHooksPaused(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            paused: true,
            hookKey: 'hook-lint',
          ),
        );
        async.elapse(const Duration(seconds: 5));
        expect(repository.lastHooksPausedValue, isTrue);
        expect(repository.snapshotFetches, overviewReads);
        engine.dispose();
      });
    });

    test('a PR action reads no overview', () {
      fakeAsync((async) {
        final repository = connected(async);
        final engine = buildRemoteEngine(repository: repository);
        unawaited(engine.session.connect('123456'));
        async.flushMicrotasks();
        final overviewReads = repository.snapshotFetches;
        unawaited(engine.prState.runPrAction(worktree, RemotePrAction.create));
        async.elapse(const Duration(seconds: 5));
        expect(repository.snapshotFetches, overviewReads);
        engine.dispose();
      });
    });
  });
}

final class _GatedNextSnapshotRepository extends FakeRemoteControlRepository {
  Completer<void>? gateNextSnapshot;

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() async {
    final gate = gateNextSnapshot;
    gateNextSnapshot = null;
    if (gate != null) await gate.future;
    return super.fetchSnapshot();
  }
}
