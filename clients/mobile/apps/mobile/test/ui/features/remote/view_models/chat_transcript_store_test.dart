import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/chat_transcript_store.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

import '../../../../support/remote_store_sequences.dart';

void main() {
  const worktreeChat = RemoteWorktreeChatTarget(
    workspaceLocalId: 'ws-1',
    worktreeLocalId: 'wt-1',
    chatId: 'chat-1',
  );
  const standaloneChat = RemoteStandaloneChatTarget(chatId: 'chat-1');
  final worktreeKey = remoteChatKeyForTarget(worktreeChat)!;
  final standaloneKey = remoteChatKeyForTarget(standaloneChat)!;

  RemoteChatMessage row(
    String messageId, {
    String chatId = 'chat-1',
    ChatRole role = ChatRole.assistant,
    ChatMessageStatus status = ChatMessageStatus.complete,
    RemoteChatScope? scope = RemoteChatScope.worktree,
    String text = 'hello',
    DateTime? occurredAt,
    DateTime? updatedAt,
    List<ChatMessageAttachment> attachments = const [],
  }) => RemoteChatMessage(
    messageId: messageId,
    chatId: chatId,
    role: role,
    status: status,
    scope: scope,
    text: text,
    occurredAt: occurredAt,
    updatedAt: updatedAt,
    attachments: attachments,
  );

  ChatMessageAttachment attachment(String id) => ChatMessageAttachment(
    attachmentId: id,
    filename: '$id.png',
    mediaType: 'image/png',
  );

  final evidence = <String>[];
  final changed = <RemoteChatKey>[];
  late Completer<RemoteChatHistoryChunk> page;
  late List<String?> cursors;
  var connected = true;

  ChatTranscriptStore store() {
    evidence.clear();
    changed.clear();
    cursors = [];
    connected = true;
    return ChatTranscriptStore(
      notify: () {},
      isConnected: () => connected,
      fetchHistory: (target, {before}) {
        cursors.add(before);
        return (page = Completer()).future;
      },
      onEvidence: (_, message) => evidence.add(message.messageId),
      onTranscriptChanged: changed.add,
    );
  }

  List<String> ids(ChatTranscriptStore transcripts, RemoteChatTarget target) =>
      [for (final m in transcripts.messagesFor(target)) m.messageId];

  List<String> texts(
    ChatTranscriptStore transcripts,
    RemoteChatTarget target,
  ) => [for (final m in transcripts.messagesFor(target)) m.text];

  group('ordering', () {
    for (final overlaps in [false, true]) {
      test('a requested truncated snapshot keeps revised older history in '
          'place ${overlaps ? 'with' : 'without'} an overlap', () {
        final transcripts = store();
        DateTime at(int second) => DateTime.utc(2026, 10, 24, 12, 0, second);
        for (final (id, second) in [
          ('older', 1),
          ('middle', 2),
          if (overlaps) ('tail', 3),
        ]) {
          transcripts.ingest(worktreeKey, row(id, occurredAt: at(second)));
        }
        final baseline = transcripts.liveMark;
        transcripts.ingest(
          worktreeKey,
          row('older', text: 'Revised', occurredAt: at(1), updatedAt: at(4)),
        );
        transcripts.replaceAuthoritative(
          worktreeKey,
          [row('tail', occurredAt: at(3))],
          truncated: true,
          baseline: baseline,
        );
        expect(ids(transcripts, worktreeChat), ['older', 'middle', 'tail']);
        expect(transcripts.messagesFor(worktreeChat).first.text, 'Revised');
      });
    }

    test(
      'a requested snapshot can still report that a live turn completed',
      () {
        final transcripts = store();
        final mark = transcripts.liveMark;
        transcripts.ingest(
          worktreeKey,
          row(
            'timer',
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
          ),
        );
        transcripts.replaceAuthoritative(
          worktreeKey,
          [row('timer', role: ChatRole.system)],
          truncated: false,
          baseline: mark,
        );
        expect(
          transcripts.messagesFor(worktreeChat).single.isStreaming,
          isFalse,
        );
      },
    );

    for (final target in [worktreeChat, standaloneChat]) {
      test('${target.scope.name} snapshots preserve only post-request live '
          'rows and revisions', () {
        final transcripts = store();
        final key = remoteChatKeyForTarget(target)!;
        transcripts.ingest(key, row('obsolete'));
        transcripts.ingest(key, row('anchor', text: 'Before'));
        final mark = transcripts.liveMark;
        transcripts.ingest(key, row('anchor', text: 'After'));
        transcripts.ingest(key, row('new'));
        transcripts.replaceAuthoritative(
          key,
          [row('anchor', text: 'Before')],
          truncated: false,
          baseline: mark,
        );
        expect(ids(transcripts, target), ['anchor', 'new']);
        expect(transcripts.messagesFor(target).first.text, 'After');
        // A later read is authoritative, including removals and corrections.
        final later = transcripts.liveMark;
        transcripts.replaceAuthoritative(
          key,
          [row('anchor', text: 'Corrected')],
          truncated: false,
          baseline: later,
        );
        expect(ids(transcripts, target), ['anchor']);
        expect(transcripts.messagesFor(target).single.text, 'Corrected');
      });
    }

    test(
      'a cache seeded after the request does not count as live evidence',
      () {
        final transcripts = store();
        final mark = transcripts.liveMark;
        transcripts.seedFromCache(worktreeKey, [row('cached')]);
        transcripts.replaceAuthoritative(
          worktreeKey,
          [],
          truncated: false,
          baseline: mark,
        );
        expect(ids(transcripts, worktreeChat), isEmpty);
      },
    );

    for (final snapshotFirst in [false, true]) {
      test('live rows keep desktop ordering when the snapshot '
          '${snapshotFirst ? 'precedes' : 'follows'} the echo', () {
        final transcripts = store();
        final mark = transcripts.liveMark;
        final snapshot = [row('past'), row('user', role: ChatRole.user)];
        void echo() {
          transcripts.ingest(worktreeKey, row('user', role: ChatRole.user));
          transcripts.ingest(
            worktreeKey,
            row(
              'timer',
              role: ChatRole.system,
              status: ChatMessageStatus.streaming,
            ),
          );
          transcripts.ingest(
            worktreeKey,
            row('reply', status: ChatMessageStatus.streaming),
          );
        }

        if (snapshotFirst) {
          transcripts.replaceAuthoritative(
            worktreeKey,
            snapshot,
            truncated: false,
            baseline: mark,
          );
          echo();
        } else {
          echo();
          transcripts.replaceAuthoritative(
            worktreeKey,
            snapshot,
            truncated: false,
            baseline: mark,
          );
        }
        expect(ids(transcripts, worktreeChat), [
          'past',
          'user',
          'timer',
          'reply',
        ]);
      });
    }

    test('late prompts use original positions after timer revisions', () {
      final transcripts = store();
      void emit(String id, String role, int time) => transcripts.ingest(
        worktreeKey,
        RemoteChatMessage.fromWireJson({
          'messageId': id,
          'chatId': 'chat-1',
          'role': role,
          'status': 'complete',
          'createdAtMs': time,
          'updatedAtMs': time,
        }),
      );

      emit('user-1', 'user', 1000);
      emit('timer-1', 'system', 1500);
      emit('answer-1', 'assistant', 2000);
      // Timer revisions carry emission time as createdAtMs. A queued prompt
      // accepted earlier must not be inserted inside this completed turn.
      emit('timer-1', 'system', 4000);
      emit('user-2', 'user', 3000);
      expect(ids(transcripts, worktreeChat), [
        'user-1',
        'timer-1',
        'answer-1',
        'user-2',
      ]);
    });

    test('chat events upsert transcript messages by id', () {
      final harness = RemoteStoresHarness();
      harness.apply(
        RemoteChatMessageEvent(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          message: row(
            'msg-1',
            scope: null,
            status: ChatMessageStatus.streaming,
            text: 'partial',
          ),
        ),
      );
      expect(
        harness.transcripts.messagesFor(worktreeChat).single.text,
        'partial',
      );

      harness.apply(
        RemoteChatMessageEvent(
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          message: row('msg-1', scope: null, text: 'complete answer'),
        ),
      );
      final messages = harness.transcripts.messagesFor(worktreeChat);
      expect(messages, hasLength(1));
      expect(messages.single.text, 'complete answer');
      expect(messages.single.isStreaming, isFalse);
    });

    test('same chat id remains isolated across chat scopes', () {
      final harness = RemoteStoresHarness();
      const worktreeTarget = RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        chatId: 'shared-id',
      );
      const standaloneTarget = RemoteStandaloneChatTarget(chatId: 'shared-id');
      for (final (scope, text) in [
        (RemoteChatScope.worktree, 'worktree message'),
        (RemoteChatScope.standalone, 'standalone message'),
      ]) {
        harness.apply(
          RemoteChatMessageEvent(
            chatId: 'shared-id',
            scope: scope,
            message: row(
              'same-message-id',
              chatId: 'shared-id',
              scope: null,
              text: text,
            ),
          ),
        );
      }

      expect(
        harness.transcripts.messagesFor(worktreeTarget).single.text,
        'worktree message',
      );
      expect(
        harness.transcripts.messagesFor(standaloneTarget).single.text,
        'standalone message',
      );
    });

    test('state snapshots replace transcripts in authoritative order', () {
      final harness = RemoteStoresHarness();
      harness.apply(liveRow(wireRow('stale-message')));
      harness.apply(
        chatSnapshot([wireRow('authoritative-2'), wireRow('authoritative-1')]),
      );
      expect(harness.rowIds(sequenceChat), [
        'authoritative-2',
        'authoritative-1',
      ]);
    });

    test('a truncated tail without an overlap splits the cache by time', () {
      final transcripts = store();
      DateTime at(int seconds) => DateTime.utc(2026, 9, 30, 12, 0, seconds);
      for (final (id, seconds) in [
        ('history', 1),
        ('undated', null),
        ('live', 30),
      ]) {
        transcripts.ingest(
          worktreeKey,
          row(id, occurredAt: seconds == null ? null : at(seconds)),
        );
      }
      transcripts.replaceAuthoritative(worktreeKey, [
        row('tail', occurredAt: at(10)),
      ], truncated: true);
      // Undated rows stay in the prefix; rows after the tail follow it.
      expect(ids(transcripts, worktreeChat), [
        'history',
        'undated',
        'tail',
        'live',
      ]);
    });
  });

  group('revisions', () {
    for (final delivery in ['live', 'snapshot', 'truncated', 'refresh']) {
      for (final status in [
        ChatMessageStatus.complete,
        ChatMessageStatus.failed,
        ChatMessageStatus.cancelled,
      ]) {
        test('$delivery cannot regress a newer $status message', () {
          final harness = RemoteStoresHarness();
          RemoteChatMessage revision(int updated, ChatMessageStatus state) =>
              RemoteChatMessage.fromWireJson({
                'messageId': 'answer',
                'chatId': 'chat-1',
                'scope': 'worktree',
                'role': 'assistant',
                'status': state.wire,
                'text': state == ChatMessageStatus.streaming
                    ? 'Partial'
                    : 'Final',
                'createdAtMs': 1000,
                'updatedAtMs': updated,
              });
          harness.apply(liveRow(revision(3000, status)));
          for (final updated in [2000, 3000]) {
            final stale = revision(updated, ChatMessageStatus.streaming);
            switch (delivery) {
              case 'refresh':
                harness.applySnapshot(
                  RemoteSessionSnapshot(
                    workspaces: const [],
                    worktrees: const [],
                    standaloneChats: const [],
                    chatMessages: [
                      RemoteChatMessage.fromViewJson({
                        'localMessageId': stale.messageId,
                        'localChatId': stale.chatId,
                        'scope': 'worktree',
                        'role': 'assistant',
                        'status': 'streaming',
                        'content': 'Partial',
                        'occurredAt': DateTime.fromMillisecondsSinceEpoch(
                          updated,
                        ).toIso8601String(),
                      }),
                    ],
                  ),
                );
              case 'live':
                harness.apply(liveRow(stale));
              default:
                harness.apply(
                  chatSnapshot([stale], truncated: delivery == 'truncated'),
                );
            }
            final result = harness.transcripts.messagesFor(worktreeChat).single;
            expect(result.status, status);
            expect(result.text, 'Final');
          }
        });
      }
    }

    for (final truncated in [false, true]) {
      test(
        'persisted ${truncated ? 'tail' : 'full'} history corrects a missed live patch',
        () {
          final harness = RemoteStoresHarness();
          harness.apply(
            liveRow(
              wireRow(
                'answer',
                status: 'streaming',
                text: 'first patch',
                createdAtMs: 1000,
                updatedAtMs: 3000,
              ),
            ),
          );
          // The next live patch was missed. Persisted history retains the
          // original creation time but contains the latest text and parts.
          harness.apply(
            chatSnapshot([
              RemoteChatMessage.fromWireJson({
                'messageId': 'answer',
                'chatId': 'chat-1',
                'scope': 'worktree',
                'role': 'assistant',
                'status': 'complete',
                'text': 'final persisted answer',
                'createdAtMs': 1000,
                'parts': [
                  {'kind': 'text', 'text': 'final persisted answer'},
                ],
              }),
            ], truncated: truncated),
          );

          final answer = harness.transcripts.messagesFor(worktreeChat).single;
          expect(answer.text, 'final persisted answer');
          expect(answer.status, ChatMessageStatus.complete);
          expect(answer.parts, hasLength(1));
        },
      );
    }

    test('refresh accepts completed history without a revision time', () {
      final harness = RemoteStoresHarness();
      harness.apply(
        liveRow(
          wireRow(
            'answer',
            status: 'streaming',
            text: 'partial answer',
            createdAtMs: 1000,
            updatedAtMs: 3000,
          ),
        ),
      );
      harness.applySnapshot(
        RemoteSessionSnapshot(
          workspaces: const [],
          worktrees: const [],
          standaloneChats: const [],
          chatMessages: [
            RemoteChatMessage.fromViewJson({
              'localMessageId': 'answer',
              'localChatId': 'chat-1',
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'content': 'completed answer',
              'occurredAt': DateTime.fromMillisecondsSinceEpoch(
                1000,
              ).toIso8601String(),
              'parts': [
                {
                  'kind': 'text',
                  'data': {'text': 'completed answer'},
                },
              ],
            }),
          ],
        ),
      );

      final answer = harness.transcripts.messagesFor(worktreeChat).single;
      expect(answer.text, 'completed answer');
      expect(answer.status, ChatMessageStatus.complete);
      expect(answer.parts.single.data?['text'], 'completed answer');
    });

    test('replayed live patch cannot reopen persisted completion', () {
      final harness = RemoteStoresHarness();
      final patch = wireRow(
        'answer',
        status: 'streaming',
        text: 'partial answer',
        createdAtMs: 1000,
        updatedAtMs: 3000,
      );
      harness.apply(liveRow(patch));
      harness.apply(
        chatSnapshot([
          wireRow('answer', text: 'completed answer', createdAtMs: 1000),
        ]),
      );
      harness.apply(liveRow(patch));

      final answer = harness.transcripts.messagesFor(worktreeChat).single;
      expect(answer.text, 'completed answer');
      expect(answer.status, ChatMessageStatus.complete);
      expect(answer.updatedAt, DateTime.fromMillisecondsSinceEpoch(3000));
    });
  });

  group('CAN-3369 server-cached chat tail', () {
    test('a live completion timer does not block the first server tail', () {
      final transcripts = store();
      const timer = RemoteChatMessage(
        messageId: 'timer',
        chatId: 'chat-1',
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
      );
      transcripts.ingest(worktreeKey, timer);
      final mark = transcripts.liveMark;
      expect(
        transcripts.seedFromCache(worktreeKey, [
          row('prompt', role: ChatRole.user, text: 'Review the changes'),
          row('answer', text: 'Review finished'),
          // The cached timer may still be running. Live completion wins.
          const RemoteChatMessage(
            messageId: 'timer',
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            role: ChatRole.system,
            status: ChatMessageStatus.streaming,
            text: '',
            parts: [
              ChatPart(kind: 'turn_timer', data: {'startedAt': 1000}),
            ],
          ),
        ]),
        isTrue,
      );
      expect(ids(transcripts, worktreeChat), ['prompt', 'answer', 'timer']);
      expect(transcripts.messagesFor(worktreeChat).last, same(timer));
      expect(transcripts.isStreamingForChat(worktreeChat), isFalse);
      expect(transcripts.hasAuthoritativeRows(worktreeKey), isFalse);
      expect(transcripts.liveMark, mark);
      // Cache rows remain provisional, while the live completion survives.
      transcripts.replaceAuthoritative(
        worktreeKey,
        [row('answer', text: 'Corrected answer')],
        truncated: false,
        baseline: mark - 1,
      );
      expect(ids(transcripts, worktreeChat), ['answer', 'timer']);
      expect(texts(transcripts, worktreeChat), ['Corrected answer', '']);
    });

    test('the authoritative snapshot replaces the cached tail in order', () {
      final transcripts = store();
      transcripts.seedFromCache(standaloneKey, [
        row('gone-before', text: 'Deleted before the first overlap'),
        row('c1', text: 'First'),
        row('gone', text: 'Deleted on the desktop'),
        row('c2', text: 'Second (cached)'),
      ]);
      expect(texts(transcripts, standaloneChat), [
        'Deleted before the first overlap',
        'First',
        'Deleted on the desktop',
        'Second (cached)',
      ]);

      // A live row that lands after the cache read is newer than both and
      // must survive the snapshot that was assembled before it.
      transcripts.ingest(standaloneKey, row('live', text: 'Live answer'));
      transcripts.replaceAuthoritative(standaloneKey, [
        row('c0', text: 'Older'),
        row('c1', text: 'First'),
        row('c2', text: 'Second'),
      ], truncated: true);
      expect(texts(transcripts, standaloneChat), [
        'Older',
        'First',
        'Second',
        'Live answer',
      ]);
    });

    test('a generic snapshot keeps cache provenance until the chat tail '
        'arrives', () {
      final transcripts = store();
      transcripts.seedFromCache(standaloneKey, [
        row('deleted', text: 'Deleted on the desktop'),
        row('overlap', text: 'Kept'),
      ]);
      transcripts.applyUpdate(
        IncomingChatRowsUpdate(
          rows: [
            row(
              'deleted',
              scope: RemoteChatScope.standalone,
              text: 'Stale overview copy',
            ),
          ],
          keySnapshot: null,
          preserveCacheProvenance: true,
        ),
        resolveChat: (_, chatId, scope) => (scope: scope!, chatId: chatId),
      );
      expect(texts(transcripts, standaloneChat), [
        'Stale overview copy',
        'Kept',
      ]);

      transcripts.replaceAuthoritative(standaloneKey, [
        row('overlap', text: 'Kept'),
      ], truncated: true);
      expect(texts(transcripts, standaloneChat), ['Kept']);
    });

    test(
      'a truncated tail without an overlap drops every cache-seeded row',
      () {
        // CAN-3373: a persisted tail can be far older than the desktop's
        // bounded window. Keeping it in front of a disjoint tail would show a
        // gap; older history comes back through pagination instead.
        final transcripts = store();
        DateTime at(int seconds) => DateTime.utc(2026, 10, 4, 12, 0, seconds);
        transcripts.seedFromCache(worktreeKey, [
          row('stale-1', occurredAt: at(1)),
          row('stale-undated'),
          row('stale-2', occurredAt: at(2)),
        ]);
        transcripts.replaceAuthoritative(worktreeKey, [
          row('tail-1', occurredAt: at(50)),
          row('tail-2', occurredAt: at(51)),
        ], truncated: true);
        expect(ids(transcripts, worktreeChat), ['tail-1', 'tail-2']);
      },
    );

    group('CAN-3373 cached tail sources', () {
      const device = RemoteCachedTailSource.device;
      const server = RemoteCachedTailSource.server;

      test('the server tail replaces a tail persisted on this device', () {
        final transcripts = store();
        expect(
          transcripts.seedFromCache(worktreeKey, [
            row('d1', text: 'Device only'),
            row('shared', text: 'Device copy'),
          ], source: device),
          isTrue,
        );
        expect(transcripts.acceptsCachedTail(worktreeKey, server), isTrue);
        expect(
          transcripts.seedFromCache(worktreeKey, [
            row('shared', text: 'Server copy'),
            row('s2', text: 'Newer on the server'),
          ]),
          isTrue,
        );
        expect(texts(transcripts, worktreeChat), [
          'Server copy',
          'Newer on the server',
        ]);

        // The snapshot still drops cached rows it no longer carries.
        transcripts.replaceAuthoritative(worktreeKey, [
          row('s2', text: 'Authoritative'),
        ], truncated: false);
        expect(texts(transcripts, worktreeChat), ['Authoritative']);
      });

      test('a staler or equal cache never replaces a fresher one', () {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [row('s1', text: 'Server')]);
        expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
        expect(transcripts.acceptsCachedTail(worktreeKey, server), isFalse);
        expect(
          transcripts.seedFromCache(worktreeKey, [
            row('d1', text: 'Device'),
          ], source: device),
          isFalse,
        );
        expect(
          transcripts.seedFromCache(worktreeKey, [row('s9', text: 'Again')]),
          isFalse,
        );
        expect(texts(transcripts, worktreeChat), ['Server']);
      });

      test('live rows, the snapshot, and optimistic sends are never '
          'overwritten by a cache', () {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [
          row('d1', text: 'Device'),
        ], source: device);
        transcripts.ingest(worktreeKey, row('live', text: 'Live'));
        expect(transcripts.acceptsCachedTail(worktreeKey, server), isFalse);
        expect(
          transcripts.seedFromCache(worktreeKey, [row('s1', text: 'Server')]),
          isFalse,
        );
        expect(texts(transcripts, worktreeChat), ['Device', 'Live']);

        transcripts.replaceAuthoritative(worktreeKey, [
          row('a1', text: 'Authoritative'),
        ], truncated: false);
        expect(transcripts.acceptsCachedTail(worktreeKey, server), isFalse);
        expect(texts(transcripts, worktreeChat), ['Authoritative']);

        final other = store();
        other.addPendingSend(
          worktreeKey,
          row('p', role: ChatRole.user, text: 'Sending'),
        );
        expect(other.acceptsCachedTail(worktreeKey, server), isFalse);
        expect(other.seedFromCache(worktreeKey, [row('s1')]), isFalse);
        // A device tail seeds under the optimistic send, which keeps its id.
        expect(
          other.seedFromCache(worktreeKey, [
            row('p', text: 'Stale copy'),
            row('d1', text: 'Device'),
          ], source: device),
          isTrue,
        );
        expect(texts(other, worktreeChat), ['Device', 'Sending']);
      });

      test('a device tail seeds under live rows that arrived first', () {
        // CAN-3373 R7: a chat still streaming on the desktop gets live rows
        // before it is opened. Its persisted tail still paints underneath;
        // the live rows win every id they share with it.
        final transcripts = store();
        DateTime at(int seconds) => DateTime.utc(2026, 10, 4, 12, 0, seconds);
        transcripts.ingest(
          worktreeKey,
          row('shared', text: 'Live copy', occurredAt: at(2)),
        );
        transcripts.ingest(
          worktreeKey,
          row('live', text: 'Streaming', occurredAt: at(60)),
        );
        expect(transcripts.acceptsCachedTail(worktreeKey, device), isTrue);
        expect(
          transcripts.seedFromCache(worktreeKey, [
            row('d1', text: 'Device 1', occurredAt: at(1)),
            row('shared', text: 'Device copy', occurredAt: at(2)),
            row('d3', text: 'Device 3'),
            row('d4', text: 'Device 4', occurredAt: at(4)),
          ], source: device),
          isTrue,
        );
        expect(texts(transcripts, worktreeChat), [
          'Device 1',
          'Live copy',
          'Device 3',
          'Device 4',
          'Streaming',
        ]);
        // Still provisional: no second device seed, and the server tail
        // never overwrites the live rows.
        expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
        expect(transcripts.acceptsCachedTail(worktreeKey, server), isFalse);
        // History paging still starts from the newest server page.
        expect(transcripts.canLoadOlderMessages(worktreeChat), isTrue);
        unawaited(transcripts.loadOlderMessages(worktreeChat));
        expect(cursors, [null]);

        // The snapshot drops the device rows it does not carry.
        expect(transcripts.hasAuthoritativeRows(worktreeKey), isFalse);
        transcripts.replaceAuthoritative(worktreeKey, [
          row('shared', text: 'Authoritative', occurredAt: at(2)),
          row('live', text: 'Done', occurredAt: at(60)),
        ], truncated: true);
        expect(texts(transcripts, worktreeChat), ['Authoritative', 'Done']);
        expect(transcripts.hasAuthoritativeRows(worktreeKey), isTrue);
        expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
      });

      group('CAN-3373 R13: a device tail keeps its stored order', () {
        // Timer revisions move a row's creation time, so the desktop's
        // order is not timestamp order and the stored order is authoritative
        // for the tail.
        DateTime at(int seconds) => DateTime.utc(2026, 10, 4, 12, 0, seconds);
        List<RemoteChatMessage> tail() => [
          row('user', role: ChatRole.user, occurredAt: at(1)),
          row('timer', text: 'Timer', occurredAt: at(4)),
          row('answer', text: 'Answer', occurredAt: at(2)),
        ];

        test('in an empty transcript', () {
          final transcripts = store();
          expect(
            transcripts.seedFromCache(worktreeKey, [
              ...tail(),
              row('timer', text: 'Timer, later', occurredAt: at(9)),
            ], source: device),
            isTrue,
          );
          expect(ids(transcripts, worktreeChat), ['user', 'timer', 'answer']);
          // A duplicate id keeps the first place and the newer revision.
          expect(texts(transcripts, worktreeChat)[1], 'Timer, later');
          expect(transcripts.messagesFor(worktreeChat)[1].positionAt, at(4));
          expect(evidence, containsAll(['user', 'timer', 'answer']));
          expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
          expect(transcripts.acceptsCachedTail(worktreeKey, server), isTrue);

          // A new live row lands by position; the seeded rows stay put.
          transcripts.ingest(worktreeKey, row('next', occurredAt: at(3)));
          expect(ids(transcripts, worktreeChat), [
            'user',
            'next',
            'timer',
            'answer',
          ]);

          // Still provisional: a full snapshot drops the rows it omits.
          transcripts.replaceAuthoritative(worktreeKey, [
            row('user', role: ChatRole.user, occurredAt: at(1)),
            row('answer', text: 'Answer', occurredAt: at(2)),
          ], truncated: false);
          expect(ids(transcripts, worktreeChat), ['user', 'answer']);
        });

        test('under live rows that arrived first', () {
          final transcripts = store();
          transcripts.ingest(
            worktreeKey,
            row('answer', text: 'Live answer', occurredAt: at(2)),
          );
          transcripts.ingest(worktreeKey, row('live', occurredAt: at(60)));
          expect(
            transcripts.seedFromCache(worktreeKey, [
              ...tail(),
              row('after', occurredAt: at(3)),
            ], source: device),
            isTrue,
          );
          expect(ids(transcripts, worktreeChat), [
            'user',
            'timer',
            'answer',
            'after',
            'live',
          ]);
          expect(texts(transcripts, worktreeChat)[2], 'Live answer');
        });

        // CAN-3373 R14: the server orders its tail by creation time and
        // sends no ordering anchor, so the rows it shares with the device
        // tail keep the device's places and anchors.
        List<RemoteChatMessage> serverTail() => [
          row(
            'user',
            role: ChatRole.user,
            text: 'Server user',
            occurredAt: at(1),
          ),
          row('answer', text: 'Server answer', occurredAt: at(2)),
          row('timer', text: 'Server timer', occurredAt: at(5)),
        ];

        test('under a server tail with the same rows', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, tail(), source: device);
          expect(transcripts.seedFromCache(worktreeKey, serverTail()), isTrue);
          expect(ids(transcripts, worktreeChat), ['user', 'timer', 'answer']);
          expect(texts(transcripts, worktreeChat), [
            'Server user',
            'Server timer',
            'Server answer',
          ]);
          expect(
            [
              for (final m in transcripts.messagesFor(worktreeChat))
                m.positionAt,
            ],
            [at(1), at(4), at(2)],
          );
          expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
          expect(transcripts.acceptsCachedTail(worktreeKey, server), isFalse);

          // Still provisional: a full snapshot drops the rows it omits.
          expect(transcripts.hasAuthoritativeRows(worktreeKey), isFalse);
          transcripts.replaceAuthoritative(worktreeKey, [
            row('user', role: ChatRole.user, occurredAt: at(1)),
            row('timer', text: 'Timer', occurredAt: at(5)),
          ], truncated: false);
          expect(ids(transcripts, worktreeChat), ['user', 'timer']);
        });

        test('under a server tail with a row the device lacks', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, tail(), source: device);
          expect(
            transcripts.seedFromCache(worktreeKey, [
              ...serverTail(),
              row('extra', text: 'Server only', occurredAt: at(9)),
            ]),
            isTrue,
          );
          expect(ids(transcripts, worktreeChat), [
            'user',
            'timer',
            'answer',
            'extra',
          ]);
          expect(evidence, containsAll(['user', 'timer', 'answer', 'extra']));
        });

        test('under a server tail without a device row', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, [
            ...tail(),
            row('gone', text: 'Device only', occurredAt: at(3)),
          ], source: device);
          expect(transcripts.seedFromCache(worktreeKey, serverTail()), isTrue);
          // The fresher cache drops the staler one's rows it omits.
          expect(ids(transcripts, worktreeChat), ['user', 'timer', 'answer']);
        });
      });

      test('a server history page makes a chat authoritative', () async {
        final transcripts = store();
        transcripts.ingest(worktreeKey, row('live'));
        final older = transcripts.loadOlderMessages(worktreeChat);
        page.complete(
          RemoteChatHistoryChunk(messages: [row('h1'), row('live')]),
        );
        await older;
        expect(transcripts.hasAuthoritativeRows(worktreeKey), isTrue);
        expect(transcripts.acceptsCachedTail(worktreeKey, device), isFalse);
        transcripts.reset();
        expect(transcripts.hasAuthoritativeRows(worktreeKey), isFalse);
      });

      test('an empty cache is never an empty chat', () {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [
          row('d1', text: 'Device'),
        ], source: device);
        expect(transcripts.seedFromCache(worktreeKey, const []), isFalse);
        expect(texts(transcripts, worktreeChat), ['Device']);
        expect(transcripts.seedFromCache(standaloneKey, const []), isFalse);
        expect(transcripts.hasTranscript(standaloneKey), isFalse);
      });

      test('a device tail keeps history paging on server cursors', () async {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [
          row('d2', text: 'Device newer'),
        ], source: device);
        expect(transcripts.canLoadOlderMessages(worktreeChat), isTrue);
        final older = transcripts.loadOlderMessages(worktreeChat);
        page.complete(
          RemoteChatHistoryChunk(
            messages: [row('d1'), row('d2')],
            nextCursor: 'cursor-1',
          ),
        );
        await older;
        expect(cursors, [null]);
        expect(ids(transcripts, worktreeChat), ['d1', 'd2']);
        final next = transcripts.loadOlderMessages(worktreeChat);
        page.complete(const RemoteChatHistoryChunk(messages: []));
        await next;
        expect(cursors, [null, 'cursor-1']);
      });

      // Message ids m<from>..m<to - 1>, so a gap is easy to read in a failure.
      List<RemoteChatMessage> span(int from, int to) => [
        for (var i = from; i < to; i++) row('m$i'),
      ];
      List<String> spanIds(int from, int to) => [
        for (var i = from; i < to; i++) 'm$i',
      ];

      for (final source in RemoteCachedTailSource.values) {
        test('a history page confirms ${source.name}-cached rows, so a '
            'truncated snapshot overlapping them leaves no gap', () async {
          final transcripts = store();
          transcripts.seedFromCache(
            worktreeKey,
            span(250, 300),
            source: source,
          );
          final older = transcripts.loadOlderMessages(worktreeChat);
          page.complete(
            RemoteChatHistoryChunk(messages: span(240, 285), nextCursor: 'p1'),
          );
          await older;
          expect(ids(transcripts, worktreeChat), spanIds(240, 300));

          transcripts.replaceAuthoritative(
            worktreeKey,
            span(280, 302),
            truncated: true,
          );
          expect(ids(transcripts, worktreeChat), spanIds(240, 302));

          // Paging continues before the oldest row shown.
          final next = transcripts.loadOlderMessages(worktreeChat);
          page.complete(RemoteChatHistoryChunk(messages: span(190, 240)));
          await next;
          expect(cursors, [null, 'p1']);
          expect(ids(transcripts, worktreeChat), spanIds(190, 302));
        });
      }

      test('a history page refreshes the cached rows it confirms', () async {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [
          row('d1', text: 'Device copy', status: ChatMessageStatus.streaming),
          row('d2', text: 'Device only'),
        ], source: device);
        final older = transcripts.loadOlderMessages(worktreeChat);
        page.complete(
          RemoteChatHistoryChunk(
            messages: [
              row('d0', text: 'Older'),
              row('d1', text: 'Server copy'),
            ],
            nextCursor: 'p1',
          ),
        );
        await older;
        expect(texts(transcripts, worktreeChat), [
          'Older',
          'Server copy',
          'Device only',
        ]);
      });

      group('CAN-3373 PF1: server copies replace device revisions', () {
        // Server rows carry only their creation time, which a persisted
        // device revision's update time can pass, so timestamps cannot say
        // which copy is fresher. The server's copy is.
        DateTime at(int seconds) => DateTime.utc(2026, 10, 4, 12, 0, seconds);
        List<RemoteChatMessage> deviceTail() => [
          row('d1', text: 'Device 1', occurredAt: at(1)),
          row(
            'answer',
            text: 'Partial',
            status: ChatMessageStatus.streaming,
            occurredAt: at(2),
            updatedAt: at(50),
          ),
          row('d3', text: 'Device 3', occurredAt: at(3)),
        ];
        final serverAnswer = row(
          'answer',
          text: 'Complete answer',
          occurredAt: at(2),
        );

        test('in the server tail, keeping the device order', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, deviceTail(), source: device);
          expect(
            transcripts.seedFromCache(worktreeKey, [
              row('d1', text: 'Server 1', occurredAt: at(1)),
              row('d3', text: 'Server 3', occurredAt: at(3)),
              serverAnswer,
            ]),
            isTrue,
          );
          expect(texts(transcripts, worktreeChat), [
            'Server 1',
            'Complete answer',
            'Server 3',
          ]);
          final answer = transcripts.messagesFor(worktreeChat)[1];
          expect(answer.status, ChatMessageStatus.complete);
          expect(answer.positionAt, at(2));
        });

        test('in a history page', () async {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, deviceTail(), source: device);
          final older = transcripts.loadOlderMessages(worktreeChat);
          page.complete(
            RemoteChatHistoryChunk(
              messages: [
                row('d0', text: 'Older', occurredAt: at(0)),
                row('d1', text: 'Server 1', occurredAt: at(1)),
                serverAnswer,
              ],
              nextCursor: 'p1',
            ),
          );
          await older;
          expect(texts(transcripts, worktreeChat), [
            'Older',
            'Server 1',
            'Complete answer',
            'Device 3',
          ]);
          expect(
            transcripts.messagesFor(worktreeChat)[2].status,
            ChatMessageStatus.complete,
          );
        });

        test('but never a live revision of the row', () async {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, deviceTail(), source: device);
          transcripts.ingest(
            worktreeKey,
            row(
              'answer',
              text: 'Live answer',
              occurredAt: at(2),
              updatedAt: at(60),
            ),
          );
          expect(
            transcripts.seedFromCache(worktreeKey, [serverAnswer]),
            isFalse,
          );
          final older = transcripts.loadOlderMessages(worktreeChat);
          page.complete(RemoteChatHistoryChunk(messages: [serverAnswer]));
          await older;
          expect(texts(transcripts, worktreeChat), [
            'Device 1',
            'Live answer',
            'Device 3',
          ]);
        });

        test('nor a desktop revision a generic snapshot delivered', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, deviceTail(), source: device);
          transcripts.ingest(
            worktreeKey,
            row(
              'answer',
              text: 'Desktop answer',
              occurredAt: at(2),
              updatedAt: at(60),
            ),
            preserveCacheProvenance: true,
          );
          expect(
            transcripts.seedFromCache(worktreeKey, [serverAnswer]),
            isTrue,
          );
          expect(texts(transcripts, worktreeChat), ['Desktop answer']);
        });

        test('nor a terminal device row with a streaming copy', () {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, [
            row('answer', text: 'Done', occurredAt: at(2)),
          ], source: device);
          transcripts.seedFromCache(worktreeKey, [
            row(
              'answer',
              text: 'Partial',
              status: ChatMessageStatus.streaming,
              occurredAt: at(2),
            ),
          ]);
          expect(texts(transcripts, worktreeChat), ['Done']);
        });

        group('keeping the device revision time', () {
          // The server's copy carries no update time, so a live revision
          // older than the device one must still not replace it.
          final serverPartial = row(
            'answer',
            text: 'Server partial',
            status: ChatMessageStatus.streaming,
            occurredAt: at(2),
          );
          RemoteChatMessage live(int seconds) => row(
            'answer',
            text: 'Live $seconds',
            status: ChatMessageStatus.streaming,
            occurredAt: at(2),
            updatedAt: at(seconds),
          );

          ChatTranscriptStore viaServerTail() {
            final transcripts = store();
            transcripts.seedFromCache(
              worktreeKey,
              deviceTail(),
              source: device,
            );
            transcripts.seedFromCache(worktreeKey, [serverPartial]);
            return transcripts;
          }

          Future<ChatTranscriptStore> viaHistoryPage() async {
            final transcripts = store();
            transcripts.seedFromCache(
              worktreeKey,
              deviceTail(),
              source: device,
            );
            final older = transcripts.loadOlderMessages(worktreeChat);
            page.complete(RemoteChatHistoryChunk(messages: [serverPartial]));
            await older;
            return transcripts;
          }

          String answerText(ChatTranscriptStore transcripts) => transcripts
              .messagesFor(worktreeChat)
              .singleWhere((message) => message.messageId == 'answer')
              .text;

          test('in the server tail, an older live revision loses', () {
            final transcripts = viaServerTail();
            transcripts.ingest(worktreeKey, live(40));
            expect(answerText(transcripts), 'Server partial');
          });

          test('in the server tail, a newer live revision wins', () {
            final transcripts = viaServerTail();
            transcripts.ingest(worktreeKey, live(60));
            expect(answerText(transcripts), 'Live 60');
          });

          test('in a history page, an older live revision loses', () async {
            final transcripts = await viaHistoryPage();
            expect(answerText(transcripts), 'Server partial');
            transcripts.ingest(worktreeKey, live(40));
            expect(answerText(transcripts), 'Server partial');
          });

          test('in a history page, a newer live revision wins', () async {
            final transcripts = await viaHistoryPage();
            transcripts.ingest(worktreeKey, live(60));
            expect(answerText(transcripts), 'Live 60');
          });
        });
      });

      group('CAN-3373 PF4: a history page reconciles the cached tail', () {
        // A cached tail can be far behind the server. A history page proves
        // what the server holds over its range, so cached rows it does not
        // carry never stay after its rows as if they were newer.
        Future<void> loadPage(
          ChatTranscriptStore transcripts,
          List<RemoteChatMessage> messages, {
          String? nextCursor,
        }) async {
          final older = transcripts.loadOlderMessages(worktreeChat);
          page.complete(
            RemoteChatHistoryChunk(messages: messages, nextCursor: nextCursor),
          );
          await older;
        }

        // How the tail came to show: persisted on this device, read from the
        // server's cache, or both, the server's copy taking over the device
        // rows it shares (R15).
        final seeds =
            <
              String,
              void Function(ChatTranscriptStore, List<RemoteChatMessage>)
            >{
              'device': (transcripts, rows) =>
                  transcripts.seedFromCache(worktreeKey, rows, source: device),
              'server': (transcripts, rows) =>
                  transcripts.seedFromCache(worktreeKey, rows),
              'device then server': (transcripts, rows) {
                transcripts.seedFromCache(worktreeKey, rows, source: device);
                expect(
                  transcripts.seedFromCache(worktreeKey, [...rows]),
                  isTrue,
                );
              },
            };

        for (final MapEntry(key: via, value: seed) in seeds.entries) {
          group('($via tail)', () {
            test('a newest page sharing no row replaces the stale tail, and '
                'paging continues before it', () async {
              final transcripts = store();
              seed(transcripts, span(0, 50));
              await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
              expect(ids(transcripts, worktreeChat), spanIds(100, 150));
              expect(transcripts.hasAuthoritativeRows(worktreeKey), isTrue);

              await loadPage(transcripts, span(50, 100), nextCursor: 'p2');
              await loadPage(transcripts, span(0, 50));
              expect(cursors, [null, 'p1', 'p2']);
              expect(ids(transcripts, worktreeChat), spanIds(0, 150));
            });

            test('an overlapping newest page keeps the rows before it and the '
                'newer ones after it', () async {
              final transcripts = store();
              seed(transcripts, span(90, 152));
              await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
              expect(ids(transcripts, worktreeChat), spanIds(90, 152));
            });

            test('rows a page omits between its own rows drop', () async {
              final transcripts = store();
              seed(transcripts, [row('m100'), row('deleted'), row('m101')]);
              await loadPage(transcripts, span(99, 102), nextCursor: 'p1');
              expect(ids(transcripts, worktreeChat), spanIds(99, 102));
            });

            test(
              'live rows and optimistic sends after the tail stay',
              () async {
                final transcripts = store();
                seed(transcripts, span(0, 50));
                transcripts.ingest(worktreeKey, row('live'));
                transcripts.addPendingSend(
                  worktreeKey,
                  row('send', role: ChatRole.user, text: 'Sending'),
                );
                await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
                expect(ids(transcripts, worktreeChat), [
                  ...spanIds(100, 150),
                  'live',
                  'send',
                ]);
              },
            );

            test('an older page drops the stale rows the newest page left '
                'before it', () async {
              final transcripts = store();
              seed(transcripts, [...span(1, 50), row('m100')]);
              await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
              expect(ids(transcripts, worktreeChat), [
                ...spanIds(1, 50),
                ...spanIds(100, 150),
              ]);

              await loadPage(transcripts, span(50, 100), nextCursor: 'p2');
              expect(ids(transcripts, worktreeChat), spanIds(50, 150));
              await loadPage(transcripts, span(0, 50));
              expect(ids(transcripts, worktreeChat), spanIds(0, 150));
            });

            test('newer rows a bounded snapshot drops take the history before '
                'them, retire the page in flight, and paging refetches '
                'it', () async {
              final transcripts = store();
              seed(transcripts, span(250, 300));
              // History lags the tail: m285..m299 stay unconfirmed.
              await loadPage(transcripts, span(240, 285), nextCursor: 'p1');
              expect(ids(transcripts, worktreeChat), spanIds(240, 300));
              final inFlight = transcripts.loadOlderMessages(worktreeChat);
              final inFlightPage = page;

              transcripts.replaceAuthoritative(
                worktreeKey,
                span(290, 312),
                truncated: true,
              );
              expect(ids(transcripts, worktreeChat), spanIds(290, 312));
              inFlightPage.complete(
                RemoteChatHistoryChunk(
                  messages: span(190, 240),
                  nextCursor: 'p2',
                ),
              );
              await inFlight;
              expect(ids(transcripts, worktreeChat), spanIds(290, 312));
              expect(transcripts.isLoadingOlderMessages(worktreeChat), isFalse);

              await loadPage(transcripts, span(260, 295), nextCursor: 'p1');
              expect(cursors, [null, 'p1', null]);
              expect(ids(transcripts, worktreeChat), spanIds(260, 312));
            });
          });
        }

        test('device rows under live rows and optimistic sends drop, and '
            'those stay', () async {
          final transcripts = store();
          transcripts.ingest(worktreeKey, row('live'));
          transcripts.addPendingSend(
            worktreeKey,
            row('send', role: ChatRole.user, text: 'Sending'),
          );
          transcripts.seedFromCache(worktreeKey, span(0, 50), source: device);
          await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
          expect(ids(transcripts, worktreeChat), [
            ...spanIds(100, 150),
            'live',
            'send',
          ]);
        });

        test('a page that shares only a live row drops the device tail it '
            'does not confirm', () async {
          final transcripts = store();
          transcripts.ingest(worktreeKey, row('m149'));
          transcripts.seedFromCache(worktreeKey, span(0, 50), source: device);
          await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
          expect(ids(transcripts, worktreeChat), spanIds(100, 150));
        });

        test('a live revision of a server tail row stays', () async {
          final transcripts = store();
          transcripts.seedFromCache(worktreeKey, span(0, 50));
          transcripts.ingest(worktreeKey, row('m49', text: 'Live'));
          await loadPage(transcripts, span(100, 150), nextCursor: 'p1');
          expect(ids(transcripts, worktreeChat), [...spanIds(100, 150), 'm49']);
        });
      });

      test('every change is reported for persistence', () {
        final transcripts = store();
        transcripts.seedFromCache(worktreeKey, [row('d1')], source: device);
        transcripts.ingest(worktreeKey, row('live'));
        transcripts.ingest(standaloneKey, row('other'));
        expect(changed, containsAllInOrder([worktreeKey, worktreeKey]));
        expect(changed.last, standaloneKey);
      });
    });

    test('a full snapshot drops every cache-seeded row it omits', () {
      final transcripts = store();
      transcripts.seedFromCache(worktreeKey, [row('cached')]);
      expect(transcripts.hasTranscript(worktreeKey), isTrue);
      transcripts.replaceAuthoritative(worktreeKey, [
        row('fresh'),
      ], truncated: false);
      expect(ids(transcripts, worktreeChat), ['fresh']);
    });
  });

  group('optimistic sends', () {
    for (final live in [false, true]) {
      for (final skew in [
        const Duration(seconds: 5),
        const Duration(minutes: 1),
      ]) {
        test('a legacy ${live ? 'event' : 'snapshot'} echo within '
            '${skew.inSeconds}s clock skew retires its send', () {
          final transcripts = store();
          final sentAt = DateTime.utc(2026, 10, 24, 12);
          transcripts.addPendingSend(
            worktreeKey,
            row(
              'pending',
              role: ChatRole.user,
              text: 'continue',
              occurredAt: sentAt,
            ),
          );
          final echo = row(
            'echo',
            role: ChatRole.user,
            text: 'continue',
            occurredAt: sentAt.subtract(skew),
          );
          if (live) {
            transcripts.ingest(worktreeKey, echo);
          } else {
            transcripts.replaceAuthoritative(worktreeKey, [
              echo,
            ], truncated: false);
          }
          expect(ids(transcripts, worktreeChat), ['echo']);
        });
      }

      test('a known same-text ${live ? 'event' : 'snapshot'} row within '
          'clock skew cannot retire a new send', () {
        final transcripts = store();
        final sentAt = DateTime.utc(2026, 10, 24, 12);
        final old = row(
          'old',
          role: ChatRole.user,
          text: 'continue',
          occurredAt: sentAt.subtract(const Duration(seconds: 5)),
        );
        transcripts.ingest(worktreeKey, old);
        transcripts.addPendingSend(
          worktreeKey,
          row(
            'pending',
            role: ChatRole.user,
            text: 'continue',
            occurredAt: sentAt,
          ),
        );
        if (live) {
          transcripts.ingest(worktreeKey, old);
        } else {
          transcripts.replaceAuthoritative(worktreeKey, [
            old,
          ], truncated: false);
        }
        expect(ids(transcripts, worktreeChat), ['old', 'pending']);
      });

      test('an unseen same-text ${live ? 'event' : 'snapshot'} row outside '
          'clock skew cannot retire a new send', () {
        final transcripts = store();
        final sentAt = DateTime.utc(2026, 10, 24, 12);
        transcripts.addPendingSend(
          worktreeKey,
          row(
            'pending',
            role: ChatRole.user,
            text: 'continue',
            occurredAt: sentAt,
          ),
        );
        final old = row(
          'old',
          role: ChatRole.user,
          text: 'continue',
          occurredAt: sentAt.subtract(
            const Duration(minutes: 1, milliseconds: 1),
          ),
        );
        if (live) {
          transcripts.ingest(worktreeKey, old);
        } else {
          transcripts.replaceAuthoritative(worktreeKey, [
            old,
          ], truncated: false);
        }
        expect(ids(transcripts, worktreeChat), ['old', 'pending']);
      });
    }

    for (final live in [false, true]) {
      test('an unseen historical same-text ${live ? 'event' : 'snapshot'} '
          'does not retire a new send', () {
        final transcripts = store();
        transcripts.addPendingSend(
          worktreeKey,
          row(
            'pending',
            role: ChatRole.user,
            text: 'continue',
            occurredAt: DateTime(2026, 10, 24),
          ),
        );
        final old = row(
          'old',
          role: ChatRole.user,
          text: 'continue',
          occurredAt: DateTime(2026, 10, 23),
        );
        if (live) {
          transcripts.ingest(worktreeKey, old);
        } else {
          transcripts.replaceAuthoritative(worktreeKey, [
            old,
          ], truncated: false);
        }
        expect(ids(transcripts, worktreeChat), ['old', 'pending']);
      });
    }

    test(
      'an undated historical row cannot retire an unseen same-text send',
      () {
        final transcripts = store();
        transcripts.addPendingSend(
          worktreeKey,
          row('pending', role: ChatRole.user, text: 'continue'),
        );
        transcripts.replaceAuthoritative(worktreeKey, [
          row('old', role: ChatRole.user, text: 'continue'),
        ], truncated: false);
        expect(ids(transcripts, worktreeChat), ['old', 'pending']);
      },
    );

    test('a dated new legacy snapshot echo still retires its send', () {
      final transcripts = store();
      transcripts.addPendingSend(
        worktreeKey,
        row(
          'pending',
          role: ChatRole.user,
          text: 'continue',
          occurredAt: DateTime(2026, 10, 23),
        ),
      );
      transcripts.replaceAuthoritative(worktreeKey, [
        row(
          'echo',
          role: ChatRole.user,
          text: 'continue',
          occurredAt: DateTime(2026, 10, 24),
        ),
      ], truncated: false);
      expect(ids(transcripts, worktreeChat), ['echo']);
    });

    for (final legacy in [false, true]) {
      test('replaying a ${legacy ? 'legacy' : 'matching-id'} echo does not '
          'retire the next same-text send', () {
        final transcripts = store();
        transcripts.addPendingSend(
          worktreeKey,
          row('first', role: ChatRole.user, text: 'continue'),
        );
        transcripts.addPendingSend(
          worktreeKey,
          row('second', role: ChatRole.user, text: 'continue'),
        );
        final echo = row(
          legacy ? 'legacy-first' : 'first',
          role: ChatRole.user,
          text: 'continue',
        );
        transcripts.ingest(worktreeKey, echo);
        transcripts.ingest(worktreeKey, echo);
        expect(ids(transcripts, worktreeChat), [echo.messageId, 'second']);
      });
    }

    RemoteChatMessage optimistic(
      String id,
      String text, {
      List<ChatMessageAttachment> attachments = const [],
    }) => row(
      id,
      role: ChatRole.user,
      text: text,
      scope: null,
      attachments: attachments,
    );

    test('render after projected rows until their echo retires them', () {
      final transcripts = store();
      final pending = optimistic('msg-mobile-1', 'run the tests');
      transcripts.ingest(worktreeKey, row('answer-0'));
      transcripts.addPendingSend(worktreeKey, pending);
      expect(ids(transcripts, worktreeChat), ['answer-0', 'msg-mobile-1']);
      expect(transcripts.projectedRows(worktreeKey), hasLength(1));

      transcripts.ingest(
        worktreeKey,
        row('msg-mobile-1', role: ChatRole.user, text: 'run the tests'),
      );
      expect(ids(transcripts, worktreeChat), ['answer-0', 'msg-mobile-1']);
      expect(transcripts.messagesFor(worktreeChat).last.scope, isNotNull);
      expect(transcripts.removePendingSend(worktreeKey, pending), isFalse);
    });

    test('a legacy echo with its own id retires the send by text', () {
      final transcripts = store();
      transcripts.addPendingSend(
        worktreeKey,
        optimistic('msg-mobile-1', ' run the tests '),
      );
      transcripts.ingest(
        worktreeKey,
        row('authoritative-1', role: ChatRole.user, text: 'run the tests'),
      );
      expect(ids(transcripts, worktreeChat), ['authoritative-1']);
    });

    test('assistant rows never retire a send', () {
      final transcripts = store();
      transcripts.addPendingSend(worktreeKey, optimistic('msg-1', 'hello'));
      transcripts.ingest(worktreeKey, row('answer', text: 'hello'));
      expect(ids(transcripts, worktreeChat), ['answer', 'msg-1']);
    });

    for (final (echoed, kept) in [
      (0, ['a', 'b']),
      (2, ['a', 'b']),
      (1, ['path-1']),
    ]) {
      test('an echo with $echoed attachments keeps ${kept.join(', ')}', () {
        final transcripts = store();
        transcripts.addPendingSend(
          worktreeKey,
          optimistic(
            'msg-1',
            'look',
            attachments: [attachment('a'), attachment('b')],
          ),
        );
        transcripts.ingest(
          worktreeKey,
          row(
            'msg-1',
            role: ChatRole.user,
            text: 'look',
            attachments: [
              for (var i = 1; i <= echoed; i++) attachment('path-$i'),
            ],
          ),
        );
        expect(
          transcripts
              .messagesFor(worktreeChat)
              .single
              .attachments
              .map((a) => a.attachmentId),
          kept,
        );
      });
    }

    for (final target in [worktreeChat, standaloneChat]) {
      test(
        'completed turn clears ${target.scope} tab spinner without changing the tool',
        () {
          final transcripts = store();
          final key = remoteChatKeyForTarget(target)!;
          final orphan = row('tool', status: ChatMessageStatus.streaming);
          transcripts.ingest(key, row('user', role: ChatRole.user));
          transcripts.ingest(key, orphan);
          transcripts.ingest(
            key,
            RemoteChatMessage(
              messageId: 'timer',
              chatId: 'chat-1',
              role: ChatRole.system,
              status: ChatMessageStatus.complete,
              text: '',
              parts: const [
                ChatPart(
                  kind: 'turn_timer',
                  data: {'startedAt': 1000, 'completedAt': 2000},
                ),
              ],
            ),
          );
          expect(transcripts.isStreamingForChat(target), isFalse);
          expect(transcripts.messagesFor(target), contains(same(orphan)));
          transcripts.ingest(key, row('next-user', role: ChatRole.user));
          transcripts.ingest(
            key,
            row('next-tool', status: ChatMessageStatus.streaming),
          );
          expect(transcripts.isStreamingForChat(target), isTrue);
        },
      );
    }

    for (final target in [worktreeChat, standaloneChat]) {
      test('pending follow-up preserves ${target.scope} live transcript', () {
        final transcripts = store();
        final key = remoteChatKeyForTarget(target)!;
        transcripts.ingest(
          key,
          row('reply', status: ChatMessageStatus.streaming),
        );
        transcripts.addPendingSend(key, optimistic('follow-up', 'Next task'));
        expect(transcripts.messagesFor(target).last.messageId, 'follow-up');
        expect(transcripts.isStreamingForChat(target), isTrue);
      });
    }

    test('a streaming send shows the chat as streaming', () {
      final transcripts = store();
      expect(transcripts.isStreamingForChat(worktreeChat), isFalse);
      transcripts.addPendingSend(
        worktreeKey,
        row('msg-1', status: ChatMessageStatus.streaming),
      );
      expect(transcripts.isStreamingForChat(worktreeChat), isTrue);
      expect(transcripts.isStreamingForChat(standaloneChat), isFalse);
    });

    test('chat keys cover projected rows and optimistic sends', () {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('a'));
      transcripts.addPendingSend(standaloneKey, row('b'));
      expect(transcripts.chatKeys, {worktreeKey, standaloneKey});
      expect(
        transcripts
            .findProjectedRow(
              RemoteChatScope.worktree,
              (m) => m.messageId == 'a',
            )
            ?.messageId,
        'a',
      );
      expect(
        transcripts.findProjectedRow(
          RemoteChatScope.standalone,
          (m) => m.messageId == 'b',
        ),
        isNull,
        reason: 'Optimistic sends are not proof of delivery',
      );
    });
  });

  group('turn evidence', () {
    test('every merged row is offered, in order', () {
      final transcripts = store();
      transcripts.seedFromCache(worktreeKey, [row('cached')]);
      transcripts.ingest(worktreeKey, row('live'));
      transcripts.ingest(worktreeKey, row(''));
      transcripts.replaceAuthoritative(worktreeKey, [
        row('snap-1'),
        row('snap-2'),
      ], truncated: false);
      expect(evidence, ['cached', 'live', 'snap-1', 'snap-2']);
    });
  });

  group('transcript updates', () {
    test('rows resolve through the resolver, with the fallback scope', () {
      final transcripts = store();
      final requests = <(String, RemoteChatScope?)>[];
      final merged = transcripts.applyUpdate(
        IncomingChatRowsUpdate(
          rows: [
            row('a', scope: null),
            row('b', chatId: 'unknown', scope: null),
            row('c', scope: RemoteChatScope.standalone),
          ],
          keySnapshot: null,
          fallbackScope: RemoteChatScope.worktree,
        ),
        resolveChat: (_, chatId, scope) {
          requests.add((chatId, scope));
          return chatId == 'unknown' ? null : (scope: scope!, chatId: chatId);
        },
      );
      expect(merged, isTrue);
      expect(requests, [
        ('chat-1', RemoteChatScope.worktree),
        ('unknown', RemoteChatScope.worktree),
        ('chat-1', RemoteChatScope.standalone),
      ]);
      expect(ids(transcripts, worktreeChat), ['a']);
      expect(ids(transcripts, standaloneChat), ['c']);
    });

    test('a live row prefers the event scope and may stay unresolved', () {
      final transcripts = store();
      final message = row('a', scope: RemoteChatScope.worktree);
      expect(
        transcripts.applyUpdate(
          LiveChatMessageUpdate(
            chatId: 'chat-1',
            scope: RemoteChatScope.standalone,
            message: message,
            keySnapshot: null,
          ),
          resolveChat: (_, chatId, scope) => (scope: scope!, chatId: chatId),
        ),
        isTrue,
      );
      expect(ids(transcripts, standaloneChat), ['a']);
      expect(
        transcripts.applyUpdate(
          LiveChatMessageUpdate(
            chatId: 'chat-2',
            scope: null,
            message: row('b', chatId: 'chat-2', scope: null),
            keySnapshot: null,
          ),
          resolveChat: (_, _, _) => null,
        ),
        isFalse,
      );
    });
  });

  group('older history', () {
    test('pages prepend unknown rows and stop at the start', () async {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('c1'));
      transcripts.ingest(worktreeKey, row('c2'));

      final first = transcripts.loadOlderMessages(worktreeChat);
      expect(transcripts.isLoadingOlderMessages(worktreeChat), isTrue);
      // Single-flight while the page is in flight.
      await transcripts.loadOlderMessages(worktreeChat);
      expect(cursors, [null]);
      page.complete(
        RemoteChatHistoryChunk(
          messages: [row('h1'), row('c1')],
          nextCursor: 'older',
        ),
      );
      await first;
      expect(ids(transcripts, worktreeChat), ['h1', 'c1', 'c2']);
      expect(transcripts.isLoadingOlderMessages(worktreeChat), isFalse);
      expect(transcripts.canLoadOlderMessages(worktreeChat), isTrue);

      final second = transcripts.loadOlderMessages(worktreeChat);
      page.complete(RemoteChatHistoryChunk(messages: [row('h0')]));
      await second;
      expect(cursors, [null, 'older']);
      expect(ids(transcripts, worktreeChat), ['h0', 'h1', 'c1', 'c2']);
      expect(transcripts.canLoadOlderMessages(worktreeChat), isFalse);
    });

    test('a failed page keeps the cursor for the next trigger', () async {
      final transcripts = store();
      final load = transcripts.loadOlderMessages(worktreeChat);
      page.completeError(const RemoteControlException('offline'));
      await load;
      expect(transcripts.isLoadingOlderMessages(worktreeChat), isFalse);
      expect(transcripts.canLoadOlderMessages(worktreeChat), isTrue);
      unawaited(transcripts.loadOlderMessages(worktreeChat));
      expect(cursors, [null, null]);
    });

    test('nothing loads while disconnected', () async {
      final transcripts = store();
      connected = false;
      expect(transcripts.canLoadOlderMessages(worktreeChat), isFalse);
      await transcripts.loadOlderMessages(worktreeChat);
      expect(cursors, isEmpty);
    });

    test('a page from a reset session never lands', () async {
      final transcripts = store();
      final stale = transcripts.loadOlderMessages(worktreeChat);
      final stalePage = page;
      transcripts.reset();
      // The next session opens the same chat and pages it.
      final fresh = transcripts.loadOlderMessages(worktreeChat);
      stalePage.complete(
        RemoteChatHistoryChunk(messages: [row('old-session')]),
      );
      await stale;
      expect(transcripts.messagesFor(worktreeChat), isEmpty);
      expect(
        transcripts.isLoadingOlderMessages(worktreeChat),
        isTrue,
        reason: "The stale page must not clear the new session's read",
      );
      page.complete(RemoteChatHistoryChunk(messages: [row('new-session')]));
      await fresh;
      expect(ids(transcripts, worktreeChat), ['new-session']);
    });
  });

  group('deterministic sequences', () {
    test(lateStreamingAfterTerminal.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(lateStreamingAfterTerminal.steps);

      expect(
        harness.rowIds(sequenceChat),
        lateStreamingAfterTerminal.expectedRowIds,
      );
      final answer = harness.transcripts.messagesFor(sequenceChat).single;
      expect(answer.status, ChatMessageStatus.complete);
      expect(answer.text, 'Final');
      expect(answer.updatedAt, DateTime.fromMillisecondsSinceEpoch(3000));
      expect(harness.transcripts.isStreamingForChat(sequenceChat), isFalse);
      // Every revision was still offered as turn evidence.
      expect(harness.evidence, [
        for (var i = 0; i < 5; i++)
          (chat: sequenceChatKey, messageId: 'answer'),
      ]);
      expect(
        [for (final step in harness.effects) step.chatHydrated],
        [null, null, sequenceChatKey, sequenceChatKey, null],
      );
    });

    test(cachedHistoryThenAuthoritative.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(cachedHistoryThenAuthoritative.steps);

      final rows = harness.transcripts.messagesFor(sequenceChat);
      expect(
        harness.rowIds(sequenceChat),
        cachedHistoryThenAuthoritative.expectedRowIds,
      );
      expect(rows.map((m) => m.messageId).toSet(), hasLength(rows.length));
      expect(rows.firstWhere((m) => m.messageId == 'c2').text, 'Second');
      expect(harness.historyCursors, [null, 'cursor-2']);
      expect(harness.transcripts.canLoadOlderMessages(sequenceChat), isFalse);
    });

    test(sessionResetBetweenBatches.name, () async {
      final harness = RemoteStoresHarness();
      await harness.run(sessionResetBetweenBatches.steps);

      expect(
        harness.rowIds(sequenceChat),
        sessionResetBetweenBatches.expectedRowIds,
      );
      expect(harness.transcripts.chatKeys, isEmpty);
      expect(harness.transcripts.isLoadingOlderMessages(sequenceChat), isFalse);
      // The new session has not paged this chat yet.
      expect(harness.transcripts.canLoadOlderMessages(sequenceChat), isTrue);
    });
  });

  group('revisionFor', () {
    const otherChat = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-2',
    );

    test('every visible write bumps only its own chat', () async {
      final transcripts = store();
      var last = transcripts.revisionFor(worktreeKey);
      void expectBumped(String step) {
        final next = transcripts.revisionFor(worktreeKey);
        expect(next, greaterThan(last), reason: step);
        last = next;
      }

      // A cached tail seeds only a chat that shows nothing yet.
      transcripts.seedFromCache(worktreeKey, [row('c')]);
      expectBumped('cache seed');
      transcripts.ingest(worktreeKey, row('a'));
      expectBumped('live upsert');
      transcripts.replaceAuthoritative(worktreeKey, [
        row('a'),
        row('b'),
      ], truncated: false);
      expectBumped('authoritative replace');
      final pending = row('p', role: ChatRole.user, text: 'hi');
      transcripts.addPendingSend(worktreeKey, pending);
      expectBumped('pending add');
      expect(transcripts.removePendingSend(worktreeKey, pending), isTrue);
      expectBumped('pending remove');
      transcripts.addPendingSend(worktreeKey, pending);
      expectBumped('pending re-add');
      transcripts.ingest(
        worktreeKey,
        row('p-echo', role: ChatRole.user, text: 'hi'),
      );
      expectBumped('echo retires the pending send');
      final older = transcripts.loadOlderMessages(worktreeChat);
      expectBumped('older page starts loading');
      page.complete(RemoteChatHistoryChunk(messages: [row('z')]));
      await older;
      expectBumped('older page lands');

      expect(transcripts.revisionFor(remoteChatKeyForTarget(otherChat)!), 0);
      expect(transcripts.revisionFor(standaloneKey), 0);
    });

    test('a stale revision of a known row changes nothing', () {
      final transcripts = store();
      transcripts.ingest(
        worktreeKey,
        row('a', text: 'new', occurredAt: DateTime(2026, 1, 2)),
      );
      final before = transcripts.revisionFor(worktreeKey);
      transcripts.ingest(
        worktreeKey,
        row('a', text: 'old', occurredAt: DateTime(2026, 1, 1)),
      );
      expect(texts(transcripts, worktreeChat), ['new']);
      expect(transcripts.revisionFor(worktreeKey), before);
    });

    test('a removal the echo already made changes nothing', () {
      final transcripts = store();
      final pending = row('p', role: ChatRole.user, text: 'hi');
      transcripts.addPendingSend(worktreeKey, pending);
      transcripts.ingest(worktreeKey, row('p', role: ChatRole.user));
      final before = transcripts.revisionFor(worktreeKey);
      expect(transcripts.removePendingSend(worktreeKey, pending), isFalse);
      expect(transcripts.revisionFor(worktreeKey), before);
    });

    test('reset clears every revision', () {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('a'));
      transcripts.reset();
      expect(transcripts.revisionFor(worktreeKey), 0);
    });
  });

  group('messagesFor identity', () {
    const otherChat = RemoteWorktreeChatTarget(
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-2',
    );
    final otherKey = remoteChatKeyForTarget(otherChat)!;

    test('an unchanged chat returns the same list, pending sends included', () {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('a'));
      transcripts.addPendingSend(
        worktreeKey,
        row('p', role: ChatRole.user, text: 'hi', scope: null),
      );
      final first = transcripts.messagesFor(worktreeChat);

      expect(transcripts.messagesFor(worktreeChat), same(first));
      expect([for (final m in first) m.messageId], ['a', 'p']);
      expect(() => first.add(row('x')), throwsUnsupportedError);
    });

    test('a write to another chat or scope keeps the list', () {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('a'));
      final first = transcripts.messagesFor(worktreeChat);

      transcripts.ingest(otherKey, row('b', chatId: 'chat-2'));
      transcripts.ingest(standaloneKey, row('c', scope: null));
      transcripts.addPendingSend(
        otherKey,
        row('p', chatId: 'chat-2', role: ChatRole.user, scope: null),
      );

      expect(transcripts.messagesFor(worktreeChat), same(first));
      expect(ids(transcripts, standaloneChat), ['c']);
    });

    test(
      'every visible write publishes a new list and keeps the old one',
      () async {
        final transcripts = store();
        var last = transcripts.messagesFor(worktreeChat);
        var lastIds = [for (final m in last) m.messageId];
        void expectRepublished(String step) {
          final next = transcripts.messagesFor(worktreeChat);
          expect(next, isNot(same(last)), reason: step);
          // A previously returned list is a snapshot, never mutated in place.
          expect([for (final m in last) m.messageId], lastIds, reason: step);
          expect(
            transcripts.messagesFor(worktreeChat),
            same(next),
            reason: step,
          );
          last = next;
          lastIds = [for (final m in next) m.messageId];
        }

        // A cached tail seeds only a chat that shows nothing yet.
        transcripts.seedFromCache(worktreeKey, [row('c')]);
        expectRepublished('cache seed');
        transcripts.ingest(worktreeKey, row('a'));
        expectRepublished('live upsert');
        transcripts.ingest(
          worktreeKey,
          row('a', text: 'edited', occurredAt: DateTime(2026, 1, 2)),
        );
        expectRepublished('live revision of a known row');
        transcripts.replaceAuthoritative(worktreeKey, [
          row('a'),
          row('b'),
        ], truncated: false);
        expectRepublished('authoritative replace');
        final pending = row('p', role: ChatRole.user, text: 'hi', scope: null);
        transcripts.addPendingSend(worktreeKey, pending);
        expectRepublished('pending add');
        expect(transcripts.removePendingSend(worktreeKey, pending), isTrue);
        expectRepublished('pending remove');
        transcripts.addPendingSend(worktreeKey, pending);
        expectRepublished('pending re-add');
        transcripts.ingest(
          worktreeKey,
          row('p-echo', role: ChatRole.user, text: 'hi'),
        );
        expectRepublished('echo retires the pending send');
        final older = transcripts.loadOlderMessages(worktreeChat);
        expectRepublished('older page starts loading');
        page.complete(RemoteChatHistoryChunk(messages: [row('z')]));
        await older;
        expectRepublished('older page lands');
        expect(ids(transcripts, worktreeChat).first, 'z');
      },
    );

    test('stale revisions and no-op removals keep the list', () {
      final transcripts = store();
      final pending = row('p', role: ChatRole.user, text: 'hi', scope: null);
      transcripts.ingest(
        worktreeKey,
        row('a', text: 'new', occurredAt: DateTime(2026, 1, 2)),
      );
      transcripts.addPendingSend(worktreeKey, pending);
      transcripts.ingest(worktreeKey, row('p', role: ChatRole.user));
      final first = transcripts.messagesFor(worktreeChat);

      transcripts.ingest(
        worktreeKey,
        row('a', text: 'old', occurredAt: DateTime(2026, 1, 1)),
      );
      expect(transcripts.removePendingSend(worktreeKey, pending), isFalse);

      expect(transcripts.messagesFor(worktreeChat), same(first));
      expect(texts(transcripts, worktreeChat), ['new', 'hello']);
    });

    test('a reset session never returns the previous session list', () {
      final transcripts = store();
      transcripts.ingest(worktreeKey, row('old-session'));
      final stale = transcripts.messagesFor(worktreeChat);

      transcripts.reset();
      expect(transcripts.messagesFor(worktreeChat), isEmpty);
      // Revisions restart at zero, so a revision-keyed cache could otherwise
      // hand back the discarded session's rows.
      transcripts.ingest(worktreeKey, row('new-session'));

      final fresh = transcripts.messagesFor(worktreeChat);
      expect(fresh, isNot(same(stale)));
      expect(ids(transcripts, worktreeChat), ['new-session']);
      expect(transcripts.messagesFor(worktreeChat), same(fresh));
    });
  });
}
