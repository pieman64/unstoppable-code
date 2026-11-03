// Read receipts through the assembled engine: local reads overlay the
// snapshot at once, relay to the desktop with retry, and yield to newer
// authoritative output.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_shell_delta.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_client_engine.dart';

import '../../../../support/fake_remote_control_repository.dart';
import '../../../../support/remote_engine_harness.dart';

void main() {
  group('ReadReceiptTracker', () {
    for (final standalone in [false, true]) {
      final scope = standalone
          ? RemoteChatScope.standalone
          : RemoteChatScope.worktree;
      final target = standalone
          ? const RemoteStandaloneChatTarget(
              projectLocalId: 'ws',
              chatId: 'chat',
            )
          : const RemoteWorktreeChatTarget(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
              chatId: 'chat',
            );
      RemoteSessionSnapshot snapshot({
        bool unread = true,
        String stamp = '1',
        int? cursor,
      }) => RemoteSessionSnapshot(
        eventCursor: cursor,
        workspaces: const [],
        worktrees: const [
          RemoteWorktree(
            localId: 'wt',
            workspaceLocalId: 'ws',
            branch: 'main',
            hasUnread: true,
          ),
        ],
        standaloneChats: standalone
            ? [
                RemoteStandaloneChat(
                  localId: 'chat',
                  projectLocalId: 'ws',
                  title: 'Chat',
                  hasUnread: unread,
                  lastMessageAt: stamp,
                ),
              ]
            : const [],
        chatSummaries: standalone
            ? const []
            : [
                RemoteChatSummary(
                  chatId: 'chat',
                  scope: scope,
                  workspaceLocalId: 'ws',
                  worktreeLocalId: 'wt',
                  title: 'Chat',
                  hasUnread: unread,
                  lastMessageAt: stamp,
                ),
              ],
        chatMessages: [
          RemoteChatMessage(
            messageId: 'reply',
            chatId: 'chat',
            scope: scope,
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Answer',
          ),
        ],
      );
      bool? unread(RemoteClientEngine engine) => standalone
          ? engine.store.allStandaloneChats.single.hasUnread
          : engine.store.allChatSummaries.single.hasUnread;
      // The desktop's projected read state for the chat, as a live delta.
      RemotePortalEvent projected(
        int cursor, {
        required bool unread,
        String stamp = '1',
      }) {
        final state = snapshot(unread: unread, stamp: stamp);
        return RemoteStateDeltaEvent(
          cursor: cursor,
          chatSummaries: state.chatSummaries,
          shell: RemoteShellDelta(standaloneChats: state.standaloneChats),
        );
      }

      void emit(
        FakeRemoteControlRepository repo,
        FakeAsync time,
        List<RemotePortalEvent> events,
        int cursor,
      ) {
        repo.eventsController.add(
          RemotePortalEventBatch(events: events, nextCursor: cursor),
        );
        time.flushMicrotasks();
      }

      // The desktop answers a fresh projection of the chat from [desktop]
      // and stores it in the server's cache through [cache]. A worktree
      // chat's snapshot carries its tab summaries and precedes its
      // completion. A standalone chat's overview request completes before
      // its state read. Returns how many projections were requested.
      int Function() serveFreshProjections(
        FakeRemoteControlRepository repo,
        RemoteSessionSnapshot Function() desktop,
        void Function(RemoteSessionSnapshot state) cache,
      ) {
        var served = 0;
        repo.requestChatTranscriptHandler = (target) async {
          if (target is! RemoteWorktreeChatTarget) return null;
          final id = 'fresh-${++served}';
          final state = desktop();
          cache(state);
          repo.eventsController.add(
            RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(
                  commandId: id,
                  scope: 'chat',
                  chatSummaries: state.chatSummaries,
                  chatMessages: state.chatMessages,
                  targetWorkspaceLocalId: 'ws',
                  targetWorktreeLocalId: 'wt',
                  targetChatId: 'chat',
                  targetChatScope: scope,
                ),
                RemoteCommandCompletedEvent(commandId: id),
              ],
              nextCursor: 1000 + served,
            ),
          );
          return id;
        };
        repo.requestOverviewStateHandler = () async {
          served++;
          cache(desktop());
        };
        return () => served;
      }

      test(
        '$scope cached continuation hydration blocks interim read receipts',
        () {
          fakeAsync((time) {
            final fixture =
                jsonDecode(
                      File(
                        'test/fixtures/portal-continuation-hydration.json',
                      ).readAsStringSync(),
                    )
                    as List<dynamic>;
            final state = snapshot().copyWith(
              chatMessages: RemoteSessionSnapshot.fromJson({
                'chatMessages': [
                  for (final row in fixture)
                    {...row as Map<String, dynamic>, 'scope': scope.wire},
                ],
              }).chatMessages,
            );
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = () => state;
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final hydrated = engine.transcripts.messagesFor(target);
            final timer = findNewestTurnTimer(hydrated);
            expect(timer, isNotNull);
            expect(timer?.startedAt, 1000);
            expect(timer?.isLive, isTrue);
            expect(hydrated, hasLength(3));
            expect(
              hydrated.map((message) => message.status),
              everyElement(ChatMessageStatus.complete),
            );
            expect(
              hydrated
                  .singleWhere((message) => message.messageId == 'steering')
                  .continuesTurn,
              isTrue,
            );
            expect(engine.transcripts.isStreamingForChat(target), isTrue);
            engine.readReceipts.acknowledgeVisibleChat(target, 'interim');
            time.flushMicrotasks();
            expect(repo.markReadCalls, isEmpty);
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      for (final continuation in [false, true]) {
        test(
          '$scope marks completed output read despite an unfinished tool, continuation=$continuation',
          () {
            fakeAsync((time) {
              final repo = FakeRemoteControlRepository()
                ..supportsChatMarkRead = true
                ..snapshotBuilder = snapshot;
              final engine = buildRemoteEngine(repository: repo);
              engine.session.connect('123456');
              time.flushMicrotasks();
              RemoteChatMessage timer({int? end}) => RemoteChatMessage(
                messageId: 'timer',
                chatId: 'chat',
                scope: scope,
                role: ChatRole.system,
                status: end == null
                    ? ChatMessageStatus.streaming
                    : ChatMessageStatus.complete,
                text: '',
                parts: [
                  ChatPart(
                    kind: 'turn_timer',
                    data: {'startedAt': 1000, 'completedAt': end},
                  ),
                ],
              );
              void emit(List<RemoteChatMessage> rows, int cursor) {
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
                time.flushMicrotasks();
              }

              emit([
                RemoteChatMessage(
                  messageId: 'tool',
                  chatId: 'chat',
                  scope: scope,
                  role: ChatRole.system,
                  status: ChatMessageStatus.streaming,
                  text: '',
                  occurredAt: DateTime.fromMillisecondsSinceEpoch(1500),
                ),
                timer(),
              ], 1);
              if (continuation) {
                emit([
                  RemoteChatMessage.fromWireJson({
                    'messageId': 'steering',
                    'chatId': 'chat',
                    'scope': scope.wire,
                    'role': 'user',
                    'status': 'complete',
                    'text': 'Try another approach',
                    'continuesTurn': true,
                    'createdAtMs': 1600,
                  }),
                  RemoteChatMessage.fromWireJson({
                    'messageId': 'interim',
                    'chatId': 'chat',
                    'scope': scope.wire,
                    'role': 'assistant',
                    'status': 'complete',
                    'text': 'Still checking',
                    'createdAtMs': 1700,
                  }),
                ], 2);
              }
              engine.readReceipts.acknowledgeVisibleChat(
                target,
                continuation ? 'interim' : 'reply',
              );
              time.flushMicrotasks();
              expect(repo.markReadCalls, isEmpty);
              emit([timer(end: 2000)], 3);
              engine.readReceipts.acknowledgeVisibleChat(
                target,
                continuation ? 'interim' : 'reply',
              );
              time.flushMicrotasks();
              expect(unread(engine), isFalse);
              expect(
                repo.markReadCalls.single.lastMessageId,
                continuation ? 'interim' : 'reply',
              );
              expect(
                engine.transcripts
                    .projectedRows((scope: scope, chatId: 'chat'))
                    .singleWhere((row) => row.messageId == 'tool')
                    .isStreaming,
                isTrue,
              );
              engine.dispose();
              repo.eventsController.close();
              time.flushMicrotasks();
            });
          },
        );
      }

      test(
        '$scope clears immediately and restores unread for newer output',
        () {
          fakeAsync((time) {
            var state = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = () => state;
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            expect(unread(engine), isFalse);
            state = snapshot(stamp: '2');
            engine.refresh();
            time.flushMicrotasks();
            expect(
              unread(engine),
              isTrue,
              reason: 'A newer summary can arrive before its transcript',
            );
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            expect(
              unread(engine),
              isTrue,
              reason: 'Rebuilding old output cannot hide a newer summary',
            );
            expect(
              repo.markReadCalls.every((c) => c.lastMessageId == 'reply'),
              isTrue,
            );
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      test(
        '$scope retries failures beyond three attempts and stops after confirmation',
        () {
          fakeAsync((time) {
            var state = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = () => state;
            repo.markReadHandler = (_, _) async =>
                throw const RemoteControlException('offline');
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            time.elapse(const Duration(seconds: 31));
            time.flushMicrotasks();
            expect(repo.markReadCalls.length, greaterThan(3));
            expect(unread(engine), isFalse);
            expect(engine.commands.failureMessage, isNull);
            state = snapshot(unread: false);
            engine.refresh();
            time.flushMicrotasks();
            final calls = repo.markReadCalls.length;
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(calls));
            // A new authoritative unread cycle must not reuse an old receipt,
            // even if the server has not supplied a different timestamp yet.
            state = snapshot();
            engine.refresh();
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            expect(
              unread(engine),
              isTrue,
              reason: 'A new unread cycle must wait for fresh output',
            );
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      test('$scope stops retrying after its chat is removed', () {
        fakeAsync((time) {
          var state = snapshot();
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = () => state;
          repo.markReadHandler = (_, _) async =>
              throw const RemoteControlException('offline');
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          expect(repo.markReadCalls, hasLength(1));

          state = RemoteSessionSnapshot(
            workspaces: const [],
            worktrees: const [
              RemoteWorktree(
                localId: 'wt',
                workspaceLocalId: 'ws',
                branch: 'main',
              ),
            ],
            standaloneChats: const [],
            chatSummaries: standalone
                ? const []
                : const [
                    RemoteChatSummary(
                      chatId: 'sibling',
                      scope: RemoteChatScope.worktree,
                      workspaceLocalId: 'ws',
                      worktreeLocalId: 'wt',
                      title: 'Sibling',
                    ),
                  ],
            // Keep the cached transcript present to reproduce the stale-output
            // path that previously allowed the retry guard to pass.
            chatMessages: [
              RemoteChatMessage(
                messageId: 'reply',
                chatId: 'chat',
                scope: scope,
                role: ChatRole.assistant,
                status: ChatMessageStatus.complete,
                text: 'Answer',
              ),
            ],
          );
          engine.refresh();
          time.flushMicrotasks();
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();

          expect(repo.markReadCalls, hasLength(1));
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      // CAN-4875: the desktop's completion settles the receipt even when its
      // summary delta never arrives. No retry or overview read follows.
      test('$scope settles on its completion without an overview read', () {
        fakeAsync((time) {
          var desktop = snapshot();
          // The server's cache keeps the unread; the read delta never comes.
          var state = snapshot();
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = (() => state)
            ..markReadHandler = (_, _) async {
              desktop = snapshot(unread: false);
              return 'read-cmd';
            };
          final fresh = serveFreshProjections(
            repo,
            () => desktop,
            (cached) => state = cached,
          );
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          expect(repo.markReadCalls, hasLength(1));
          final overviewReads = repo.snapshotFetches;
          repo.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteCommandCompletedEvent(
                  commandId: 'read-cmd',
                  result: {'outcome': 'applied'},
                ),
              ],
              nextCursor: 1,
            ),
          );
          time.flushMicrotasks();
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(repo.markReadCalls, hasLength(1));
          expect(repo.snapshotFetches, overviewReads);
          expect(fresh(), 0);
          expect(unread(engine), isFalse);

          // A settled receipt is not resent after a return either. A stale
          // unread from the return's state read asks the desktop once.
          engine.session.onAppBackgrounded();
          engine.session.onAppForegrounded();
          time.elapse(const Duration(minutes: 1));
          time.flushMicrotasks();
          expect(repo.markReadCalls, hasLength(1));
          expect(fresh(), lessThanOrEqualTo(1));
          expect(unread(engine), isFalse);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      test('$scope settles on a completion that raced ahead of the submit', () {
        fakeAsync((time) {
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = snapshot;
          repo.markReadHandler = (_, _) async {
            // The terminal event lands before the submit answers.
            repo.eventsController.add(
              const RemotePortalEventBatch(
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'read-early',
                    result: {'outcome': 'applied'},
                  ),
                ],
                nextCursor: 1,
              ),
            );
            await Future<void>.delayed(Duration.zero);
            return 'read-early';
          };
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(repo.markReadCalls, hasLength(1));
          expect(unread(engine), isFalse);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      // Published review 5646836175: a completion settled the receipt without
      // confirming it, so a later desktop mark-unread of the same output
      // stayed hidden behind the local read. Required review f16cc32b: the
      // unread could also predate the read, so a fresh projection decides.
      test(
        '$scope a desktop unread after a completion without its read delta shows',
        () {
          fakeAsync((time) {
            var desktop = snapshot();
            var state = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = (() => state)
              ..markReadHandler = (_, _) async {
                desktop = snapshot(unread: false);
                return 'read-cmd';
              };
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final overviewReads = repo.snapshotFetches;
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            // The desktop's read delta is lost; only its completion arrives.
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-cmd',
                result: {'outcome': 'applied'},
              ),
            ], 1);
            expect(unread(engine), isFalse);
            // The desktop marks the same output unread: its message id and
            // timestamp stay the same.
            desktop = snapshot();
            emit(repo, time, [projected(2, unread: true)], 2);
            expect(fresh(), 0);
            // The unread waits 3 seconds for the read's own summary, then a
            // fresh projection confirms it.
            time.elapse(const Duration(seconds: 3));
            time.flushMicrotasks();
            expect(fresh(), 1);
            expect(unread(engine), isTrue);
            // Rebuilding the old output cannot hide the desktop's unread.
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            expect(fresh(), 1);
            expect(repo.markReadCalls, hasLength(1));
            expect(repo.snapshotFetches, overviewReads + (standalone ? 1 : 0));
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // An unread before the answer can also be a later desktop unread that
      // a state read covers (verify 4b0e79e9, N1). Without the read's own
      // summary, one fresh projection confirms the read.
      test('$scope an unread before the completion keeps the local read', () {
        fakeAsync((time) {
          var desktop = snapshot();
          var state = snapshot();
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = (() => state)
            ..markReadHandler = (_, _) async {
              desktop = snapshot(unread: false);
              return 'read-cmd';
            };
          final fresh = serveFreshProjections(
            repo,
            () => desktop,
            (cached) => state = cached,
          );
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          // A delta the desktop projected before it applied the read.
          emit(repo, time, [projected(1, unread: true)], 1);
          expect(unread(engine), isFalse);
          emit(repo, time, const [
            RemoteCommandCompletedEvent(
              commandId: 'read-cmd',
              result: {'outcome': 'applied'},
            ),
          ], 2);
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(unread(engine), isFalse);
          expect(repo.markReadCalls, hasLength(1));
          expect(fresh(), 1);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      // A worktree read's summary is a throttled projection that follows its
      // completion; a projection read before the commit can arrive between.
      test('$scope an old unread after the completion settles read', () {
        fakeAsync((time) {
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = snapshot
            ..markReadHandler = (_, _) async => 'read-cmd';
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          final overviewReads = repo.snapshotFetches;
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          emit(repo, time, [
            const RemoteCommandCompletedEvent(
              commandId: 'read-cmd',
              result: {'outcome': 'applied'},
            ),
            projected(1, unread: true),
            projected(2, unread: false),
          ], 2);
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(unread(engine), isFalse);
          emit(repo, time, [projected(3, unread: true)], 3);
          expect(unread(engine), isTrue);
          expect(repo.markReadCalls, hasLength(1));
          expect(repo.snapshotFetches, overviewReads);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      // Required review f16cc32b: the completion overtakes an older summary,
      // which arrives in its own batch, and the read's own summary is lost.
      // That old unread cannot hide the read for good: a fresh desktop
      // projection settles it.
      test(
        '$scope an old unread after the completion, with its read delta lost, settles read',
        () {
          fakeAsync((time) {
            var desktop = snapshot();
            var state = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = (() => state)
              ..markReadHandler = (_, _) async {
                desktop = snapshot(unread: false);
                return 'read-cmd';
              };
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final reads = repo.snapshotFetches;
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-cmd',
                result: {'outcome': 'applied'},
              ),
            ], 1);
            emit(repo, time, [projected(2, unread: true)], 2);
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(unread(engine), isFalse);
            expect(fresh(), 1);
            expect(repo.markReadCalls, hasLength(1));
            // Only a standalone chat's overview request needs a state read.
            expect(repo.snapshotFetches, reads + (standalone ? 1 : 0));
            // The read is confirmed, so a desktop unread shows at once.
            desktop = snapshot();
            emit(repo, time, [projected(3, unread: true)], 3);
            expect(unread(engine), isTrue);
            time.elapse(const Duration(minutes: 5));
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            expect(fresh(), 1);
            expect(repo.markReadCalls, hasLength(1));
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // Required review f16cc32b: another client read the chat, and its
      // summary was lost. The phone's read is declined, the state read still
      // returns the cached unread, and no summary follows. A fresh desktop
      // projection settles the read instead of endless retries.
      test(
        '$scope an already-read rejection with a stale state read settles from a fresh projection',
        () {
          fakeAsync((time) {
            var state = snapshot();
            var desktop = snapshot(unread: false);
            var sends = 0;
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = (() => state)
              ..markReadHandler = ((_, _) async => 'read-${++sends}');
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final reads = repo.snapshotFetches;
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-1',
                result: {'ok': true, 'applied': false},
              ),
            ], 1);
            time.elapse(const Duration(minutes: 10));
            time.flushMicrotasks();
            expect(unread(engine), isFalse);
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            expect(repo.snapshotFetches, reads + (standalone ? 1 : 0));
            // The read is confirmed, so a desktop unread shows.
            desktop = snapshot();
            emit(repo, time, [projected(2, unread: true)], 2);
            expect(unread(engine), isTrue);
            time.elapse(const Duration(minutes: 5));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // Verify 97f357fa, seeds 518 (worktree) and 1058 (standalone): a
      // retry released an applied read whose completion and summary were
      // lost. The next decline's projection still read a desktop unread, so
      // a later read applied, and was lost the same way. Its decline must
      // ask the desktop again instead of retrying for good.
      test(
        '$scope a later decline asks again after a projection read unread',
        () {
          fakeAsync((time) {
            var state = snapshot();
            var desktopUnread = true;
            var sends = 0;
            final declines = <RemotePortalEvent>[];
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = (() => state);
            repo.markReadHandler = (_, _) async {
              final id = 'read-${++sends}';
              if (desktopUnread) {
                // Applied; its completion and summary are lost.
                desktopUnread = false;
              } else {
                declines.add(
                  RemoteCommandCompletedEvent(
                    commandId: id,
                    result: const {'ok': true, 'applied': false},
                  ),
                );
              }
              return id;
            };
            final fresh = serveFreshProjections(
              repo,
              () => snapshot(unread: desktopUnread),
              (cached) => state = cached,
            );
            var cursor = 0;
            void answer() {
              if (declines.isEmpty) return;
              emit(repo, time, [...declines], ++cursor);
              declines.clear();
            }

            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            // The retry sends read-2, which the desktop declines.
            time.elapse(const Duration(seconds: 32));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(2));
            // The desktop marks the chat unread before the decline arrives.
            desktopUnread = true;
            emit(repo, time, [projected(++cursor, unread: true)], cursor);
            answer();
            expect(fresh(), 1);
            // read-3 applies and is lost; the retry's read-4 is declined.
            time.elapse(const Duration(seconds: 4));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(3));
            time.elapse(const Duration(seconds: 38));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(4));
            for (var round = 0; round < 10; round++) {
              answer();
              time.elapse(const Duration(minutes: 1));
              time.flushMicrotasks();
            }
            expect(fresh(), 2);
            expect(repo.markReadCalls, hasLength(4));
            expect(unread(engine), isFalse);
            // The read is confirmed, so a desktop unread shows at once.
            desktopUnread = true;
            emit(repo, time, [projected(++cursor, unread: true)], cursor);
            expect(unread(engine), isTrue);
            time.elapse(const Duration(minutes: 5));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(4));
            expect(fresh(), 2);
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // Verify 97f357fa, seeds 517 and 1594: another client's read
      // confirmed the receipt, and a desktop unread from before the phone's
      // read superseded it. The phone's own completion follows both, and its
      // summary is lost. The completion must still settle the read, also
      // when its submit answers after the confirmation.
      for (final lateSubmit in [false, true]) {
        test(
          '$scope its own completion settles a read another client confirmed, lateSubmit=$lateSubmit',
          () {
            fakeAsync((time) {
              var state = snapshot();
              var desktop = snapshot();
              final submitted = Completer<void>();
              final repo = FakeRemoteControlRepository()
                ..supportsChatMarkRead = true
                ..snapshotBuilder = (() => state);
              repo.markReadHandler = (_, _) async {
                desktop = snapshot(unread: false);
                if (lateSubmit) await submitted.future;
                return 'read-cmd';
              };
              final fresh = serveFreshProjections(
                repo,
                () => desktop,
                (cached) => state = cached,
              );
              final engine = buildRemoteEngine(repository: repo);
              engine.session.connect('123456');
              time.flushMicrotasks();
              engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
              time.flushMicrotasks();
              // Another client's read, then a desktop unread, both before
              // the phone's read applied.
              emit(repo, time, [
                projected(1, unread: false),
                projected(2, unread: true),
              ], 2);
              if (lateSubmit) {
                submitted.complete();
                time.flushMicrotasks();
              }
              emit(repo, time, const [
                RemoteCommandCompletedEvent(
                  commandId: 'read-cmd',
                  result: {'outcome': 'applied'},
                ),
              ], 3);
              time.elapse(const Duration(minutes: 2));
              time.flushMicrotasks();
              expect(unread(engine), isFalse);
              expect(repo.markReadCalls, hasLength(1));
              expect(fresh(), 1);
              // The read is confirmed, so a desktop unread shows at once.
              desktop = snapshot();
              emit(repo, time, [projected(4, unread: true)], 4);
              expect(unread(engine), isTrue);
              time.elapse(const Duration(minutes: 5));
              time.flushMicrotasks();
              expect(unread(engine), isTrue);
              expect(repo.markReadCalls, hasLength(1));
              expect(fresh(), 1);
              engine.dispose();
              repo.eventsController.close();
              time.flushMicrotasks();
            });
          },
        );
      }

      // Verify 4b0e79e9 (N1): while the app is backgrounded, the server
      // stores the read's completion and summary, and then a desktop unread
      // of the same output. The resume state read covers all of them, so the
      // store drops the replayed summaries and only the completion reaches
      // the receipt. The read must not hide the desktop's unread. The
      // control delivers the backlog before the state read.
      for (final backlogFirst in [false, true]) {
        test(
          '$scope a resume read that covers its own completion shows a later desktop unread, backlogFirst=$backlogFirst',
          () {
            fakeAsync((time) {
              var state = snapshot(cursor: 0);
              var desktop = snapshot();
              final repo = FakeRemoteControlRepository()
                ..supportsChatMarkRead = true
                ..snapshotBuilder = (() => state)
                ..markReadHandler = (_, _) async {
                  desktop = snapshot(unread: false);
                  return 'read-cmd';
                };
              final fresh = serveFreshProjections(
                repo,
                () => desktop,
                (cached) => state = cached,
              );
              final engine = buildRemoteEngine(repository: repo);
              engine.session.connect('123456');
              time.flushMicrotasks();
              engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
              time.flushMicrotasks();
              engine.session.onAppBackgrounded();
              time.flushMicrotasks();
              final backlog = [
                if (standalone) projected(1, unread: false),
                const RemoteCommandCompletedEvent(
                  commandId: 'read-cmd',
                  result: {'outcome': 'applied'},
                ),
                if (!standalone) projected(1, unread: false),
                projected(2, unread: true),
              ];
              desktop = snapshot();
              state = snapshot(cursor: 2);
              time.elapse(const Duration(seconds: 40));
              if (backlogFirst) emit(repo, time, backlog, 2);
              engine.session.onAppForegrounded();
              time.flushMicrotasks();
              time.elapse(const Duration(seconds: 1));
              time.flushMicrotasks();
              if (!backlogFirst) emit(repo, time, backlog, 2);
              time.elapse(const Duration(minutes: 2));
              time.flushMicrotasks();
              expect(unread(engine), isTrue);
              expect(repo.markReadCalls, hasLength(1));
              // Without the read's own summary, one fresh projection shows
              // the desktop's unread.
              expect(fresh(), backlogFirst ? 0 : 1);
              // Rebuilding the old output cannot hide the desktop's unread.
              engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
              time.flushMicrotasks();
              time.elapse(const Duration(minutes: 5));
              time.flushMicrotasks();
              expect(unread(engine), isTrue);
              expect(repo.markReadCalls, hasLength(1));
              expect(fresh(), backlogFirst ? 0 : 1);
              engine.dispose();
              repo.eventsController.close();
              time.flushMicrotasks();
            });
          },
        );
      }

      // Verify 0d60c0fc (class R): the desktop applies the phone's read and
      // then marks the same output unread. The completion and the unread
      // reach the phone before the read's submit answers. The read must not
      // hide the desktop's unread. The control delivers the read's own
      // summary, so the unread supersedes a confirmed receipt.
      for (final summaryLost in [true, false]) {
        test(
          '$scope a desktop unread before the read answers stays visible, summaryLost=$summaryLost',
          () {
            fakeAsync((time) {
              var state = snapshot();
              var desktop = snapshot();
              final answered = Completer<void>();
              final repo = FakeRemoteControlRepository()
                ..supportsChatMarkRead = true
                ..snapshotBuilder = (() => state)
                ..markReadHandler = (_, _) async {
                  await answered.future;
                  return 'read-cmd';
                };
              final fresh = serveFreshProjections(
                repo,
                () => desktop,
                (cached) => state = cached,
              );
              final engine = buildRemoteEngine(repository: repo);
              engine.session.connect('123456');
              time.flushMicrotasks();
              engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
              time.flushMicrotasks();
              emit(repo, time, [
                if (standalone && !summaryLost) projected(1, unread: false),
                const RemoteCommandCompletedEvent(
                  commandId: 'read-cmd',
                  result: {'outcome': 'applied'},
                ),
                if (!standalone && !summaryLost) projected(1, unread: false),
                projected(2, unread: true),
              ], 2);
              time.elapse(const Duration(seconds: 5));
              answered.complete();
              time.flushMicrotasks();
              time.elapse(const Duration(minutes: 2));
              time.flushMicrotasks();
              expect(unread(engine), isTrue);
              expect(repo.markReadCalls, hasLength(1));
              // One fresh projection shows the desktop's unread.
              expect(fresh(), 1);
              // Rebuilding the old output cannot hide the desktop's unread.
              engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
              time.flushMicrotasks();
              time.elapse(const Duration(minutes: 5));
              time.flushMicrotasks();
              expect(unread(engine), isTrue);
              expect(repo.markReadCalls, hasLength(1));
              expect(fresh(), 1);
              engine.dispose();
              repo.eventsController.close();
              time.flushMicrotasks();
            });
          },
        );
      }

      // CAN-4875 repair of verify 0d60c0fc, seeds 3933, 9784 and 16327 with
      // held answers: another client's read confirms the receipt, and a
      // desktop unread supersedes it while the phone's read is in flight.
      // That read applies, and its completion and summary are lost. One
      // fresh projection shows the desktop's read.
      test('$scope a superseding unread before the read answers recovers', () {
        fakeAsync((time) {
          var state = snapshot();
          var desktop = snapshot();
          final answered = Completer<void>();
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = (() => state)
            ..markReadHandler = (_, _) async {
              await answered.future;
              return 'read-cmd';
            };
          final fresh = serveFreshProjections(
            repo,
            () => desktop,
            (cached) => state = cached,
          );
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          emit(repo, time, [
            projected(1, unread: false),
            projected(2, unread: true),
          ], 2);
          // The phone's read applies after the unread.
          desktop = snapshot(unread: false);
          time.elapse(const Duration(seconds: 5));
          answered.complete();
          time.flushMicrotasks();
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(unread(engine), isFalse);
          expect(repo.markReadCalls, hasLength(1));
          expect(fresh(), 1);
          // The read is confirmed, so a desktop unread shows at once.
          desktop = snapshot();
          emit(repo, time, [projected(3, unread: true)], 3);
          expect(unread(engine), isTrue);
          time.elapse(const Duration(minutes: 5));
          time.flushMicrotasks();
          expect(unread(engine), isTrue);
          expect(repo.markReadCalls, hasLength(1));
          expect(fresh(), 1);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      // Verify 4b0e79e9, seed 13798: another client's read confirmed the
      // receipt, and an older desktop unread superseded it while the phone's
      // read waited for its answer. The projection that supersede requested
      // already follows the read, so the answer after it asks nothing more.
      test(
        '$scope an answer after a superseding unread asks no second projection',
        () {
          fakeAsync((time) {
            var state = snapshot();
            var desktop = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = (() => state)
              ..markReadHandler = (_, _) async {
                desktop = snapshot(unread: false);
                return 'read-cmd';
              };
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            emit(repo, time, [
              projected(1, unread: false),
              projected(2, unread: true),
            ], 2);
            time.elapse(const Duration(seconds: 3));
            time.flushMicrotasks();
            expect(fresh(), 1);
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-cmd',
                result: {'outcome': 'applied'},
              ),
            ], 3);
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(unread(engine), isFalse);
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            // The read is confirmed, so a desktop unread shows at once.
            desktop = snapshot();
            emit(repo, time, [projected(4, unread: true)], 4);
            expect(unread(engine), isTrue);
            time.elapse(const Duration(minutes: 5));
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // Published review 5646836175: the desktop answers `applied: false`
      // when it already read the chat, when the phone acknowledged older
      // output, and while a turn runs. One fresh projection tells them
      // apart.
      test(
        '$scope an already-read rejection reconciles once and stops retrying',
        () {
          fakeAsync((time) {
            // Another client read the chat; the phone missed the delta.
            var state = snapshot();
            var desktop = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..markReadHandler = ((_, _) async => 'read-cmd')
              ..snapshotBuilder = () => state;
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final overviewReads = repo.snapshotFetches + (standalone ? 1 : 0);
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            desktop = snapshot(unread: false);
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-cmd',
                result: {'ok': true, 'applied': false},
              ),
            ], 1);
            time.elapse(const Duration(minutes: 10));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            expect(repo.snapshotFetches, overviewReads);
            expect(unread(engine), isFalse);
            // The reconciled read is confirmed, so a desktop unread shows.
            emit(repo, time, [projected(2, unread: true)], 2);
            expect(unread(engine), isTrue);
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            expect(repo.snapshotFetches, overviewReads);
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      test(
        '$scope a stale-output rejection reconciles once and yields to newer output',
        () {
          fakeAsync((time) {
            // The desktop holds newer output; its events were lost.
            var state = snapshot();
            var desktop = snapshot();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..markReadHandler = ((_, _) async => 'read-cmd')
              ..snapshotBuilder = () => state;
            final fresh = serveFreshProjections(
              repo,
              () => desktop,
              (cached) => state = cached,
            );
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final overviewReads = repo.snapshotFetches + (standalone ? 1 : 0);
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            desktop = snapshot(stamp: '2');
            emit(repo, time, const [
              RemoteCommandCompletedEvent(
                commandId: 'read-cmd',
                result: {'ok': true, 'applied': false},
              ),
            ], 1);
            time.elapse(const Duration(minutes: 10));
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            expect(repo.markReadCalls, hasLength(1));
            expect(fresh(), 1);
            expect(repo.snapshotFetches, overviewReads);
            // Rebuilding the old output cannot acknowledge it again.
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(unread(engine), isTrue);
            expect(repo.markReadCalls, hasLength(1));
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      test('$scope a reset drops a rejected receipt before it reconciles', () {
        fakeAsync((time) {
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = snapshot
            ..markReadHandler = (_, _) async => 'read-cmd';
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          emit(repo, time, const [
            RemoteCommandCompletedEvent(
              commandId: 'read-cmd',
              result: {'ok': true, 'applied': false},
            ),
          ], 1);
          unawaited(engine.session.disconnect());
          time.flushMicrotasks();
          final overviewReads = repo.snapshotFetches;
          time.elapse(const Duration(minutes: 2));
          time.flushMicrotasks();
          expect(engine.readReceipts.hasReceipts, isFalse);
          expect(repo.markReadCalls, hasLength(1));
          expect(repo.snapshotFetches, overviewReads);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      test('$scope retries a failed read without overview reads', () {
        fakeAsync((time) {
          final repo = FakeRemoteControlRepository()
            ..supportsChatMarkRead = true
            ..snapshotBuilder = snapshot;
          repo.markReadHandler = (_, _) async =>
              throw const RemoteControlException('offline');
          final engine = buildRemoteEngine(repository: repo);
          engine.session.connect('123456');
          time.flushMicrotasks();
          final overviewReads = repo.snapshotFetches;
          engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
          time.flushMicrotasks();
          time.elapse(const Duration(seconds: 31));
          time.flushMicrotasks();
          expect(repo.markReadCalls.length, greaterThan(3));
          expect(repo.snapshotFetches, overviewReads);
          engine.dispose();
          repo.eventsController.close();
          time.flushMicrotasks();
        });
      });

      test(
        '$scope preserves receipts while backgrounded and retries on resume',
        () {
          fakeAsync((time) {
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = snapshot;
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            engine.session.onAppBackgrounded();
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(1));
            expect(unread(engine), isFalse);
            engine.session.onAppForegrounded();
            time.flushMicrotasks();
            time.elapse(const Duration(seconds: 3));
            time.flushMicrotasks();
            expect(repo.markReadCalls, hasLength(2));
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      test(
        '$scope retries desktop completing rejection and late submit cannot replace newer receipt',
        () {
          fakeAsync((time) {
            final gate = Completer<String>();
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true
              ..snapshotBuilder = snapshot;
            var submits = 0;
            repo.markReadHandler = (_, _) =>
                ++submits == 1 ? gate.future : Future.value('new-$submits');
            // The desktop still projects the output unread while its turn runs.
            final fresh = serveFreshProjections(repo, snapshot, (_) {});
            final engine = buildRemoteEngine(repository: repo);
            engine.session.connect('123456');
            time.flushMicrotasks();
            final overviewReads = repo.snapshotFetches + (standalone ? 1 : 0);
            engine.readReceipts.acknowledgeVisibleChat(target, 'reply');
            time.flushMicrotasks();
            time.elapse(const Duration(seconds: 33));
            time.flushMicrotasks();
            expect(submits, 2);
            gate.complete('old');
            time.flushMicrotasks();
            repo.eventsController.add(
              const RemotePortalEventBatch(
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'new-2',
                    result: {'applied': false},
                  ),
                ],
                nextCursor: 1,
              ),
            );
            time.flushMicrotasks();
            time.elapse(const Duration(seconds: 5));
            time.flushMicrotasks();
            expect(submits, 3);
            expect(engine.commands.failureMessage, isNull);
            // The fresh projection still reads unread for this output, as
            // while a desktop turn runs: retries continue, and each decline
            // asks the desktop once more.
            expect(fresh(), 1);
            expect(repo.snapshotFetches, overviewReads);
            repo.eventsController.add(
              const RemotePortalEventBatch(
                events: [
                  RemoteCommandCompletedEvent(
                    commandId: 'new-3',
                    result: {'applied': false},
                  ),
                ],
                nextCursor: 2,
              ),
            );
            time.flushMicrotasks();
            time.elapse(const Duration(minutes: 2));
            time.flushMicrotasks();
            expect(submits, greaterThan(3));
            expect(fresh(), 2);
            expect(repo.snapshotFetches, overviewReads + (standalone ? 1 : 0));
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        },
      );

      // CAN-4875 AC-07: seeded event orders for one chat against a desktop
      // that answers mark_read as its chat-read adapter does. The deltas and
      // terminals of phone reads can be lost; transcript rows can arrive
      // late. An older unread can follow a completion even when the read's
      // own summary is lost, and batches can split between them. Another
      // client's read can lose its summary. State reads return the server's
      // cache, which holds each projection the desktop emitted and never a
      // lost one, with the event cursor it covers; the store drops replayed
      // events that cursor covers. The desktop projects fresh state only
      // when the phone asks for it. After every step no
      // request is sent while backgrounded, overview reads stay bounded by
      // connects, returns, rejected receipts and fresh projections, and fresh
      // projections stay bounded by the phone's reads, answered or not, and
      // their own timed-out requests. After settling,
      // requests stop, the phone shows the desktop's read state, and a later
      // desktop unread of unchanged output shows. Seeds 0, 4 and 11 failed
      // this before the published-review repair. [losses] draws the review
      // f16cc32b combinations without changing the original [random] draws;
      // with them, seed 5 (worktree) and seed 8 (standalone) failed first
      // before that repair. Before the verify 97f357fa repair, seeds 518 and
      // 1058 retried for good, and seeds 517 and 1594 kept a false unread.
      // Before the verify 4b0e79e9 repair, seed 271 (worktree) hid a desktop
      // unread that a state read covered before the read's own completion.
      // A read's answer can also wait until the phone receives part of the
      // later events. Before the verify 0d60c0fc repair, that let seeds 2265
      // and 5187 hide a desktop unread and seeds 3933 (worktree) and 9784
      // (standalone) keep a false unread in the 20000-seed collector.
      // One case is out of reach without polling and pre-dates CAN-4875:
      // a desktop unread superseded the phone's receipt, so viewing the same
      // output sends nothing, and then another client's read lost its
      // summary. The server never stored that read either.
      test('$scope seeded read-receipt event orders converge', () {
        for (var seed = 0; seed < 2000; seed++) {
          fakeAsync((time) {
            final random = Random(seed);
            final losses = Random(seed + 7919);
            // Draws which reads answer only after the next delivery, without
            // changing the [random] and [losses] draws.
            final answers = Random(seed + 104729);
            final heldAnswers = <Completer<void>>[];
            final log = <String>[];
            String reason() => 'seed $seed after ${log.join(', ')}';
            var desktopUnread = true;
            var stamp = 1;
            var latest = 'reply';
            // The server cache: the last projection the desktop emitted. The
            // server stores events in order, so a state read covers every
            // event before its cursor, as production's eventCursor does.
            var cachedUnread = true;
            var cachedStamp = 1;
            var cursor = 0;
            var commandSeq = 0;
            var backgrounded = false;
            var failNext = false;
            var connecting = true;
            var connects = 0;
            var returns = 0;
            var rejections = 0;
            // The phone's reads that reached the desktop, answered or not.
            var submitted = 0;
            var fresh = 0;
            // Whether the desktop's latest read is another client's, with
            // its summary lost, and which of the phone's reads and
            // projections had reached the desktop by then.
            var otherReadLost = false;
            var submittedAtOtherRead = 0;
            var freshAtOtherRead = 0;
            // When each fresh projection was requested and settled.
            final freshRequested = <String, Duration>{};
            final freshSettled = <String, Duration>{};
            // Requests whose completion missed the phone's 30 s wait.
            int timedOutFresh() => freshRequested.entries
                .where(
                  (entry) =>
                      (freshSettled[entry.key] ?? time.elapsed) - entry.value >=
                      const Duration(seconds: 30),
                )
                .length;
            final outbox = <RemotePortalEvent>[];
            final lateRows = <RemotePortalEvent>[];
            final repo = FakeRemoteControlRepository()
              ..supportsChatMarkRead = true;
            RemotePortalEvent project({required bool unread, int? at}) {
              cachedUnread = unread;
              cachedStamp = at ?? stamp;
              return projected(++cursor, unread: unread, stamp: '$cachedStamp');
            }

            String messageIdFor(int at) => at == 1 ? 'reply' : 'reply-$at';
            RemoteChatMessage reply(int at) => RemoteChatMessage(
              messageId: messageIdFor(at),
              chatId: 'chat',
              scope: scope,
              role: ChatRole.assistant,
              status: ChatMessageStatus.complete,
              text: 'Answer $at',
              occurredAt: DateTime.fromMillisecondsSinceEpoch(at * 1000),
            );
            repo.snapshotBuilder = () {
              final state = snapshot(
                unread: cachedUnread,
                stamp: '$cachedStamp',
              );
              // Overview reads carry no transcript; the connect read does.
              return state.copyWith(
                chatMessages: connecting ? [reply(cachedStamp)] : const [],
                eventCursor: cursor,
              );
            };
            // A fresh projection of the desktop's state reaches the cache.
            void projectFresh() {
              expect(backgrounded, isFalse, reason: reason());
              fresh++;
              cachedUnread = desktopUnread;
              cachedStamp = stamp;
            }

            repo.requestChatTranscriptHandler = (requested) async {
              if (requested is! RemoteWorktreeChatTarget) return null;
              projectFresh();
              final id = 'fresh-$fresh';
              freshRequested[id] = time.elapsed;
              final state = snapshot(unread: desktopUnread, stamp: '$stamp');
              outbox.add(
                RemoteStateSnapshotEvent(
                  cursor: ++cursor,
                  commandId: id,
                  scope: 'chat',
                  chatSummaries: state.chatSummaries,
                  chatMessages: [reply(stamp)],
                  targetWorkspaceLocalId: 'ws',
                  targetWorktreeLocalId: 'wt',
                  targetChatId: 'chat',
                  targetChatScope: scope,
                ),
              );
              if (losses.nextInt(4) != 0) {
                outbox.add(RemoteCommandCompletedEvent(commandId: id));
              }
              return id;
            };
            repo.requestOverviewStateHandler = () async => projectFresh();
            // A read's answer can wait until the phone receives part of the
            // events the desktop emitted after it.
            Future<String> answer(String id) async {
              if (answers.nextInt(4) != 0) return id;
              log.add('$id answer held');
              final held = Completer<void>();
              heldAnswers.add(held);
              await held.future;
              return id;
            }

            repo.markReadHandler = (_, lastMessageId) async {
              expect(backgrounded, isFalse, reason: reason());
              if (failNext) {
                failNext = false;
                throw const RemoteControlException('offline');
              }
              submitted++;
              final id = 'read-${++commandSeq}';
              final declined = !desktopUnread || lastMessageId != latest;
              final completion = RemoteCommandCompletedEvent(
                commandId: id,
                result: declined
                    ? const {'ok': true, 'applied': false}
                    : const {'outcome': 'applied'},
              );
              final lost = random.nextInt(4) == 0;
              if (declined) {
                if (!lost) outbox.add(completion);
                return answer(id);
              }
              desktopUnread = false;
              otherReadLost = false;
              RemotePortalEvent summary() => project(unread: false);
              final summaryLost = random.nextInt(3) == 0;
              if (standalone) {
                // The standalone adapter emits its summary first.
                if (!summaryLost) outbox.add(summary());
                if (!lost) outbox.add(completion);
              } else {
                // The worktree summary is a throttled projection after the
                // completion. A projection read before the commit can still
                // deliver the old unread flag between them, also when the
                // read's own projection fails.
                if (!lost) outbox.add(completion);
                if (!summaryLost) {
                  if (random.nextBool()) {
                    outbox.add(project(unread: true));
                  }
                  outbox.add(summary());
                } else if (losses.nextBool()) {
                  outbox.add(project(unread: true));
                }
              }
              return answer(id);
            };
            final engine = buildRemoteEngine(repository: repo);

            void connect() {
              connecting = true;
              connects++;
              unawaited(engine.session.connect('123456'));
              time.flushMicrotasks();
              connecting = false;
            }

            void releaseAnswers() {
              for (final held in heldAnswers) {
                held.complete();
              }
              heldAnswers.clear();
              time.flushMicrotasks();
            }

            // Delivers the outbox, at times split into two batches. Held
            // answers follow the first batch.
            void deliver() {
              if (outbox.isEmpty) {
                releaseAnswers();
                return;
              }
              final pending = [...outbox];
              outbox.clear();
              final split = pending.length > 1 && losses.nextBool()
                  ? 1 + losses.nextInt(pending.length - 1)
                  : pending.length;
              for (final events in [
                pending.sublist(0, split),
                pending.sublist(split),
              ]) {
                if (events.isEmpty) continue;
                rejections += events
                    .whereType<RemoteCommandCompletedEvent>()
                    .where(
                      (event) =>
                          event.commandId!.startsWith('read-') &&
                          event.result?['applied'] == false,
                    )
                    .length;
                for (final event
                    in events.whereType<RemoteCommandCompletedEvent>()) {
                  if (freshRequested.containsKey(event.commandId)) {
                    freshSettled[event.commandId!] = time.elapsed;
                  }
                }
                emit(repo, time, events, ++cursor);
                releaseAnswers();
              }
            }

            void view() {
              final shown = engine.transcripts
                  .messagesFor(target)
                  .where((m) => m.role == ChatRole.assistant)
                  .lastOrNull;
              unawaited(
                engine.readReceipts.acknowledgeVisibleChat(
                  target,
                  shown?.messageId,
                ),
              );
              time.flushMicrotasks();
            }

            void checkReads() {
              expect(
                repo.snapshotFetches,
                lessThanOrEqualTo(connects + returns + rejections + fresh),
                reason: reason(),
              );
              expect(
                fresh,
                lessThanOrEqualTo(submitted + timedOutFresh()),
                reason: reason(),
              );
            }

            connect();
            for (var step = 0; step < 50; step++) {
              switch (random.nextInt(10)) {
                case 0 || 1:
                  log.add('view');
                  view();
                case 2:
                  log.add('deliver');
                  deliver();
                case 3:
                  log.add('new output');
                  stamp++;
                  latest = messageIdFor(stamp);
                  desktopUnread = true;
                  otherReadLost = false;
                  outbox.add(project(unread: true));
                  final row = RemoteChatMessageEvent(
                    chatId: 'chat',
                    scope: scope,
                    message: reply(stamp),
                  );
                  (random.nextBool() ? outbox : lateRows).add(row);
                case 4 when !desktopUnread:
                  log.add('desktop unread');
                  desktopUnread = true;
                  otherReadLost = false;
                  outbox.add(project(unread: true));
                case 5 when desktopUnread:
                  // Another client reads the chat; its summary can be lost.
                  desktopUnread = false;
                  otherReadLost = losses.nextInt(3) == 0;
                  submittedAtOtherRead = submitted;
                  freshAtOtherRead = fresh;
                  if (otherReadLost) {
                    log.add('desktop read, summary lost');
                  } else {
                    log.add('desktop read');
                    outbox.add(project(unread: false));
                  }
                case 6:
                  log.add('late rows');
                  outbox.addAll(lateRows);
                  lateRows.clear();
                case 7:
                  final seconds = 1 + random.nextInt(40);
                  log.add('elapse ${seconds}s');
                  time.elapse(Duration(seconds: seconds));
                  time.flushMicrotasks();
                case 8:
                  backgrounded = !backgrounded;
                  log.add(backgrounded ? 'background' : 'foreground');
                  if (backgrounded) {
                    engine.session.onAppBackgrounded();
                  } else {
                    returns++;
                    engine.session.onAppForegrounded();
                  }
                  time.flushMicrotasks();
                case 9 when random.nextInt(4) == 0:
                  log.add('reset');
                  unawaited(engine.session.disconnect());
                  time.flushMicrotasks();
                  expect(
                    engine.readReceipts.hasReceipts,
                    isFalse,
                    reason: reason(),
                  );
                  // The phone skips them; the server stored them already.
                  outbox.clear();
                  lateRows.clear();
                  if (backgrounded) {
                    backgrounded = false;
                    returns++;
                    engine.session.onAppForegrounded();
                  }
                  connect();
                case 9:
                  log.add('fail next');
                  failNext = true;
              }
              checkReads();
            }

            void settle() {
              for (var round = 0; round < 6; round++) {
                outbox.addAll(lateRows);
                lateRows.clear();
                deliver();
                time.elapse(const Duration(minutes: 1));
                time.flushMicrotasks();
              }
              deliver();
            }

            void expectQuiet(String phase) {
              log.add(phase);
              final reads = repo.snapshotFetches;
              final sends = repo.markReadCalls.length;
              final projections = fresh;
              time.elapse(const Duration(minutes: 5));
              time.flushMicrotasks();
              expect(repo.snapshotFetches, reads, reason: reason());
              expect(repo.markReadCalls, hasLength(sends), reason: reason());
              expect(fresh, projections, reason: reason());
            }

            failNext = false;
            if (backgrounded) {
              backgrounded = false;
              returns++;
              engine.session.onAppForegrounded();
            }
            settle();
            expectQuiet('settled');
            view();
            settle();
            expectQuiet('viewed');
            checkReads();
            final unobservable =
                otherReadLost &&
                submitted == submittedAtOtherRead &&
                fresh == freshAtOtherRead &&
                unread(engine) == cachedUnread;
            if (!unobservable) {
              expect(unread(engine), desktopUnread, reason: reason());
            }
            if (!desktopUnread) {
              desktopUnread = true;
              outbox.add(project(unread: true));
              settle();
              expect(unread(engine), isTrue, reason: reason());
              expectQuiet('desktop unread');
              expect(unread(engine), isTrue, reason: reason());
            }
            engine.dispose();
            repo.eventsController.close();
            time.flushMicrotasks();
          });
        }
      });
    }
  });
}
