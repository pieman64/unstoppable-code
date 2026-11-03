import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/chat_transcript_store.dart'
    show RemoteCachedTailSource;
import 'package:mobile/ui/features/remote/view_models/hydration_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/owned_command_registry.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_state.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/worktree_activity_load_tracker.dart';

import '../../../../support/fake_remote_control_repository.dart';

final class _GatedActivityRepository extends FakeRemoteControlRepository {
  final gate = Completer<void>();
  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await gate.future;
    return (slices: const <String, dynamic>{}, refreshing: false);
  }
}

final class _RecordingChatHydrationRepository
    extends FakeRemoteControlRepository {
  final List<RemoteChatTarget> requestedChatTargets = [];

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    requestedChatTargets.add(target);
    return null;
  }
}

/// Answers each hydration request with its own completer, so a test can
/// settle requests out of order.
final class _GatedRequestsRepository extends FakeRemoteControlRepository {
  final worktreeRequests = <Completer<void>>[];
  final chatRequests = <Completer<String?>>[];
  final cacheReads = <Completer<List<RemoteChatMessage>>>[];

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    requestWorktreeStateCalls += 1;
    return _next(worktreeRequests);
  }

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) {
    requestChatTranscriptCalls += 1;
    return _next(chatRequests);
  }

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) {
    cachedChatFetches += 1;
    return _next(cacheReads);
  }
}

Future<T> _next<T>(List<Completer<T>> requests) {
  final request = Completer<T>();
  requests.add(request);
  return request.future;
}

const _chat = RemoteWorktreeChatTarget(
  workspaceLocalId: 'ws',
  worktreeLocalId: 'wt',
  chatId: 'chat',
);
const _chatKey = (scope: RemoteChatScope.worktree, chatId: 'chat');
final _worktree = remoteWorktreeKey('ws', 'wt');

RemoteChatMessage _row(String id, {String chatId = 'chat'}) =>
    RemoteChatMessage(
      messageId: id,
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: id,
    );

/// A coordinator over a fake repository, a real command registry, and a
/// fake clock; records what it asks of the facade.
final class _Harness {
  _Harness(
    this.async, {
    FakeRemoteControlRepository? repository,
    this.retryWindow = const Duration(seconds: 15),
    this.timeout = const Duration(seconds: 60),
  }) : repository = repository ?? FakeRemoteControlRepository();

  final FakeAsync async;
  final FakeRemoteControlRepository repository;
  final Duration retryWindow;
  final Duration timeout;
  bool connected = true;
  bool backgrounded = false;
  var summaries = <RemoteChatSummary>[];
  final transcripts = <RemoteChatKey, List<RemoteChatMessage>>{};

  /// Tails persisted on this device, and the chats opened so far.
  final persisted = <RemoteChatKey, List<RemoteChatMessage>>{};
  final opened = <RemoteChatKey>[];

  /// Which cache seeded each chat's rows; absent for live rows.
  final cachedFrom = <RemoteChatKey, RemoteCachedTailSource>{};

  /// The transcript store's rule: an empty chat, or one showing only a
  /// staler cache.
  bool acceptsCachedTail(RemoteChatKey chat, RemoteCachedTailSource source) {
    if (transcripts[chat]?.isNotEmpty != true) return true;
    final from = cachedFrom[chat];
    return from != null && from.index < source.index;
  }

  int notifications = 0;
  int settled = 0;
  int tabListMark = 0;
  int transcriptMark = 0;

  late final commands = OwnedCommandRegistry(notify: () {});
  late final coordinator = HydrationCoordinator(
    repository: repository,
    commands: commands,
    notify: () => notifications++,
    isConnected: () => connected,
    isBackgrounded: () => backgrounded,
    snapshot: () => null,
    chatSummariesFor: (_) => summaries,
    hasTranscript: (chat) => transcripts[chat]?.isNotEmpty == true,
    openPersistedTail: (chat) {
      opened.add(chat);
      return persisted[chat] ?? const [];
    },
    acceptsCachedTail: acceptsCachedTail,
    seedCachedTail: (chat, rows, source) {
      if (rows.isEmpty || !acceptsCachedTail(chat, source)) return false;
      transcripts[chat] = rows;
      cachedFrom[chat] = source;
      return true;
    },
    seedCurrentTail: (chat, rows) {
      if (!acceptsCachedTail(chat, RemoteCachedTailSource.server)) return false;
      transcripts[chat] = rows;
      cachedFrom[chat] = RemoteCachedTailSource.server;
      return true;
    },
    onChatHydrationSettled: () => settled++,
    tabListMark: () => tabListMark,
    transcriptMark: () => transcriptMark,
    retryWindow: retryWindow,
    timeout: timeout,
    clock: () => DateTime(2026, 9, 30).add(async.elapsed),
  );
}

void main() {
  group('HydrationCoordinator', () {
    test('repeated ensures open a persisted tail only once per pairing', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        for (var i = 0; i < 5; i++) {
          harness.coordinator.ensureChatTranscript(_chat);
          async.flushMicrotasks();
        }
        expect(harness.opened, [_chatKey]);
        harness.coordinator.reset();
        harness.coordinator.ensureChatTranscript(_chat);
        expect(harness.opened, [_chatKey, _chatKey]);
        harness.coordinator.dispose();
      });
    });

    test('a chat transcript is pending until its snapshot lands', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        async.flushMicrotasks();
        expect(harness.repository.requestChatTranscriptCalls, 1);
        expect(coordinator.isChatHydrationPending, isTrue);
        expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
        expect(coordinator.pendingChatTranscripts, [_chatKey]);

        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.isChatHydrationPending, isFalse);
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        expect(harness.settled, 1);

        async.elapse(const Duration(minutes: 5));
        coordinator.ensureChatTranscript(_chat);
        expect(harness.repository.requestChatTranscriptCalls, 1);
      });
    });

    test('cached rows end the transcript loading state', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.repository.cachedChatMessages = [
          _row('cached'),
          _row('other', chatId: 'other'),
        ];
        harness.coordinator.ensureChatTranscript(_chat);
        async.flushMicrotasks();
        expect(harness.transcripts[_chatKey]?.map((m) => m.messageId), [
          'cached',
        ]);
        expect(harness.coordinator.isChatTranscriptLoading(_chat), isFalse);
        expect(harness.coordinator.isChatHydrationPending, isTrue);
      });
    });

    group('CAN-3373 persisted tail', () {
      List<String>? shown(_Harness harness) =>
          harness.transcripts[_chatKey]?.map((m) => m.messageId).toList();

      test('paints before the request, without a notification', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.persisted[_chatKey] = [_row('persisted')];
          harness.repository.cachedChatMessages = const [];
          harness.coordinator.ensureChatTranscript(_chat);

          // Synchronous: the chat screen's first build reads it.
          expect(shown(harness), ['persisted']);
          expect(harness.cachedFrom[_chatKey], RemoteCachedTailSource.device);
          expect(harness.coordinator.isChatTranscriptLoading(_chat), isFalse);
          expect(harness.notifications, 0);
          expect(harness.opened, [_chatKey]);
          expect(harness.repository.requestChatTranscriptCalls, 1);

          // An empty server cache keeps the persisted tail.
          async.flushMicrotasks();
          expect(harness.repository.cachedChatFetches, 1);
          expect(shown(harness), ['persisted']);
          expect(harness.coordinator.isChatHydrationPending, isTrue);
        });
      });

      test('the server cache replaces the persisted tail', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.persisted[_chatKey] = [_row('persisted')];
          harness.repository.cachedChatMessages = [_row('server')];
          harness.coordinator.ensureChatTranscript(_chat);
          async.flushMicrotasks();
          expect(shown(harness), ['server']);
          expect(harness.cachedFrom[_chatKey], RemoteCachedTailSource.server);
          expect(harness.notifications, 1);
        });
      });

      test('rows already shown keep the persisted tail and server cache '
          'out', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.transcripts[_chatKey] = [_row('live')];
          harness.persisted[_chatKey] = [_row('persisted')];
          harness.repository.cachedChatMessages = [_row('server')];
          harness.coordinator.ensureChatTranscript(_chat);
          async.flushMicrotasks();
          expect(shown(harness), ['live']);
          expect(harness.repository.cachedChatFetches, 0);
          expect(harness.notifications, 0);
        });
      });

      test('a hydrated chat does not reopen its persisted tail on ensure', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.coordinator.ensureChatTranscript(_chat);
          harness.coordinator.resolveChatTranscript(_chatKey);
          harness.persisted[_chatKey] = [_row('persisted')];
          harness.coordinator.ensureChatTranscript(_chat);
          expect(harness.opened, [_chatKey]);
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(harness.transcripts[_chatKey], isNull);
        });
      });

      test('nothing is read or seeded while disconnected', () {
        fakeAsync((async) {
          final harness = _Harness(async)..connected = false;
          harness.persisted[_chatKey] = [_row('persisted')];
          harness.coordinator.ensureChatTranscript(_chat);
          expect(harness.opened, isEmpty);
          expect(harness.transcripts, isEmpty);
        });
      });
    });

    test('a timed-out chat retries once, then waits for Retry', () {
      fakeAsync((async) {
        final harness = _Harness(
          async,
          retryWindow: const Duration(seconds: 5),
          timeout: const Duration(seconds: 2),
        );
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        // CAN-3631: the first failure stays quiet while the retry is due.
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
        expect(coordinator.isChatHydrationPending, isFalse);
        expect(harness.settled, 1);

        async.elapse(const Duration(seconds: 5));
        expect(harness.repository.requestChatTranscriptCalls, 2);
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatHydrationPending, isTrue);

        async.elapse(const Duration(seconds: 2));
        expect(
          coordinator.chatHydrationError(_chat),
          'The conversation took too long to load. Try again.',
        );
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(harness.repository.requestChatTranscriptCalls, 2);

        // Retry starts a fresh load with both attempts available.
        coordinator.retryChatTranscript(_chat);
        expect(harness.repository.requestChatTranscriptCalls, 3);
        expect(coordinator.chatHydrationError(_chat), isNull);
        async.elapse(const Duration(seconds: 2));
        expect(coordinator.chatHydrationError(_chat), isNull);
        async.elapse(const Duration(seconds: 5));
        expect(harness.repository.requestChatTranscriptCalls, 4);
        async.elapse(const Duration(seconds: 2));
        expect(
          coordinator.chatHydrationError(_chat),
          'The conversation took too long to load. Try again.',
        );
        async.elapse(const Duration(minutes: 5));
        expect(harness.repository.requestChatTranscriptCalls, 4);
      });
    });

    test('the automatic retry waits for the foreground', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2));
        harness.coordinator.ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        harness.backgrounded = true;
        async.elapse(const Duration(minutes: 1));
        expect(harness.repository.requestChatTranscriptCalls, 1);
        expect(harness.coordinator.chatHydrationError(_chat), isNull);
        expect(harness.coordinator.isChatTranscriptLoading(_chat), isTrue);
      });
    });

    test('a failed transcript command retries before it fails its chat', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        repository.chatRequests.single.complete('hydrate-1');
        async.flushMicrotasks();
        harness.commands.handleFailed(
          'hydrate-1',
          'Desktop busy',
          projectionSequence: 0,
        );
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(harness.commands.failureMessage, isNull);

        async.elapse(const Duration(seconds: 15));
        expect(repository.requestChatTranscriptCalls, 2);
        repository.chatRequests.last.complete('hydrate-2');
        async.flushMicrotasks();
        harness.commands.handleFailed(
          'hydrate-2',
          'Desktop still busy',
          projectionSequence: 0,
        );
        expect(coordinator.chatHydrationError(_chat), 'Desktop still busy');
        expect(harness.commands.failureMessage, isNull);

        coordinator.retryChatTranscript(_chat);
        expect(repository.requestChatTranscriptCalls, 3);
        repository.chatRequests.last.complete('hydrate-3');
        async.flushMicrotasks();
        coordinator.resolveChatTranscript(_chatKey);
        harness.commands.handleFailed(
          'hydrate-3',
          'Too late',
          projectionSequence: 0,
        );
        expect(coordinator.chatHydrationError(_chat), isNull);
      });
    });

    test('an expired first command is retried without an error', () {
      fakeAsync((async) {
        const expired =
            'The request expired before it completed. Try again when the '
            'desktop is available.';
        final repository = _GatedRequestsRepository();
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        repository.chatRequests.single.complete('hydrate-1');
        async.flushMicrotasks();
        harness.commands.handleFailed(
          'hydrate-1',
          expired,
          projectionSequence: 0,
        );
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

        async.elapse(const Duration(seconds: 14));
        expect(repository.requestChatTranscriptCalls, 1);
        async.elapse(const Duration(seconds: 1));
        expect(repository.requestChatTranscriptCalls, 2);
        repository.chatRequests.last.complete('hydrate-2');
        async.flushMicrotasks();
        // A duplicate terminal for the first command spends nothing.
        harness.commands.handleFailed(
          'hydrate-1',
          expired,
          projectionSequence: 0,
        );
        expect(coordinator.chatHydrationError(_chat), isNull);

        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 2);
        expect(coordinator.chatHydrationError(_chat), isNull);
      });
    });

    test('a failed send is retried before its error shows', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        repository.chatRequests.single.completeError(
          const RemoteControlException('Relay unavailable.'),
        );
        async.flushMicrotasks();
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

        async.elapse(const Duration(seconds: 15));
        expect(repository.requestChatTranscriptCalls, 2);
        repository.chatRequests.last.completeError(
          const RemoteControlException('Relay still unavailable.'),
        );
        async.flushMicrotasks();
        expect(
          coordinator.chatHydrationError(_chat),
          'Relay still unavailable.',
        );
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(repository.requestChatTranscriptCalls, 2);
      });
    });

    test('a reply after the final failure clears the error', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 60 + 15 + 60));
        expect(harness.repository.requestChatTranscriptCalls, 2);
        expect(coordinator.chatHydrationError(_chat), isNotNull);

        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(harness.repository.requestChatTranscriptCalls, 2);
      });
    });

    test('a reply during the retry delay cancels the retry', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final coordinator = harness.coordinator..ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 70));
        coordinator.resolveChatTranscript(_chatKey);
        async.elapse(const Duration(minutes: 5));
        expect(harness.repository.requestChatTranscriptCalls, 1);
        expect(coordinator.chatHydrationError(_chat), isNull);
        expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
      });
    });

    test('foreground discovery stays loading until its retry fails', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.supportsForegroundChat = true;
        final coordinator = harness.coordinator
          ..ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
        bool loading() => coordinator.isWorktreeChatsLoading(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.elapse(const Duration(seconds: 60));
        expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
        expect(loading(), isTrue);
        expect(coordinator.isChatHydrationPending, isFalse);

        async.elapse(const Duration(seconds: 15));
        expect(harness.repository.requestChatTranscriptCalls, 2);
        expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
        expect(loading(), isTrue);

        async.elapse(const Duration(seconds: 60));
        expect(
          coordinator.foregroundChatError('ws', 'wt'),
          'The conversation took too long to load. Try again.',
        );
        expect(loading(), isFalse);
        async.elapse(const Duration(minutes: 5));
        expect(harness.repository.requestChatTranscriptCalls, 2);

        coordinator.retryForegroundChat('ws', 'wt');
        expect(harness.repository.requestChatTranscriptCalls, 3);
        expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
        expect(loading(), isTrue);
      });
    });

    test('foreground discovery is retried after a failed send', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository()
          ..supportsForegroundChat = true;
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator
          ..ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
        repository.chatRequests.single.completeError(
          const RemoteControlException('Relay unavailable.'),
        );
        async.flushMicrotasks();
        expect(coordinator.foregroundChatError('ws', 'wt'), isNull);

        async.elapse(const Duration(seconds: 15));
        expect(repository.requestChatTranscriptCalls, 2);
        coordinator.resolveForegroundChat(_worktree);
        expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
        expect(
          coordinator.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isFalse,
        );
      });
    });

    group('CAN-3631 discovery that finds its chat', () {
      const summary = RemoteChatSummary(
        chatId: 'chat',
        scope: RemoteChatScope.worktree,
        title: 'Chat',
        active: true,
      );
      const timedOut = 'The conversation took too long to load. Try again.';

      HydrationCoordinator discover(_Harness harness) {
        harness.repository.supportsForegroundChat = true;
        return harness.coordinator..ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
      }

      test(
        'a named chat paints its device tail while discovery owns the load',
        () {
          fakeAsync((async) {
            final harness = _Harness(async);
            harness.persisted[_chatKey] = [_row('persisted')];
            final coordinator = discover(harness);
            harness.summaries = const [summary];

            coordinator.ensureChatTranscript(_chat);

            expect(harness.transcripts[_chatKey]?.map((m) => m.messageId), [
              'persisted',
            ]);
            expect(harness.cachedFrom[_chatKey], RemoteCachedTailSource.device);
            expect(harness.opened, [_chatKey]);
            expect(harness.repository.requestChatTranscriptCalls, 1);
            expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
          });
        },
      );

      test('a chat named during the retry delay keeps two attempts', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = discover(harness);
          async.elapse(const Duration(seconds: 60));
          // A summary-only delta names the chat, and the screen asks for it.
          harness.summaries = const [summary];
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          expect(coordinator.chatHydrationError(_chat), isNull);

          async.elapse(const Duration(seconds: 15));
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          async.elapse(const Duration(seconds: 1));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
          coordinator.ensureChatTranscript(_chat);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 2);

          // Retry starts a fresh load with both attempts available.
          coordinator.retryChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 3);
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 15));
          expect(harness.repository.requestChatTranscriptCalls, 4);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 4);
        });
      });

      test('the discovery retry is the named chat\'s last attempt', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = discover(harness);
          async.elapse(const Duration(seconds: 60));
          harness.summaries = const [summary];
          async.elapse(const Duration(seconds: 15));
          expect(harness.repository.requestChatTranscriptCalls, 2);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

          async.elapse(const Duration(seconds: 60));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 2);
        });
      });

      test('a chat named during the first request waits for it', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = discover(harness);
          async.elapse(const Duration(seconds: 10));
          harness.summaries = const [summary];
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

          async.elapse(const Duration(seconds: 50));
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 15));
          expect(harness.repository.requestChatTranscriptCalls, 2);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 2);

          // The first request's late reply still wins.
          coordinator
            ..resolveChatTranscript(_chatKey)
            ..resolveForegroundChat(_worktree);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        });
      });

      test('CAN-4427 a chat named after discovery failed loads on its own', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = discover(harness);
          async.elapse(const Duration(seconds: 60 + 15 + 60));
          expect(coordinator.foregroundChatError('ws', 'wt'), timedOut);

          // The discovery never knew a chat, so its failure belongs to none.
          harness.summaries = const [summary];
          expect(coordinator.chatHydrationError(_chat), isNull);
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 3);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          expect(coordinator.chatHydrationError(_chat), isNull);

          async.elapse(const Duration(seconds: 60 + 15));
          expect(harness.repository.requestChatTranscriptCalls, 4);
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 4);
        });
      });

      test('CAN-4427 a discovery failure stays with the chat it opened', () {
        fakeAsync((async) {
          const other = RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            chatId: 'other',
          );
          RemoteChatSummary tab(String chatId, {bool active = false}) =>
              RemoteChatSummary(
                chatId: chatId,
                scope: RemoteChatScope.worktree,
                title: chatId,
                active: active,
              );
          final harness = _Harness(async);
          final coordinator = discover(harness);
          // The chat is named during the discovery's last attempt.
          async.elapse(const Duration(seconds: 60 + 15 + 10));
          harness.summaries = [tab('chat', active: true), tab('other')];
          coordinator.ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 50));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          expect(harness.repository.requestChatTranscriptCalls, 2);

          // The desktop's active tab moves; the failure does not follow it.
          harness.summaries = [tab('chat'), tab('other', active: true)];
          expect(coordinator.chatHydrationError(other), isNull);
          coordinator.ensureChatTranscript(other);
          expect(harness.repository.requestChatTranscriptCalls, 3);
          expect(coordinator.isChatTranscriptLoading(other), isTrue);
          expect(coordinator.chatHydrationError(_chat), timedOut);
          coordinator.ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 3);

          // Retry on the other chat leaves the first chat's failure alone.
          async.elapse(const Duration(seconds: 60 + 15 + 60));
          expect(coordinator.chatHydrationError(other), timedOut);
          coordinator.retryChatTranscript(other);
          expect(harness.repository.requestChatTranscriptCalls, 5);
          expect(coordinator.chatHydrationError(_chat), timedOut);
          expect(coordinator.chatHydrationError(other), isNull);

          // Retry on the first chat restarts the discovery it inherited.
          coordinator.retryChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 6);
          expect(
            harness.repository.requestChatTranscriptTargets.last.chatId,
            'chat',
          );
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
        });
      });

      test('CAN-4427 Dismiss and reopening act on the load that failed', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = discover(harness);
          async.elapse(const Duration(seconds: 60 + 15 + 10));
          harness.summaries = const [summary];
          coordinator.ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 50));
          expect(coordinator.chatHydrationError(_chat), timedOut);
          final notified = harness.notifications;

          // Dismiss hides the discovery's failure without loading.
          coordinator.dismissChatHydrationError(_chat);
          expect(harness.notifications, notified + 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
          coordinator
            ..ensureChatTranscript(_chat)
            ..reopenChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 2);

          // A retry window after the failure, reopening loads it once.
          async.elapse(const Duration(seconds: 15));
          coordinator
            ..reopenChatTranscript(_chat)
            ..reopenChatTranscript(_chat)
            ..ensureChatTranscript(_chat);
          expect(harness.repository.requestChatTranscriptCalls, 3);
          expect(
            harness.repository.requestChatTranscriptTargets.last.chatId,
            'chat',
          );
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);

          // Its own failure, with the same text, shows again.
          async.elapse(const Duration(seconds: 60 + 15 + 60));
          expect(harness.repository.requestChatTranscriptCalls, 4);
          expect(coordinator.chatHydrationError(_chat), timedOut);
        });
      });

      test('another chat opened during discovery loads on its own', () {
        fakeAsync((async) {
          const other = RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            chatId: 'other',
          );
          final harness = _Harness(async);
          final coordinator = discover(harness);
          harness.summaries = const [
            summary,
            RemoteChatSummary(
              chatId: 'other',
              scope: RemoteChatScope.worktree,
              title: 'Other',
            ),
          ];
          coordinator.ensureChatTranscript(other);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          expect(coordinator.isChatTranscriptLoading(other), isTrue);
        });
      });
    });

    test('foreground discovery asks the desktop to pick the chat', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.supportsForegroundChat = true;
        final coordinator = harness.coordinator
          ..ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
        async.flushMicrotasks();
        expect(harness.repository.requestChatTranscriptCalls, 1);
        expect(harness.repository.cachedChatFetches, 0);
        expect(coordinator.isChatHydrationPending, isTrue);
        expect(
          coordinator.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isTrue,
        );

        coordinator.resolveForegroundChat(_worktree);
        expect(
          coordinator.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isFalse,
        );
        coordinator.retryForegroundChat('ws', 'wt');
        expect(harness.repository.requestChatTranscriptCalls, 1);
      });
    });

    test('a tab list baseline is the earliest unresolved request', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 5));
        final coordinator = harness.coordinator;
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        harness.tabListMark = 7;
        coordinator.ensureChatTranscript(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            chatId: 'new',
          ),
        );
        async.flushMicrotasks();
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        expect(
          coordinator.tabListBaselineFor(remoteWorktreeKey('ws', 'other')),
          isNull,
        );

        // A reply that outlives the watchdog, or the automatic retry, still
        // answers the earliest read.
        harness.tabListMark = 9;
        async.elapse(const Duration(seconds: 25));
        expect(harness.repository.requestChatTranscriptCalls, 4);
        expect(coordinator.tabListBaselineFor(_worktree), 3);

        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.tabListBaselineFor(_worktree), 7);
      });
    });

    for (final target in [
      _chat,
      const RemoteStandaloneChatTarget(chatId: 'chat'),
    ]) {
      test(
        '${target.scope.name} snapshot baselines follow each retry command',
        () {
          fakeAsync((async) {
            final repository = _GatedRequestsRepository();
            final harness = _Harness(
              async,
              repository: repository,
              timeout: const Duration(seconds: 2),
            );
            final coordinator = harness.coordinator;
            final chat = remoteChatKeyForTarget(target)!;
            harness.transcriptMark = 3;
            coordinator.ensureChatTranscript(target);
            async.flushMicrotasks();
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'early'),
              3,
            );
            repository.chatRequests.first.complete('first');
            async.flushMicrotasks();
            harness.transcriptMark = 7;
            async.elapse(const Duration(seconds: 2));
            coordinator.retryChatTranscript(target);
            async.flushMicrotasks();
            repository.chatRequests.last.complete('second');
            async.flushMicrotasks();
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'first'),
              3,
            );
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'second'),
              7,
            );
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'unsolicited'),
              isNull,
            );
            coordinator.resolveChatTranscript(chat, commandId: 'second');
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'first'),
              3,
            );
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'second'),
              7,
            );
            coordinator.resolveChatTranscript(chat, commandId: 'first');
            expect(coordinator.transcriptBaselineFor(chat), isNull);
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'second'),
              7,
            );
            coordinator.reset();
            expect(
              coordinator.transcriptBaselineFor(chat, commandId: 'second'),
              isNull,
            );
          });
        },
      );
    }

    test('foreground discovery takes a baseline before its chat is known', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        harness.repository.supportsForegroundChat = true;
        harness.transcriptMark = 4;
        harness.coordinator.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.flushMicrotasks();
        expect(
          harness.coordinator.transcriptBaselineFor(
            _chatKey,
            worktree: _worktree,
          ),
          4,
        );
        expect(
          harness.coordinator.transcriptBaselineFor(
            _chatKey,
            worktree: remoteWorktreeKey('ws', 'other'),
          ),
          isNull,
        );
      });
    });

    test('manual retry retains the baseline for an earlier late reply', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2));
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        async.flushMicrotasks();

        // The first request times out, but its reply can still arrive late.
        async.elapse(const Duration(seconds: 2));
        // A tab opens after the first request but before the user retries.
        harness.tabListMark = 4;
        coordinator.retryChatTranscript(_chat);
        async.flushMicrotasks();
        expect(harness.repository.requestChatTranscriptCalls, 2);
        expect(coordinator.tabListBaselineFor(_worktree), 3);

        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('a second retry reply retains tabs opened after the first reply', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2));
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        async.flushMicrotasks();

        async.elapse(const Duration(seconds: 2));
        harness.tabListMark = 4;
        coordinator.retryChatTranscript(_chat);
        async.flushMicrotasks();
        expect(harness.repository.requestChatTranscriptCalls, 2);

        coordinator.resolveChatTranscript(_chatKey);
        // A new tab arrives before the other request's older reply.
        harness.tabListMark = 5;
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        coordinator.resolveChatTranscript(_chatKey);
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('an outright failed request cannot retain a closed tab', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        repository.chatRequests.single.complete('hydrate-1');
        async.flushMicrotasks();
        harness.tabListMark = 4;

        harness.commands.handleFailed(
          'hydrate-1',
          'Desktop busy',
          projectionSequence: 0,
        );
        // The automatic retry is still due, so no error shows yet.
        expect(coordinator.chatHydrationError(_chat), isNull);
        // A later full snapshot must be able to remove a tab opened and
        // closed after the failed request started.
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('a late failure after timeout retires only its own tab baseline', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(
          async,
          repository: repository,
          timeout: const Duration(seconds: 2),
        );
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        harness.tabListMark = 4;
        coordinator.retryChatTranscript(_chat);
        repository.chatRequests.last.complete('hydrate-2');
        async.flushMicrotasks();
        coordinator.resolveChatTranscript(_chatKey, commandId: 'hydrate-2');
        expect(coordinator.tabListBaselineFor(_worktree), 3);

        repository.chatRequests.first.completeError(Exception('Desktop busy'));
        async.flushMicrotasks();
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('a late command id still registers its definitive failure', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(
          async,
          repository: repository,
          timeout: const Duration(seconds: 2),
        );
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        coordinator.retryChatTranscript(_chat);
        repository.chatRequests.last.complete('hydrate-2');
        async.flushMicrotasks();
        coordinator.resolveChatTranscript(_chatKey, commandId: 'hydrate-2');

        repository.chatRequests.first.complete('hydrate-1');
        async.flushMicrotasks();
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        harness.commands.handleFailed(
          'hydrate-1',
          'Desktop busy',
          projectionSequence: 0,
        );
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test(
      'a snapshot arriving before command submission retires its attempt',
      () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          final coordinator = harness.coordinator;
          harness.tabListMark = 3;
          coordinator.ensureChatTranscript(_chat);
          coordinator.resolveChatTranscript(_chatKey, commandId: 'hydrate-1');
          expect(coordinator.tabListBaselineFor(_worktree), 3);

          repository.chatRequests.single.complete('hydrate-1');
          async.flushMicrotasks();
          expect(coordinator.tabListBaselineFor(_worktree), isNull);
        });
      },
    );

    test('one snapshot retires only its matching overlapping request', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository()
          ..supportsForegroundChat = true;
        final harness = _Harness(async, repository: repository);
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        harness.tabListMark = 4;
        coordinator.ensureChatTranscript(_chat);
        repository.chatRequests.first.complete('foreground');
        repository.chatRequests.last.complete('transcript');
        async.flushMicrotasks();

        // A targeted transcript also resolves foreground discovery, but the
        // foreground request can still return its own stale snapshot later.
        coordinator.resolveChatTranscript(_chatKey, commandId: 'transcript');
        coordinator.resolveForegroundChat(_worktree, commandId: 'transcript');
        harness.tabListMark = 5;
        expect(coordinator.tabListBaselineFor(_worktree), 3);

        coordinator.resolveChatTranscript(_chatKey, commandId: 'foreground');
        coordinator.resolveForegroundChat(_worktree, commandId: 'foreground');
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('manual foreground retry retains the first tab-list baseline', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2))
          ..repository.supportsForegroundChat = true;
        final coordinator = harness.coordinator;
        harness.tabListMark = 3;
        coordinator.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.flushMicrotasks();

        async.elapse(const Duration(seconds: 2));
        harness.tabListMark = 4;
        coordinator.retryForegroundChat('ws', 'wt');
        async.flushMicrotasks();
        expect(harness.repository.requestChatTranscriptCalls, 2);
        expect(coordinator.tabListBaselineFor(_worktree), 3);

        coordinator.resolveForegroundChat(_worktree);
        expect(coordinator.tabListBaselineFor(_worktree), 3);
        coordinator.resolveForegroundChat(_worktree);
        expect(coordinator.tabListBaselineFor(_worktree), isNull);
      });
    });

    test('a known selection opens its transcript instead', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.supportsForegroundChat = true
          ..summaries = const [
            RemoteChatSummary(
              chatId: 'other',
              scope: RemoteChatScope.worktree,
              title: 'Other',
            ),
            RemoteChatSummary(
              chatId: 'chat',
              scope: RemoteChatScope.worktree,
              title: 'Chat',
              active: true,
            ),
          ];
        harness.coordinator.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        expect(harness.coordinator.pendingChatTranscripts, [_chatKey]);
        expect(
          harness.coordinator.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isFalse,
        );
      });
    });

    test('a worktree hydrates once and re-projects on request', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final coordinator = harness.coordinator
          ..ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 1);
        // The engine reads the slices once the snapshot lands (CAN-4875).
        expect(harness.repository.fetchWorktreeStateSlicesCalls, 0);
        expect(coordinator.pendingWorktrees, [_worktree]);
        expect(coordinator.isChatHydrationPending, isFalse);

        coordinator.resolveWorktrees({_worktree}, {_worktree});
        expect(coordinator.pendingWorktrees, isEmpty);
        async.elapse(const Duration(minutes: 5));
        coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        expect(harness.repository.requestWorktreeStateCalls, 1);

        coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          refresh: true,
        );
        coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
          refresh: true,
        );
        expect(harness.repository.requestWorktreeStateCalls, 2);
        expect(coordinator.pendingWorktrees, [_worktree]);
      });
    });

    test('a worktree watchdog releases loading without an error', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2));
        final coordinator = harness.coordinator
          ..ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        async.elapse(const Duration(seconds: 2));
        expect(coordinator.pendingWorktrees, isEmpty);
        expect(harness.notifications, greaterThan(0));
        coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        expect(harness.repository.requestWorktreeStateCalls, 1);
        async.elapse(const Duration(seconds: 13));
        coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        expect(harness.repository.requestWorktreeStateCalls, 2);
      });
    });

    test('a newer activity read wins over a slower earlier one', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlices = {
            'wt': {
              'plans': [
                {'id': 'plan-1'},
              ],
            },
          };
        harness.coordinator.refreshWorktreeActivity(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.flushMicrotasks();
        expect(harness.notifications, 1);
        harness.connected = false;
        harness.coordinator.refreshWorktreeActivity(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.flushMicrotasks();
        expect(harness.repository.fetchWorktreeStateSlicesCalls, 1);
      });
    });

    group('CAN-3631 app background', () {
      void background(_Harness harness) {
        harness.backgrounded = true;
        harness.coordinator.pauseChatLoads();
      }

      void foreground(_Harness harness) {
        harness.backgrounded = false;
        harness.coordinator.resumeChatLoads();
      }

      test('the return gives a paused request a fresh full timeout', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 3));
          background(harness);
          // Hidden and paused both report the background.
          coordinator.pauseChatLoads();
          async.elapse(const Duration(minutes: 5));
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatHydrationPending, isTrue);
          expect(harness.settled, 0);

          foreground(harness);
          async.elapse(const Duration(milliseconds: 59999));
          expect(coordinator.isChatHydrationPending, isTrue);
          // A second return without a background keeps the running timeout.
          coordinator.resumeChatLoads();
          async.elapse(const Duration(milliseconds: 1));
          expect(coordinator.isChatHydrationPending, isFalse);
          expect(harness.settled, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          expect(harness.repository.requestChatTranscriptCalls, 1);
        });
      });

      test('a reply on return resolves the original request', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 3));
          background(harness);
          async.elapse(const Duration(seconds: 65));
          foreground(harness);
          async.elapse(const Duration(seconds: 5));
          coordinator.resolveChatTranscript(_chatKey);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatHydrationPending, isFalse);
          expect(harness.settled, 1);
        });
      });

      test('a retry due in the background goes out once on return', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 65));
          background(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);

          foreground(harness);
          coordinator.resumeChatLoads();
          async.elapse(Duration.zero);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatHydrationPending, isTrue);
          foreground(harness);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 1));
          expect(
            coordinator.chatHydrationError(_chat),
            'The conversation took too long to load. Try again.',
          );
          background(harness);
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 2);
        });
      });

      test('a short background keeps the rest of the retry delay', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          harness.coordinator.ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 65));
          background(harness);
          async.elapse(const Duration(seconds: 5));
          foreground(harness);
          async.elapse(const Duration(seconds: 4));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          async.elapse(const Duration(seconds: 1));
          expect(harness.repository.requestChatTranscriptCalls, 2);
        });
      });

      test('a reply just before the held retry cancels it', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 65));
          background(harness);
          async.elapse(const Duration(minutes: 1));
          foreground(harness);
          coordinator.resolveChatTranscript(_chatKey);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
        });
      });

      test('a request sent in the background is timed from the return', () {
        fakeAsync((async) {
          final harness = _Harness(async)..backgrounded = true;
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(minutes: 5));
          expect(coordinator.isChatHydrationPending, isTrue);
          foreground(harness);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.isChatHydrationPending, isTrue);
          async.elapse(const Duration(seconds: 1));
          expect(coordinator.isChatHydrationPending, isFalse);
          expect(coordinator.chatHydrationError(_chat), isNull);
        });
      });

      test('a failed send in the background holds its retry', () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          background(harness);
          repository.chatRequests.single.completeError(
            const RemoteControlException('Network lost.'),
          );
          async.flushMicrotasks();
          async.elapse(const Duration(minutes: 5));
          expect(repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

          foreground(harness);
          async.elapse(Duration.zero);
          expect(repository.requestChatTranscriptCalls, 2);
        });
      });

      /// Sends the automatic retry, then fails it while the app is in the
      /// background.
      void failRetryInBackground(
        FakeAsync async,
        _Harness harness,
        _GatedRequestsRepository repository,
      ) {
        harness.coordinator.ensureChatTranscript(_chat);
        repository.chatRequests.single.completeError(
          const RemoteControlException('Relay unavailable.'),
        );
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 15));
        expect(repository.requestChatTranscriptCalls, 2);
        background(harness);
        repository.chatRequests.last.completeError(
          const RemoteControlException('Relay still unavailable.'),
        );
        async.flushMicrotasks();
      }

      test('a final failed send in the background waits for the return', () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          failRetryInBackground(async, harness, repository);
          final coordinator = harness.coordinator;
          async.elapse(const Duration(minutes: 5));
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);

          final notifications = harness.notifications;
          foreground(harness);
          async.elapse(Duration.zero);
          expect(
            coordinator.chatHydrationError(_chat),
            'Relay still unavailable.',
          );
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
          expect(harness.notifications, greaterThan(notifications));
          async.elapse(const Duration(minutes: 5));
          expect(repository.requestChatTranscriptCalls, 2);
        });
      });

      test('a reply in the background cancels a held final failure', () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          failRetryInBackground(async, harness, repository);
          final coordinator = harness.coordinator;
          expect(coordinator.chatHydrationError(_chat), isNull);
          coordinator.resolveChatTranscript(_chatKey);
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
          expect(repository.requestChatTranscriptCalls, 2);
        });
      });

      test('chats keep their own deadlines', () {
        fakeAsync((async) {
          const other = RemoteStandaloneChatTarget(chatId: 'other');
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 70));
          coordinator.ensureChatTranscript(other);
          async.elapse(const Duration(seconds: 1));
          background(harness);
          async.elapse(const Duration(minutes: 2));
          foreground(harness);
          async.elapse(Duration.zero);
          // The first chat's retry was due; the other gets a fresh timeout.
          expect(harness.repository.requestChatTranscriptCalls, 3);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.chatHydrationError(other), isNull);
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 1));
          expect(coordinator.chatHydrationError(_chat), isNotNull);
          expect(coordinator.chatHydrationError(other), isNull);
          expect(coordinator.isChatTranscriptLoading(other), isTrue);
        });
      });

      test('foreground discovery is held the same way', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.supportsForegroundChat = true;
          final coordinator = harness.coordinator
            ..ensureForegroundWorktreeChat(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            );
          async.elapse(const Duration(seconds: 3));
          background(harness);
          async.elapse(const Duration(minutes: 5));
          foreground(harness);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
          background(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          foreground(harness);
          async.elapse(Duration.zero);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
          expect(
            coordinator.isWorktreeChatsLoading(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            ),
            isTrue,
          );
        });
      });

      test('a reset drops a held retry', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 65));
          background(harness);
          coordinator.reset();
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
        });
      });

      test('a disconnected return keeps the retry for the next return', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          async.elapse(const Duration(seconds: 65));
          background(harness);
          harness.connected = false;
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          expect(coordinator.isChatHydrationPending, isFalse);

          harness.connected = true;
          background(harness);
          foreground(harness);
          async.elapse(Duration.zero);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          expect(coordinator.chatHydrationError(_chat), isNull);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          async.elapse(const Duration(seconds: 1));
          expect(
            coordinator.chatHydrationError(_chat),
            'The conversation took too long to load. Try again.',
          );
          background(harness);
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 2);
        });
      });

      test('a disconnected return keeps a foreground discovery retry', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.supportsForegroundChat = true;
          final coordinator = harness.coordinator
            ..ensureForegroundWorktreeChat(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            );
          async.elapse(const Duration(seconds: 65));
          background(harness);
          harness.connected = false;
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
          expect(
            coordinator.isWorktreeChatsLoading(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            ),
            isTrue,
          );

          harness.connected = true;
          background(harness);
          foreground(harness);
          async.elapse(Duration.zero);
          expect(harness.repository.requestChatTranscriptCalls, 2);
          async.elapse(const Duration(seconds: 59));
          expect(coordinator.foregroundChatError('ws', 'wt'), isNull);
          async.elapse(const Duration(seconds: 1));
          expect(
            coordinator.foregroundChatError('ws', 'wt'),
            'The conversation took too long to load. Try again.',
          );
        });
      });

      test('a reset drops a retry kept while disconnected', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator..ensureChatTranscript(_chat);
          harness.connected = false;
          async.elapse(const Duration(seconds: 75));
          expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
          coordinator.reset();
          harness.connected = true;
          background(harness);
          foreground(harness);
          async.elapse(const Duration(minutes: 5));
          expect(harness.repository.requestChatTranscriptCalls, 1);
          expect(coordinator.chatHydrationError(_chat), isNull);
          expect(coordinator.isChatTranscriptLoading(_chat), isFalse);
        });
      });

      test('worktree requests keep their watchdog in the background', () {
        fakeAsync((async) {
          final harness = _Harness(async);
          final coordinator = harness.coordinator
            ..ensureWorktreeState(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            );
          background(harness);
          async.elapse(const Duration(seconds: 60));
          expect(coordinator.pendingWorktrees, isEmpty);
        });
      });
    });

    group('session reset', () {
      test(
        'late chat replies and retry timers stay out of the next session',
        () {
          fakeAsync((async) {
            final repository = _GatedRequestsRepository();
            final harness = _Harness(
              async,
              repository: repository,
              retryWindow: const Duration(seconds: 5),
              timeout: const Duration(seconds: 2),
            );
            final coordinator = harness.coordinator
              ..ensureChatTranscript(_chat);
            async.elapse(const Duration(seconds: 2));
            expect(coordinator.chatHydrationError(_chat), isNull);
            expect(coordinator.isChatTranscriptLoading(_chat), isTrue);
            // Retry armed; a second request is in flight when the session ends.
            async.elapse(const Duration(seconds: 5));
            expect(repository.requestChatTranscriptCalls, 2);

            coordinator.reset();
            final notifications = harness.notifications;
            for (final request in repository.chatRequests) {
              request.complete('late-command');
            }
            for (final read in repository.cacheReads) {
              read.complete([_row('stale')]);
            }
            async.flushMicrotasks();
            async.elapse(const Duration(minutes: 5));

            expect(repository.requestChatTranscriptCalls, 2);
            expect(harness.transcripts, isEmpty);
            expect(harness.notifications, notifications);
            expect(coordinator.chatHydrationError(_chat), isNull);
            expect(coordinator.isChatHydrationPending, isFalse);
            // The late command was never claimed: its failure is foreign.
            expect(
              harness.commands.handleFailed(
                'late-command',
                'Desktop busy',
                projectionSequence: 0,
              ),
              isFalse,
            );
          });
        },
      );

      test('a late worktree failure keeps the next session loading', () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          final coordinator = harness.coordinator
            ..ensureWorktreeState(
              workspaceLocalId: 'ws',
              worktreeLocalId: 'wt',
            );
          coordinator.reset();
          coordinator.ensureWorktreeState(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
          expect(repository.requestWorktreeStateCalls, 2);

          repository.worktreeRequests.first.completeError(
            const RemoteControlException('late'),
          );
          async.flushMicrotasks();
          expect(coordinator.pendingWorktrees, [_worktree]);
        });
      });

      test('a late worktree reply reads no activity into the next session', () {
        fakeAsync((async) {
          final repository = _GatedRequestsRepository();
          final harness = _Harness(async, repository: repository);
          harness.coordinator.ensureWorktreeState(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
          harness.coordinator.reset();
          repository.worktreeRequests.single.complete();
          async.flushMicrotasks();
          expect(repository.fetchWorktreeStateSlicesCalls, 0);
        });
      });

      test('a late activity read does not overwrite the next session', () {
        fakeAsync((async) {
          final repository = _GatedActivityRepository();
          final harness = _Harness(async, repository: repository);
          harness.coordinator.refreshWorktreeActivity(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          );
          harness.coordinator.reset();
          repository.gate.complete();
          async.flushMicrotasks();
          expect(harness.notifications, 0);
        });
      });

      test('dispose cancels watchdogs and warming', () {
        fakeAsync((async) {
          final harness = _Harness(async, timeout: const Duration(seconds: 2))
            ..repository.supportsWorktreeChatSummariesScope = true;
          harness.coordinator
            ..ensureChatTranscript(_chat)
            ..ensureChatSummariesIndex(background: true)
            ..dispose();
          async.elapse(const Duration(minutes: 5));
          expect(harness.notifications, 0);
          expect(harness.repository.requestWorktreeChatSummariesStateCalls, 0);
        });
      });
    });
  });

  group('CAN-3102 summary hydration', () {
    test('summary timeout pauses while backgrounded and resumes on return', () {
      fakeAsync((async) {
        final harness = _Harness(async, timeout: const Duration(seconds: 2));
        harness.repository.supportsWorktreeChatSummariesScope = true;
        final coordinator = harness.coordinator;
        coordinator.ensureChatSummariesIndex();
        async.flushMicrotasks();
        harness.backgrounded = true;
        coordinator.pauseChatLoads();
        async.elapse(const Duration(minutes: 2));
        expect(coordinator.chatSummariesError, isNull);
        expect(coordinator.isChatSummariesLoading, isTrue);
        harness.backgrounded = false;
        coordinator.resumeChatLoads();
        async.elapse(const Duration(seconds: 2));
        expect(coordinator.chatSummariesError, isNotNull);
        coordinator.dispose();
      });
    });

    test(
      'failure stays visible during warming and explicit retry recovers',
      () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..supportsWorktreeChatSummariesScope = true
            ..requestWorktreeChatSummariesHandler = () async {
              throw const RemoteControlException('transport detail');
            };
          final vm = RemoteControlViewModel(repository: repo);
          vm.connect('123456');
          async.flushMicrotasks();
          vm.ensureChatSummariesIndex();
          async.flushMicrotasks();
          expect(
            vm.chatSummariesError,
            "Couldn't load chats from your desktop.",
          );
          expect(vm.isChatSummariesLoading, isFalse);
          async.elapse(const Duration(minutes: 2));
          for (var i = 0; i < 20; i++) {
            vm.ensureChatSummariesIndex(background: true);
          }
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestWorktreeChatSummariesStateCalls, 1);

          repo.requestWorktreeChatSummariesHandler = null;
          vm.retryChatSummariesIndex();
          vm.retryChatSummariesIndex();
          async.flushMicrotasks();
          expect(repo.requestWorktreeChatSummariesStateCalls, 2);
          expect(vm.isChatSummariesLoading, isTrue);
          expect(vm.chatSummariesError, isNull);
          repo.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(scope: 'worktree_chat_summaries'),
              ],
              nextCursor: 1,
            ),
          );
          async.flushMicrotasks();
          expect(vm.isChatSummariesLoading, isFalse);
          expect(vm.chatSummariesError, isNull);
          async.elapse(const Duration(minutes: 2));
          expect(vm.chatSummariesError, isNull);
          vm.dispose();
        });
      },
    );

    test('missing summary reply times out and retry stays single-flight', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true;
        final vm = RemoteControlViewModel(
          repository: repo,
          hydrationTimeout: const Duration(seconds: 2),
        );
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        expect(vm.isChatSummariesLoading, isTrue);
        async.elapse(const Duration(seconds: 2));
        expect(vm.isChatSummariesLoading, isFalse);
        expect(vm.chatSummariesError, isNotNull);
        vm.retryChatSummariesIndex();
        vm.refresh();
        async.flushMicrotasks();
        expect(repo.requestWorktreeChatSummariesStateCalls, 2);
        vm.disconnect();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 2));
        expect(vm.chatSummariesError, isNull);
        expect(vm.isChatSummariesLoading, isFalse);
        vm.dispose();
      });
    });

    test('manual refresh reloads an accepted empty summary index', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true;
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(scope: 'worktree_chat_summaries'),
            ],
            nextCursor: 1,
          ),
        );
        async.flushMicrotasks();
        vm.refresh();
        async.flushMicrotasks();
        expect(repo.requestWorktreeChatSummariesStateCalls, 2);
        expect(repo.requestWorktreeStateCalls, 0);
        vm.dispose();
      });
    });

    for (final fail in [false, true]) {
      test('cold request retries without fan-out (failure: $fail)', () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..supportsWorktreeChatSummariesScope = true;
          if (fail) {
            repo.requestWorktreeChatSummariesHandler = () async {
              throw const RemoteControlException('offline');
            };
          }
          final vm = RemoteControlViewModel(
            repository: repo,
            clock: () => DateTime(2026).add(async.elapsed),
            hydrationTimeout: const Duration(seconds: 2),
            hydrationRetryWindow: const Duration(seconds: 3),
          );
          vm.connect('123456');
          async.flushMicrotasks();
          for (var i = 0; i < 20; i++) {
            vm.ensureChatSummariesIndex(background: true);
          }
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestWorktreeChatSummariesStateCalls, 1);
          vm.ensureChatSummariesIndex(background: true);
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestWorktreeChatSummariesStateCalls, 1);
          async.elapse(const Duration(seconds: 2));
          vm.ensureChatSummariesIndex();
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestWorktreeChatSummariesStateCalls, 2);
          expect(repo.requestWorktreeStateCalls, 0);
          vm.dispose();
        });
      });
    }

    test('pending summary submission stays single-flight past watchdog', () {
      fakeAsync((async) {
        final request = Completer<void>();
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true
          ..requestWorktreeChatSummariesHandler = () => request.future;
        final vm = RemoteControlViewModel(
          repository: repo,
          clock: () => DateTime(2026).add(async.elapsed),
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: Duration.zero,
        );
        vm.connect('123456');
        async.flushMicrotasks();

        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);

        async.elapse(const Duration(seconds: 10));
        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);

        request.complete();
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex();
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);

        async.elapse(const Duration(seconds: 2));
        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        expect(repo.requestWorktreeChatSummariesStateCalls, 2);
        vm.dispose();
      });
    });

    test(
      'cold foreground discovery yields no full snapshot or overview read',
      () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..supportsForegroundChat = true
            ..supportsWorktreeChatSummariesScope = true;
          final vm = RemoteControlViewModel(repository: repo);
          vm.connect('123456');
          async.flushMicrotasks();
          final reads = repo.snapshotFetches;
          vm.ensureChatSummariesIndex(background: true);
          vm.ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          );
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestChatTranscriptCalls, 1);
          expect(repo.requestWorktreeStateCalls, 0);
          expect(repo.requestWorktreeChatSummariesStateCalls, 0);
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isTrue,
          );
          repo.eventsController.add(
            const RemotePortalEventBatch(
              events: [
                RemoteStateSnapshotEvent(
                  scope: 'chat',
                  targetWorkspaceLocalId: 'ws-1',
                  targetWorktreeLocalId: 'wt-1',
                ),
              ],
              nextCursor: 1,
            ),
          );
          async.flushMicrotasks();
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isFalse,
          );
          vm.ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          );
          expect(repo.requestChatTranscriptCalls, 1);
          expect(repo.snapshotFetches, reads);
          async.elapse(const Duration(seconds: 1));
          expect(repo.requestWorktreeChatSummariesStateCalls, 1);
          vm.dispose();
        });
      },
    );

    test(
      'foreground discovery ignores a same-id worktree in another workspace',
      () async {
        final repo = _RecordingChatHydrationRepository()
          ..supportsForegroundChat = true
          ..snapshotBuilder = () => const RemoteSessionSnapshot(
            workspaces: [],
            worktrees: [],
            standaloneChats: [],
            chatSummaries: [
              RemoteChatSummary(
                chatId: 'foreign-chat',
                scope: RemoteChatScope.worktree,
                workspaceLocalId: 'ws-2',
                worktreeLocalId: 'wt-1',
                title: 'Foreign chat',
                active: true,
              ),
            ],
          );
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');

        vm.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        await Future<void>.delayed(Duration.zero);

        expect(repo.requestedChatTargets, hasLength(1));
        expect(
          repo.requestedChatTargets.single,
          isA<RemoteWorktreeChatTarget>()
              .having((target) => target.workspaceLocalId, 'workspace', 'ws-1')
              .having((target) => target.worktreeLocalId, 'worktree', 'wt-1')
              .having((target) => target.chatId, 'chat', isNull),
        );
        vm.dispose();
      },
    );

    test(
      'foreground snapshots remove stale tabs only from their target',
      () async {
        final repo = FakeRemoteControlRepository();
        repo.snapshotBuilder = () => const RemoteSessionSnapshot(
          workspaces: [],
          worktrees: [],
          standaloneChats: [],
          chatSummaries: [
            RemoteChatSummary(
              chatId: 'removed',
              title: 'Removed',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            RemoteChatSummary(
              chatId: 'sibling',
              title: 'Sibling',
              scope: RemoteChatScope.worktree,
              workspaceLocalId: 'ws-2',
              worktreeLocalId: 'wt-1',
            ),
          ],
        );
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                selectedChatOnly: true,
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(vm.allChatSummaries.map((s) => s.chatId), ['sibling']);
        expect(repo.snapshotFetches, 1);
        vm.dispose();
      },
    );

    test(
      'foreground discovery preserves the retry window after its watchdog',
      () {
        fakeAsync((async) {
          final repo = FakeRemoteControlRepository()
            ..supportsForegroundChat = true;
          final vm = RemoteControlViewModel(
            repository: repo,
            hydrationTimeout: const Duration(seconds: 2),
            hydrationRetryWindow: const Duration(seconds: 5),
            clock: () => DateTime(2026).add(async.elapsed),
          );
          vm.connect('123456');
          async.flushMicrotasks();
          void open() => vm.ensureForegroundWorktreeChat(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
          );
          open();
          async.flushMicrotasks();
          open();
          expect(repo.requestChatTranscriptCalls, 1);
          async.elapse(const Duration(seconds: 3));
          open();
          expect(repo.requestChatTranscriptCalls, 1);
          // CAN-3631: still loading while the automatic retry is due.
          expect(
            vm.isWorktreeChatsLoading(
              workspaceLocalId: 'ws-1',
              worktreeLocalId: 'wt-1',
            ),
            isTrue,
          );
          expect(vm.foregroundChatError('ws-1', 'wt-1'), isNull);
          async.elapse(const Duration(seconds: 4));
          expect(repo.requestChatTranscriptCalls, 2);
          expect(repo.requestWorktreeStateCalls, 0);
          vm.dispose();
        });
      },
    );

    test(
      'a cold drawer re-reads activity after its snapshot arrives',
      () async {
        final repo = FakeRemoteControlRepository()
          ..worktreeStateSlicesRefreshing = true;
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        expect(repo.fetchWorktreeStateSlicesCalls, 1);
        repo.worktreeStateSlicesRefreshing = false;
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree',
                targetWorkspaceLocalId: 'ws-1',
                targetWorktreeLocalId: 'wt-1',
              ),
            ],
            nextCursor: 1,
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(repo.fetchWorktreeStateSlicesCalls, 2);
        vm.dispose();
      },
    );

    test(
      'worktree activity keeps its identity until its inputs change',
      () async {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        await vm.connect('123456');
        final first = vm.worktreeActivityFor('wt-1');
        expect(vm.worktreeActivityFor('wt-1'), same(first));

        repo.worktreeStateSlices = {
          'wt-1': {
            'plans': [
              {'worktreeLocalId': 'wt-1', 'title': 'Plan', 'status': 'draft'},
            ],
          },
        };
        await vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        final refreshed = vm.worktreeActivityFor('wt-1');
        expect(refreshed, isNot(same(first)));
        expect(refreshed.plans.single.title, 'Plan');
        expect(vm.worktreeActivityFor('wt-1'), same(refreshed));
        vm.dispose();
      },
    );

    test('warming yields to a foreground chat, then merges without a read', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true;
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        final reads = repo.snapshotFetches;
        vm.ensureChatSummariesIndex(background: true);
        vm.ensureChatTranscript(
          const RemoteWorktreeChatTarget(
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            chatId: 'chat-1',
          ),
        );
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestChatTranscriptCalls, 1);
        expect(repo.requestWorktreeChatSummariesStateCalls, 0);
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'chat',
                targetChatId: 'chat-1',
                targetChatScope: RemoteChatScope.worktree,
              ),
            ],
            nextCursor: 1,
          ),
        );
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(
                scope: 'worktree_chat_summaries',
                chatSummaries: [
                  RemoteChatSummary(
                    chatId: 'chat-1',
                    scope: RemoteChatScope.worktree,
                    workspaceLocalId: 'ws-1',
                    worktreeLocalId: 'wt-1',
                    title: 'Ready',
                  ),
                ],
              ),
            ],
            nextCursor: 2,
          ),
        );
        async.flushMicrotasks();
        expect(
          vm
              .chatSummariesFor(
                workspaceLocalId: 'ws-1',
                worktreeLocalId: 'wt-1',
              )
              .single
              .title,
          'Ready',
        );
        async.elapse(const Duration(minutes: 2));
        vm.ensureChatSummariesIndex();
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);
        expect(repo.snapshotFetches, reads);
        vm.dispose();
      });
    });

    test('warming waits for a drawer read and accepts an empty batch', () {
      fakeAsync((async) {
        final repo = _GatedActivityRepository()
          ..supportsWorktreeChatSummariesScope = true;
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex(background: true);
        vm.refreshWorktreeActivity(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestWorktreeChatSummariesStateCalls, 0);
        repo.gate.complete();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);
        repo.eventsController.add(
          const RemotePortalEventBatch(
            events: [
              RemoteStateSnapshotEvent(scope: 'worktree_chat_summaries'),
            ],
            nextCursor: 1,
          ),
        );
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 2));
        vm.ensureChatSummariesIndex();
        expect(repo.requestWorktreeChatSummariesStateCalls, 1);
        vm.dispose();
      });
    });

    test('disconnect cancels queued warming', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true;
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex(background: true);
        vm.disconnect();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestWorktreeChatSummariesStateCalls, 0);
        vm.dispose();
      });
    });

    test('old session failure cannot unlock a new session request', () {
      fakeAsync((async) {
        final oldRequest = Completer<void>();
        final repo = FakeRemoteControlRepository()
          ..supportsWorktreeChatSummariesScope = true
          ..requestWorktreeChatSummariesHandler = () => oldRequest.future;
        final vm = RemoteControlViewModel(
          repository: repo,
          clock: () => DateTime(2026).add(async.elapsed),
        );
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex();
        vm.disconnect();
        async.flushMicrotasks();
        vm.connect('123456');
        async.flushMicrotasks();
        repo.requestWorktreeChatSummariesHandler = null;
        vm.ensureChatSummariesIndex();
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 20));
        oldRequest.completeError(const RemoteControlException('old failure'));
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex();
        expect(repo.requestWorktreeChatSummariesStateCalls, 2);
        vm.dispose();
      });
    });

    test('unsupported hosts retain on-demand worktree navigation', () {
      fakeAsync((async) {
        final repo = FakeRemoteControlRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatSummariesIndex(background: true);
        async.elapse(const Duration(seconds: 1));
        expect(repo.requestWorktreeChatSummariesStateCalls, 0);
        vm.ensureWorktreeState(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        expect(repo.requestWorktreeStateCalls, 1);
        vm.dispose();
        async.flushMicrotasks();
      });
    });
  });

  group('CAN-4427 seeded hydration lifecycle', () {
    // Random action sequences over two chats in one worktree. Each step
    // checks the lifecycle invariants; a failure names its seed and trace.
    for (final seed in [4427, 3631, 17, for (var i = 0; i < 200; i++) i]) {
      test('seed $seed keeps every failure with its own chat', () {
        fakeAsync((async) {
          _LifecycleRun(async, Random(seed)).run(steps: 40);
        });
      });
    }

    test('the reported active-tab handoff stays a regression', () {
      fakeAsync((async) {
        _LifecycleRun(async, Random(0)).replay([
          'discover',
          'elapse:60',
          'elapse:15',
          'elapse:60',
          'name:a',
          'ensure:a',
          'name:b',
          'ensure:b',
        ]);
      });
    });

    test('the first failing seed stays a regression', () {
      fakeAsync((async) {
        // Seed 190 before dismiss, reopen, live and recovery steps existed:
        // the unbound discovery's failure moved to the newly active tab.
        _LifecycleRun(async, Random(0)).replay([
          'discover',
          'ensure:a',
          'ensure:a',
          'elapse:60',
          'elapse:30',
          'snapshot:a',
          'elapse:60',
          'name:b',
        ]);
      });
    });
  });

  group('hydration across a session reset', () {
    test('an old worktree failure cannot clear the new request', () {
      fakeAsync((async) {
        final repo = _GatedRequestsRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        vm.disconnect();
        async.flushMicrotasks();
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        expect(repo.requestWorktreeStateCalls, 2);

        repo.worktreeRequests.first.completeError(
          const RemoteControlException('late'),
        );
        async.flushMicrotasks();
        expect(
          vm.isWorktreeChatsLoading(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
          isTrue,
        );
        vm.dispose();
      });
    });

    test('an old worktree reply reads no activity into the new session', () {
      fakeAsync((async) {
        final repo = _GatedRequestsRepository();
        final vm = RemoteControlViewModel(repository: repo);
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureWorktreeState(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        vm.disconnect();
        async.flushMicrotasks();
        vm.connect('123456');
        async.flushMicrotasks();

        repo.worktreeRequests.single.complete();
        async.flushMicrotasks();
        expect(repo.fetchWorktreeStateSlicesCalls, 0);
        vm.dispose();
      });
    });

    test('an old chat retry and cached tail stay out of the new session', () {
      fakeAsync((async) {
        final repo = _GatedRequestsRepository();
        final vm = RemoteControlViewModel(
          repository: repo,
          hydrationTimeout: const Duration(seconds: 2),
          hydrationRetryWindow: const Duration(seconds: 5),
        );
        vm.connect('123456');
        async.flushMicrotasks();
        vm.ensureChatTranscript(_chat);
        async.elapse(const Duration(seconds: 2));
        expect(vm.chatHydrationError(_chat), isNull);
        expect(vm.isChatTranscriptLoading(_chat), isTrue);

        vm.disconnect();
        async.flushMicrotasks();
        vm.connect('123456');
        async.flushMicrotasks();
        repo.cacheReads.single.complete([_row('stale')]);
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 1));

        expect(repo.requestChatTranscriptCalls, 1);
        expect(vm.messagesFor(_chat), isEmpty);
        expect(vm.chatHydrationError(_chat), isNull);
        vm.dispose();
      });
    });
  });

  group('CAN-3644 changed-file load', () {
    const loading = ChangedFilesLoadStatus.loading;
    const loaded = ChangedFilesLoadStatus.loaded;
    const failed = ChangedFilesLoadStatus.failed(kChangedFilesLoadFailed);
    const timedOut = ChangedFilesLoadStatus.failed(kChangedFilesTimedOut);

    Map<String, dynamic> slices(List<String> paths) => {
      'changedFiles': {
        'wt': {
          'uncommitted': [
            for (final path in paths) {'filePath': path, 'status': 'modified'},
          ],
          'committed': const <Map<String, dynamic>>[],
        },
      },
    };

    void open(_Harness harness) => harness.coordinator.refreshChangedFiles(
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
    );

    /// The desktop's projection lands, and the engine's follow-up read goes
    /// out, as `_refreshAfterSnapshot` does.
    void land(_Harness harness) {
      harness.coordinator.markWorktreesProjected([_worktree]);
      unawaited(
        harness.coordinator.refreshWorktreeActivity(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        ),
      );
    }

    /// The engine's follow-up clears the pending worktree request once the
    /// read after the snapshot lands, as `_refreshAfterSnapshot` does.
    void resolve(_Harness harness) =>
        harness.coordinator.resolveWorktrees({_worktree}, {_worktree});

    /// A follow-up the engine deferred: the read, then the resolution.
    void followUp(_Harness harness) => unawaited(() async {
      await harness.coordinator.refreshWorktreeActivity(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
      );
      resolve(harness);
    }());

    ChangedFilesLoadStatus status(_Harness harness) =>
        harness.coordinator.changedFilesStatus('wt');

    List<String> files(_Harness harness) => [
      for (final file
          in harness.coordinator.worktreeActivityFor('wt').changedFiles)
        file.filePath,
    ];

    // CAN-4875: the server cache cannot answer before the projection lands,
    // so the load reads nothing until the snapshot signals it.
    test('nothing is read before the projection lands', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 1);
        expect(harness.repository.fetchWorktreeStateSlicesCalls, 0);
        expect(status(harness), loading);

        harness.repository.worktreeStateSlices = {
          'wt': slices(['lib/a.dart']),
        };
        final before = harness.notifications;
        land(harness);
        async.flushMicrotasks();
        expect(harness.repository.fetchWorktreeStateSlicesCalls, 1);
        expect(status(harness), loaded);
        expect(files(harness), ['lib/a.dart']);
        expect(harness.notifications, greaterThan(before));
      });
    });

    test('a settled empty projection is a confirmed empty list', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);
        expect(files(harness), isEmpty);
      });
    });

    test('a refreshing read after the projection loads until the deadline', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlicesRefreshing = true;
        open(harness);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loading);
        async.elapse(const Duration(seconds: 59));
        expect(status(harness), loading);
        final before = harness.notifications;
        async.elapse(const Duration(seconds: 1));
        expect(status(harness), timedOut);
        expect(harness.notifications, greaterThan(before));
      });
    });

    test('a projection that never lands times out, and Retry reloads', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.elapse(const Duration(seconds: 61));
        expect(status(harness), timedOut);

        final before = harness.notifications;
        open(harness);
        expect(status(harness), loading);
        expect(harness.notifications, before + 1);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 2);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);
      });
    });

    test('a failed projection request fails the load at once', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository();
        final harness = _Harness(async, repository: repository);
        open(harness);
        async.flushMicrotasks();
        final before = harness.notifications;
        repository.worktreeRequests.single.completeError(
          const RemoteControlException('relay refused'),
        );
        async.flushMicrotasks();
        expect(status(harness), failed);
        // The failure notifies; so does the cache read that follows it.
        expect(harness.notifications, greaterThan(before));
      });
    });

    // CAN-4875 device run: with the desktop unreachable on the first open,
    // the Activity tab showed "No local changes" next to the Files error.
    // A failed projection with nothing held reads the server cache once;
    // the cache still confirms nothing, so the load stays failed.
    test('a failed first projection reads the cached activity once', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository()
          ..worktreeStateSlices = {
            'wt': slices(['lib/a.dart']),
          };
        final harness = _Harness(async, repository: repository);
        open(harness);
        async.flushMicrotasks();
        expect(repository.fetchWorktreeStateSlicesCalls, 0);
        repository.worktreeRequests.single.completeError(
          const RemoteControlException('relay refused'),
        );
        async.flushMicrotasks();
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(files(harness), ['lib/a.dart']);
        expect(status(harness), failed);
      });
    });

    test('a failed projection keeps held activity without a read', () {
      fakeAsync((async) {
        final repository = _GatedRequestsRepository()
          ..worktreeStateSlices = {
            'wt': slices(['lib/a.dart']),
          };
        final harness = _Harness(async, repository: repository);
        open(harness);
        async.flushMicrotasks();
        repository.worktreeRequests.single.complete();
        land(harness);
        async.flushMicrotasks();
        resolve(harness);
        expect(repository.fetchWorktreeStateSlicesCalls, 1);

        open(harness);
        async.flushMicrotasks();
        repository.worktreeRequests.last.completeError(
          const RemoteControlException('relay refused'),
        );
        async.flushMicrotasks();
        expect(repository.fetchWorktreeStateSlicesCalls, 1);
        expect(files(harness), ['lib/a.dart']);
        expect(status(harness), failed);
      });
    });

    test('only a read failure after the projection fails the load', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlicesFailures = 2;
        open(harness);
        async.flushMicrotasks();
        expect(status(harness), loading);

        harness.repository.worktreeStateSlicesFailures = 1;
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), failed);
      });
    });

    test('a late authoritative read recovers a timed-out load', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.elapse(const Duration(seconds: 61));
        expect(status(harness), timedOut);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);
      });
    });

    test('cached files stay while refreshing; a settled empty result '
        'replaces them', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlices = {
            'wt': slices(['lib/a.dart']),
          };
        open(harness);
        land(harness);
        async.flushMicrotasks();
        resolve(harness);
        expect(files(harness), ['lib/a.dart']);

        // Reopening: the server cache still holds the old roster until the
        // next projection lands, and a failing refresh keeps it too.
        open(harness);
        async.flushMicrotasks();
        expect(status(harness), loading);
        expect(files(harness), ['lib/a.dart']);

        harness.repository.worktreeStateSlices = {'wt': slices(const [])};
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);
        expect(files(harness), isEmpty);
      });
    });

    // The server cache can change before the reopened drawer's projection
    // lands. An eager read of it confirms nothing, so it must not replace
    // the list already shown, while loading or after the load failed.
    for (final eager in [
      const <String>[],
      ['lib/b.dart'],
    ]) {
      final roster = eager.isEmpty ? 'an empty' : 'a different';
      test('$roster eager roster keeps cached files until a timeout and '
          'Retry settle the projected roster', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.worktreeStateSlices = {
              'wt': slices(['lib/a.dart']),
            };
          open(harness);
          land(harness);
          async.flushMicrotasks();
          resolve(harness);
          expect(files(harness), ['lib/a.dart']);

          harness.repository.worktreeStateSlices = {'wt': slices(eager)};
          open(harness);
          async.flushMicrotasks();
          expect(status(harness), loading);
          expect(files(harness), ['lib/a.dart']);

          async.elapse(harness.timeout);
          expect(status(harness), timedOut);
          expect(files(harness), ['lib/a.dart']);

          open(harness);
          async.flushMicrotasks();
          expect(status(harness), loading);
          expect(files(harness), ['lib/a.dart']);

          land(harness);
          async.flushMicrotasks();
          expect(status(harness), loaded);
          expect(files(harness), eager);
        });
      });

      test('$roster eager roster keeps cached files when the read after the '
          'projection fails', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.worktreeStateSlices = {
              'wt': slices(['lib/a.dart']),
            };
          open(harness);
          land(harness);
          async.flushMicrotasks();
          resolve(harness);

          harness.repository.worktreeStateSlices = {'wt': slices(eager)};
          open(harness);
          async.flushMicrotasks();
          harness.repository.worktreeStateSlicesFailures = 1;
          land(harness);
          async.flushMicrotasks();
          expect(status(harness), failed);
          expect(files(harness), ['lib/a.dart']);

          // A later read of the same projection is authoritative.
          land(harness);
          async.flushMicrotasks();
          expect(status(harness), loaded);
          expect(files(harness), eager);
        });
      });
    }

    // CAN-4875: a reopening reads nothing before its projection lands, so
    // the held slices stay until the read after the landing replaces them.
    test('a reopening keeps the held slices until its projection is read', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlices = {
            'wt': slices(['lib/a.dart']),
          };
        open(harness);
        land(harness);
        async.flushMicrotasks();
        resolve(harness);

        harness.repository.worktreeStateSlices = {
          'wt': {
            ...slices(const []),
            'plans': [
              {'worktreeLocalId': 'wt', 'title': 'Ship it', 'status': 'open'},
            ],
          },
        };
        open(harness);
        async.flushMicrotasks();
        expect(harness.repository.fetchWorktreeStateSlicesCalls, 1);
        expect(status(harness), loading);
        expect(files(harness), ['lib/a.dart']);
        expect(harness.coordinator.worktreeActivityFor('wt').plans, isEmpty);

        land(harness);
        async.flushMicrotasks();
        final activity = harness.coordinator.worktreeActivityFor('wt');
        expect(status(harness), loaded);
        expect(files(harness), isEmpty);
        expect([for (final plan in activity.plans) plan.title], ['Ship it']);
      });
    });

    // A worktree request without a Files load (a push tap, or a chat opened
    // on an older host) can land before Files opens. The engine's follow-up
    // may wait for chat hydration, so the request is still pending when the
    // load starts and joins it. Reads after that landing answer the load.
    for (final projected in [
      const <String>[],
      ['lib/b.dart'],
    ]) {
      final roster = projected.isEmpty ? 'an empty' : 'a new';
      test('a load that joins a request whose projection already landed '
          'settles $roster roster without waiting for the deadline', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.worktreeStateSlices = {
              'wt': slices(['lib/a.dart']),
            };
          open(harness);
          land(harness);
          async.flushMicrotasks();
          resolve(harness);
          expect(files(harness), ['lib/a.dart']);

          harness.coordinator.ensureWorktreeState(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            refresh: true,
          );
          async.flushMicrotasks();
          expect(harness.repository.requestWorktreeStateCalls, 2);
          harness.repository.worktreeStateSlices = {'wt': slices(projected)};
          // The snapshot lands with no Files load; the follow-up is deferred.
          harness.coordinator.markWorktreesProjected([_worktree]);

          open(harness);
          async.flushMicrotasks();
          // Single flight: the load joined the pending request.
          expect(harness.repository.requestWorktreeStateCalls, 2);

          followUp(harness);
          async.flushMicrotasks();
          expect(status(harness), loaded);
          expect(files(harness), projected);
          async.elapse(harness.timeout * 2);
          expect(status(harness), loaded);
          expect(files(harness), projected);
        });
      });
    }

    test('a landing that the session reset discarded cannot answer a load '
        'of the next session', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlices = {
            'wt': slices(['stale/never_projected.dart']),
          };
        harness.coordinator.ensureWorktreeState(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
        async.flushMicrotasks();
        harness.coordinator
          ..markWorktreesProjected([_worktree])
          ..reset();

        open(harness);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 2);
        unawaited(
          harness.coordinator.refreshWorktreeActivity(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
        );
        async.flushMicrotasks();
        expect(status(harness), loading);
      });
    });

    // A refreshing read after a landing lets the engine clear the request
    // while the load still waits. Reopening sends a new request, and only
    // its projection can settle the load: an eager read before it keeps
    // the held roster and the loading state.
    for (final eager in [
      const <String>[],
      ['lib/c.dart'],
    ]) {
      final roster = eager.isEmpty ? 'an empty' : 'a different';
      test('a reopening after a refreshing read waits for its own projection; '
          '$roster eager roster keeps the held files', () {
        fakeAsync((async) {
          final harness = _Harness(async)
            ..repository.worktreeStateSlices = {
              'wt': slices(['lib/a.dart']),
            };
          open(harness);
          land(harness);
          async.flushMicrotasks();
          resolve(harness);

          open(harness);
          async.flushMicrotasks();
          harness.repository
            ..worktreeStateSlicesRefreshing = true
            ..worktreeStateSlices = {
              'wt': slices(['lib/b.dart']),
            };
          land(harness);
          async.flushMicrotasks();
          resolve(harness);
          expect(status(harness), loading);
          expect(files(harness), ['lib/a.dart']);

          harness.repository
            ..worktreeStateSlicesRefreshing = false
            ..worktreeStateSlices = {'wt': slices(eager)};
          open(harness);
          async.flushMicrotasks();
          expect(harness.repository.requestWorktreeStateCalls, 3);
          expect(status(harness), loading);
          expect(files(harness), ['lib/a.dart']);

          // Single flight: another opening joins the pending request.
          open(harness);
          async.flushMicrotasks();
          expect(harness.repository.requestWorktreeStateCalls, 3);
          expect(status(harness), loading);
          expect(files(harness), ['lib/a.dart']);

          harness.repository.worktreeStateSlices = {
            'wt': slices(['lib/d.dart']),
          };
          land(harness);
          async.flushMicrotasks();
          expect(status(harness), loaded);
          expect(files(harness), ['lib/d.dart']);
        });
      });
    }

    test('a reopening after a refreshing read keeps the load\'s deadline', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlices = {
            'wt': slices(['lib/a.dart']),
          };
        open(harness);
        land(harness);
        async.flushMicrotasks();
        resolve(harness);

        final started = async.elapsed;
        open(harness);
        async.flushMicrotasks();
        harness.repository.worktreeStateSlicesRefreshing = true;
        land(harness);
        async.flushMicrotasks();
        resolve(harness);

        async.elapse(const Duration(seconds: 20));
        harness.repository
          ..worktreeStateSlicesRefreshing = false
          ..worktreeStateSlices = {'wt': slices(const [])};
        open(harness);
        async.flushMicrotasks();
        expect(status(harness), loading);

        async.elapse(
          started +
              harness.timeout -
              async.elapsed -
              const Duration(milliseconds: 1),
        );
        expect(status(harness), loading);
        async.elapse(const Duration(milliseconds: 1));
        expect(status(harness), timedOut);
        expect(files(harness), ['lib/a.dart']);
      });
    });

    test('an older post-projection read does not overwrite a newer one', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.flushMicrotasks();
        final gate = Completer<void>();
        harness.repository
          ..worktreeStateSlicesGate = gate
          ..worktreeStateSlices = {
            'wt': slices(['lib/old.dart']),
          };
        land(harness);
        harness.repository.worktreeStateSlices = {
          'wt': slices(['lib/new.dart']),
        };
        land(harness);
        gate.complete();
        async.flushMicrotasks();
        expect(status(harness), loaded);
        expect(files(harness), ['lib/new.dart']);
      });
    });

    test('a read of a discarded session cannot settle the next one', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.flushMicrotasks();
        final gate = Completer<void>();
        harness.repository
          ..worktreeStateSlicesGate = gate
          ..worktreeStateSlices = {
            'wt': slices(['lib/stale.dart']),
          };
        land(harness);
        harness.coordinator.reset();
        final before = harness.notifications;
        gate.complete();
        async.flushMicrotasks();
        async.elapse(const Duration(minutes: 2));
        expect(harness.notifications, before);
        expect(files(harness), isEmpty);
        expect(status(harness), isNot(loaded));
      });
    });

    test('a pipeline-only read cannot settle the Files tab', () {
      fakeAsync((async) {
        final harness = _Harness(async)
          ..repository.worktreeStateSlicesGate = Completer<void>()
          ..repository.worktreePipelineSlices = {
            'wt': {'pipelines': const <Object>[]},
          };
        open(harness);
        harness.coordinator
          ..markWorktreesProjected([_worktree])
          ..ensurePipelineRuns(workspaceLocalId: 'ws', worktreeLocalId: 'wt');
        async.flushMicrotasks();
        expect(harness.repository.fetchWorktreePipelineSlicesCalls, 1);
        expect(status(harness), loading);
      });
    });

    test('without a connection only a loaded list stands', () {
      fakeAsync((async) {
        final harness = _Harness(async)..connected = false;
        open(harness);
        expect(status(harness), ChangedFilesLoadStatus.offline);
        expect(status(harness).canRetry, isFalse);
        expect(harness.repository.requestWorktreeStateCalls, 0);

        harness.connected = true;
        open(harness);
        land(harness);
        async.flushMicrotasks();
        harness.connected = false;
        expect(status(harness), loaded);
      });
    });

    void ensure(_Harness harness) => harness.coordinator.ensureChangedFiles(
      workspaceLocalId: 'ws',
      worktreeLocalId: 'wt',
    );

    test('a reset leaves Files idle until the open drawer ensures a bounded '
        'load', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);

        harness.coordinator.reset();
        expect(status(harness), ChangedFilesLoadStatus.idle);
        final requests = harness.repository.requestWorktreeStateCalls;
        final before = harness.notifications;
        ensure(harness);
        // Called from a build: no synchronous notify.
        expect(harness.notifications, before);
        expect(status(harness), loading);
        expect(harness.repository.requestWorktreeStateCalls, requests + 1);

        async.elapse(harness.timeout);
        expect(status(harness), timedOut);
      });
    });

    test('ensure starts one load per session and leaves Retry to the user', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        ensure(harness);
        ensure(harness);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 1);
        expect(status(harness), loading);

        async.elapse(harness.timeout);
        expect(status(harness), timedOut);
        ensure(harness);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 1);
        expect(status(harness), timedOut);

        open(harness);
        land(harness);
        async.flushMicrotasks();
        expect(status(harness), loaded);
        ensure(harness);
        async.flushMicrotasks();
        expect(harness.repository.requestWorktreeStateCalls, 2);
      });
    });

    test('ensure requests nothing without a connection', () {
      fakeAsync((async) {
        final harness = _Harness(async)..connected = false;
        ensure(harness);
        expect(harness.repository.requestWorktreeStateCalls, 0);
        expect(status(harness), ChangedFilesLoadStatus.offline);
        expect(status(harness).canRetry, isFalse);
        harness.connected = true;
        expect(status(harness), ChangedFilesLoadStatus.idle);
        ensure(harness);
        expect(status(harness), loading);
      });
    });

    test('dispose cancels the load deadline', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        open(harness);
        async.flushMicrotasks();
        harness.coordinator.dispose();
        final before = harness.notifications;
        async.elapse(const Duration(minutes: 2));
        expect(harness.notifications, before);
      });
    });

    // Focused seeded state-machine pass. Each seed drives a random sequence
    // of drawer openings, open-drawer rebuilds (ensure), worktree requests
    // without a Files load, projection landings (with a new desktop roster)
    // whose follow-up runs at once or later, server-cache changes without a
    // landing, refreshing or failing reads, failed requests, connection
    // changes, time and session resets, checking after every step:
    //  * loading always belongs to a started load within its deadline,
    //    including after a session reset;
    //  * a load settles only with a roster that a landing of the latest
    //    projection request put in the server cache, never an eager read;
    //  * once the latest request's projection landed and a settled read
    //    went out after it, a started load is loaded, not stuck loading;
    //  * while loading or failed, the last loaded list of the session stays
    //    shown: only a settled read after a projection replaces it;
    //  * a reset clears files and status, and nothing notifies afterwards
    //    until the next request;
    //  * without a connection nothing reads as loading;
    //  * Retry is offered only by a connected failure, never offline.
    // A failing seed is printed with its step log; keep it as a regression.
    for (var seed = 0; seed < 200; seed++) {
      test('seeded transitions keep load invariants (seed $seed)', () {
        fakeAsync((async) {
          final random = Random(seed);
          final repository = _FlakyProjectionRepository();
          final harness = _Harness(async, repository: repository);
          final log = <String>[];
          var roster = 0;
          // The pre-projection server cache holds a roster that never came
          // from a landing of this session.
          repository.worktreeStateSlices = {
            'wt': slices(['stale/never_projected.dart']),
          };
          Duration? loadStarted;
          // Rosters that landings since the latest request put in the cache.
          final landedRosters = <String>{};
          // Reads issued before the latest request's projection first landed.
          int? landedAtRead;
          var requests = 0;
          var followUpDeferred = false;
          List<String>? lastLoaded;
          var previous = ChangedFilesLoadStatus.idle;

          void check() {
            final now = async.elapsed;
            final current = status(harness);
            final reason = 'seed $seed: ${log.join(', ')}';
            if (!harness.connected) {
              expect(
                current.phase,
                isNot(ChangedFilesLoadPhase.loading),
                reason: reason,
              );
            }
            // Retry is offered exactly when it can start a load.
            expect(
              current.canRetry,
              harness.connected &&
                  current.phase == ChangedFilesLoadPhase.failed,
              reason: reason,
            );
            if (current == loading) {
              expect(loadStarted, isNotNull, reason: reason);
              expect(
                now - loadStarted! < harness.timeout,
                isTrue,
                reason: reason,
              );
            }
            final read = repository.lastRead;
            if (harness.connected &&
                current.phase != ChangedFilesLoadPhase.idle &&
                landedAtRead != null &&
                read != null &&
                read.settled &&
                read.index > landedAtRead) {
              expect(current, loaded, reason: 'stuck: $reason');
            }
            if (current == loaded) {
              final shown = files(harness);
              if (previous != loaded) {
                expect(
                  shown,
                  isNot(contains('stale/never_projected.dart')),
                  reason: reason,
                );
                expect(
                  landedRosters,
                  contains(shown.join('|')),
                  reason: reason,
                );
              }
              lastLoaded = shown;
            } else if (lastLoaded case final cached?
                when current.phase != ChangedFilesLoadPhase.idle) {
              expect(files(harness), cached, reason: reason);
            }
            previous = current;
          }

          for (var step = 0; step < 40; step++) {
            final op = random.nextInt(13);
            switch (op) {
              case 0 || 1:
                log.add('open');
                final wasLoading = status(harness) == loading;
                open(harness);
                if (harness.connected && !wasLoading) {
                  loadStarted = async.elapsed;
                }
              case 9:
                log.add('ensure');
                final wasIdle = status(harness) == ChangedFilesLoadStatus.idle;
                ensure(harness);
                if (harness.connected && wasIdle) {
                  loadStarted = async.elapsed;
                }
              case 11:
                log.add('request');
                harness.coordinator.ensureWorktreeState(
                  workspaceLocalId: 'ws',
                  worktreeLocalId: 'wt',
                  refresh: true,
                );
              case 2:
                roster += 1;
                final paths = [
                  for (var i = 0; i < random.nextInt(3); i++)
                    'lib/r${roster}_$i.dart',
                ];
                final deferred = random.nextBool();
                log.add('land(${paths.length}${deferred ? ', deferred' : ''})');
                repository.worktreeStateSlices = {'wt': slices(paths)};
                landedRosters.add(paths.join('|'));
                if (harness.connected) {
                  landedAtRead ??= repository.fetchWorktreeStateSlicesCalls;
                  harness.coordinator.markWorktreesProjected([_worktree]);
                  if (deferred) {
                    followUpDeferred = true;
                  } else {
                    followUp(harness);
                  }
                }
              case 12 when followUpDeferred && harness.connected:
                log.add('followUp');
                followUpDeferred = false;
                followUp(harness);
              case 12:
                log.add('followUp skipped');
              // The server cache changes before the latest request's
              // projection lands; after a landing, a new roster comes with its
              // own projection.
              case 10 when landedRosters.isEmpty:
                roster += 1;
                final paths = [
                  for (var i = 0; i < random.nextInt(3); i++)
                    'lib/c${roster}_$i.dart',
                ];
                log.add('cache(${paths.length})');
                repository.worktreeStateSlices = {'wt': slices(paths)};
              case 10:
                log.add('cache skipped');
              case 3:
                final refreshing = random.nextBool();
                log.add('refreshing=$refreshing');
                repository.worktreeStateSlicesRefreshing = refreshing;
              case 4:
                log.add('readFails');
                repository.worktreeStateSlicesFailures += 1;
              case 5:
                log.add('requestFails');
                repository.failNextRequest = true;
              case 6:
                final seconds = random.nextInt(40);
                log.add('wait ${seconds}s');
                async.elapse(Duration(seconds: seconds));
              case 7:
                harness.connected = !harness.connected;
                log.add('connected=${harness.connected}');
              case 8:
                log.add('reset');
                harness.coordinator.reset();
                repository
                  ..worktreeStateSlices = {
                    'wt': slices(['stale/never_projected.dart']),
                  }
                  ..lastRead = null;
                landedRosters.clear();
                landedAtRead = null;
                followUpDeferred = false;
                loadStarted = null;
                lastLoaded = null;
                async.flushMicrotasks();
                final before = harness.notifications;
                expect(files(harness), isEmpty, reason: 'seed $seed');
                expect(status(harness), isNot(loaded), reason: 'seed $seed');
                expect(status(harness), isNot(loading), reason: 'seed $seed');
                async.elapse(const Duration(minutes: 2));
                expect(
                  harness.notifications,
                  before,
                  reason: 'seed $seed: ${log.join(', ')}',
                );
            }
            async.flushMicrotasks();
            // A new request makes earlier landings stale.
            if (repository.requestWorktreeStateCalls != requests) {
              requests = repository.requestWorktreeStateCalls;
              landedRosters.clear();
              landedAtRead = null;
            }
            check();
          }
          harness.coordinator.dispose();
        });
      });
    }
  });

  // CAN-4875: hook pause and resume answer with `portal.hook.event`
  // descriptor upserts instead of an overview read.
  group('CAN-4875 hook descriptor events', () {
    Map<String, dynamic> hook({bool paused = false, String key = 'lint'}) => {
      'workspaceLocalId': 'ws',
      'worktreeLocalId': 'wt',
      'hookKey': key,
      'name': 'Hook $key',
      'paused': paused,
    };

    RemoteHookDescriptorEvent upsert(
      Map<String, dynamic> row, {
      String worktree = 'wt',
    }) => RemoteHookDescriptorEvent(
      workspaceLocalId: 'ws',
      worktreeLocalId: worktree,
      hookKey: row['hookKey'] as String,
      descriptor: {...row, 'worktreeLocalId': worktree},
    );

    List<(String, bool)> hooks(_Harness harness) => [
      for (final hook
          in harness.coordinator.worktreeActivityFor('wt').hookDescriptors)
        (hook.hookKey, hook.paused),
    ];

    /// Loads the worktree's slices with [rows] as its hooks.
    void load(_Harness harness, List<Map<String, dynamic>> rows) {
      harness.repository.worktreeStateSlices = {
        'wt': {'hookDescriptors': rows},
      };
      unawaited(
        harness.coordinator.refreshWorktreeActivity(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        ),
      );
      harness.async.flushMicrotasks();
    }

    test('an upsert or removal patches the held hooks in place', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        load(harness, [hook(), hook(key: 'test')]);
        expect(hooks(harness), [('lint', false), ('test', false)]);

        expect(
          harness.coordinator.applyHookDescriptor(upsert(hook(paused: true))),
          isTrue,
        );
        expect(hooks(harness), [('lint', true), ('test', false)]);
        harness.coordinator.applyHookDescriptor(upsert(hook(key: 'new')));
        expect(hooks(harness), [
          ('lint', true),
          ('test', false),
          ('new', false),
        ]);
        harness.coordinator.applyHookDescriptor(
          const RemoteHookDescriptorEvent(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
            hookKey: 'test',
          ),
        );
        expect(hooks(harness), [('lint', true), ('new', false)]);
      });
    });

    test('another worktree, or no held slices, changes nothing', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        expect(
          harness.coordinator.applyHookDescriptor(upsert(hook(paused: true))),
          isFalse,
        );
        expect(hooks(harness), isEmpty);
        load(harness, [hook()]);
        expect(
          harness.coordinator.applyHookDescriptor(
            upsert(hook(paused: true), worktree: 'other'),
          ),
          isFalse,
        );
        expect(hooks(harness), [('lint', false)]);
      });
    });

    test('a read issued before the event keeps the event, a later read '
        'replaces it', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        load(harness, [hook()]);
        // A read goes out with the old projection, then the pause lands.
        final gate = harness.repository.worktreeStateSlicesGate =
            Completer<void>();
        harness.repository.worktreeStateSlices = {
          'wt': {
            'hookDescriptors': [hook()],
            'plans': [
              {'worktreeLocalId': 'wt', 'title': 'Ship it', 'status': 'open'},
            ],
          },
        };
        unawaited(
          harness.coordinator.refreshWorktreeActivity(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
        );
        async.flushMicrotasks();
        harness.coordinator.applyHookDescriptor(upsert(hook(paused: true)));
        harness.repository.worktreeStateSlicesGate = null;
        gate.complete();
        async.flushMicrotasks();
        final activity = harness.coordinator.worktreeActivityFor('wt');
        expect(hooks(harness), [('lint', true)]);
        expect([for (final plan in activity.plans) plan.title], ['Ship it']);

        // A read issued after the event is the newer authority.
        harness.repository.worktreeStateSlices = {
          'wt': {
            'hookDescriptors': [hook()],
          },
        };
        unawaited(
          harness.coordinator.refreshWorktreeActivity(
            workspaceLocalId: 'ws',
            worktreeLocalId: 'wt',
          ),
        );
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', false)]);
      });
    });

    RemoteHookDescriptorEvent removal(String key, {String workspace = 'ws'}) =>
        RemoteHookDescriptorEvent(
          workspaceLocalId: workspace,
          worktreeLocalId: 'wt',
          hookKey: key,
        );

    /// [row]'s upsert from [workspace], whose worktree reuses the id 'wt'.
    RemoteHookDescriptorEvent foreign(
      Map<String, dynamic> row, {
      String workspace = 'ws-b',
    }) => RemoteHookDescriptorEvent(
      workspaceLocalId: workspace,
      worktreeLocalId: 'wt',
      hookKey: row['hookKey'] as String,
      descriptor: {...row, 'workspaceLocalId': workspace},
    );

    /// Issues a read for ws/wt whose reply holds until the returned gate.
    Completer<void> holdRead(
      _Harness harness,
      List<Map<String, dynamic>> rows,
    ) {
      harness.repository.worktreeStateSlices = {
        'wt': {'hookDescriptors': rows},
      };
      final gate = harness.repository.worktreeStateSlicesGate =
          Completer<void>();
      unawaited(
        harness.coordinator.refreshWorktreeActivity(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        ),
      );
      harness.async.flushMicrotasks();
      harness.repository.worktreeStateSlicesGate = null;
      return gate;
    }

    test('an event from another workspace with the same worktree id '
        'changes nothing', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        load(harness, [hook(), hook(key: 'test')]);

        expect(
          harness.coordinator.applyHookDescriptor(foreign(hook(paused: true))),
          isFalse,
        );
        harness.coordinator.applyHookDescriptor(
          removal('test', workspace: 'ws-b'),
        );
        harness.coordinator.applyHookDescriptor(foreign(hook(key: 'new')));
        expect(hooks(harness), [('lint', false), ('test', false)]);
      });
    });

    test('a held read keeps no foreign event', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        load(harness, [hook()]);
        final gate = holdRead(harness, [hook(), hook(key: 'test')]);
        harness.coordinator.applyHookDescriptor(foreign(hook(paused: true)));
        harness.coordinator.applyHookDescriptor(
          removal('test', workspace: 'ws-b'),
        );
        gate.complete();
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', false), ('test', false)]);
      });
    });

    test('a first read held across a foreign event keeps its own hooks', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final gate = holdRead(harness, [hook(), hook(key: 'test')]);
        harness.coordinator.applyHookDescriptor(foreign(hook(paused: true)));
        harness.coordinator.applyHookDescriptor(
          removal('test', workspace: 'ws-b'),
        );
        harness.coordinator.applyHookDescriptor(foreign(hook(key: 'new')));
        gate.complete();
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', false), ('test', false)]);
      });
    });

    test('a first read held across an upsert shows the upsert', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final gate = holdRead(harness, [hook()]);
        expect(hooks(harness), isEmpty);
        harness.coordinator.applyHookDescriptor(upsert(hook(paused: true)));
        harness.coordinator.applyHookDescriptor(upsert(hook(key: 'new')));
        gate.complete();
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', true), ('new', false)]);
      });
    });

    test('a first read held across a removal drops the hook', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final gate = holdRead(harness, [hook(), hook(key: 'test')]);
        harness.coordinator.applyHookDescriptor(removal('test'));
        gate.complete();
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', false)]);
      });
    });

    test('a session reset drops events held for a first read', () {
      fakeAsync((async) {
        final harness = _Harness(async);
        final gate = holdRead(harness, [hook()]);
        harness.coordinator.applyHookDescriptor(upsert(hook(paused: true)));
        harness.coordinator.applyHookDescriptor(removal('test'));
        harness.coordinator.reset();
        // The next session's first read answers without the old events.
        final next = holdRead(harness, [hook(), hook(key: 'test')]);
        gate.complete();
        next.complete();
        async.flushMicrotasks();
        expect(hooks(harness), [('lint', false), ('test', false)]);
      });
    });

    // Focused seeded pass over held reads. Each seed issues reads whose
    // replies hold and release in any order, hook upserts and removals for
    // this worktree and for another workspace's worktree with the same id,
    // failing reads and session resets. The desktop's hooks change with
    // each own event, and a read's reply is fixed when it starts. After
    // every step, once a read of this session settled, the shown hooks are
    // the desktop's current hooks: no stale read undoes a newer event, and
    // no foreign event shows. A failing seed prints its step log.
    for (var seed = 0; seed < 200; seed++) {
      test('seeded held reads keep hook events (seed $seed)', () {
        fakeAsync((async) {
          final random = Random(seed);
          final harness = _Harness(async);
          final log = <String>[];
          const keys = ['lint', 'test', 'deploy'];
          // The desktop's hooks for ws/wt, in row order.
          var truth = <String, bool>{'lint': false, 'test': false};
          List<Map<String, dynamic>> rows() => [
            for (final MapEntry(:key, :value) in truth.entries)
              hook(key: key, paused: value),
          ];
          final held = <({Completer<void> gate, int session})>[];
          var session = 0;
          var loaded = false;

          void check() {
            if (!loaded) return;
            expect(hooks(harness), [
              for (final MapEntry(:key, :value) in truth.entries) (key, value),
            ], reason: 'seed $seed: ${log.join(', ')}');
          }

          for (var step = 0; step < 40; step++) {
            switch (random.nextInt(7)) {
              case 0 || 1:
                final fails = random.nextInt(4) == 0;
                log.add(fails ? 'read(fails)' : 'read');
                if (fails) harness.repository.worktreeStateSlicesFailures += 1;
                held.add((gate: holdRead(harness, rows()), session: session));
              case 2 when held.isNotEmpty:
                final index = random.nextInt(held.length);
                final read = held.removeAt(index);
                log.add('release($index)');
                read.gate.complete();
              case 3:
                final key = keys[random.nextInt(keys.length)];
                if (truth.containsKey(key) && random.nextBool()) {
                  log.add('remove $key');
                  truth = {...truth}..remove(key);
                  harness.coordinator.applyHookDescriptor(removal(key));
                } else {
                  final paused = random.nextBool();
                  log.add('upsert $key paused=$paused');
                  truth = {...truth, key: paused};
                  harness.coordinator.applyHookDescriptor(
                    upsert(hook(key: key, paused: paused)),
                  );
                }
              case 4:
                final key = keys[random.nextInt(keys.length)];
                log.add('foreign $key');
                harness.coordinator.applyHookDescriptor(
                  random.nextBool()
                      ? removal(key, workspace: 'ws-b')
                      : foreign(hook(key: key, paused: random.nextBool())),
                );
              case 5 when random.nextInt(4) == 0:
                log.add('reset');
                harness.coordinator.reset();
                session += 1;
                loaded = false;
              default:
                log.add('flush');
            }
            async.flushMicrotasks();
            // A read settles the shown hooks once the latest read of this
            // session answered without failing.
            if (!loaded &&
                harness.coordinator
                    .worktreeActivityFor('wt')
                    .hookDescriptors
                    .isNotEmpty) {
              loaded = true;
            }
            check();
          }
          for (final read in held) {
            read.gate.complete();
          }
          async.flushMicrotasks();
          check();
          harness.coordinator.dispose();
        });
      });
    }
  });
}

/// The fake repository, whose next projection request can be made to fail.
final class _FlakyProjectionRepository extends FakeRemoteControlRepository {
  bool failNextRequest = false;

  /// The latest slice read: its call number, and whether it answers with a
  /// settled result rather than a refreshing cache or a failure.
  ({int index, bool settled})? lastRead;

  @override
  Future<({Map<String, dynamic> slices, bool refreshing})>
  fetchWorktreeStateSlices({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) {
    lastRead = (
      index: fetchWorktreeStateSlicesCalls + 1,
      settled:
          !worktreeStateSlicesRefreshing && worktreeStateSlicesFailures == 0,
    );
    return super.fetchWorktreeStateSlices(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await super.requestWorktreeState(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
    if (failNextRequest) {
      failNextRequest = false;
      throw const RemoteControlException('relay refused');
    }
  }
}

/// One seeded run of [HydrationCoordinator] lifecycle actions over chats
/// `a` and `b` in one worktree.
///
/// Invariants, checked after every step:
/// - Only elapsed time can make a chat start showing an error: naming,
///   selecting, opening, retrying or resetting never moves a failure onto
///   another chat.
/// - Opening a chat that shows an error sends nothing, so rebuilds cannot
///   start a retry cycle.
/// - In the background, time neither sends a request nor shows an error.
/// - A matching snapshot, Dismiss, or a live row clears the chat's error,
///   and only its error; a reset or recovered connection clears every error.
/// - A recovered connection sends a failed discovery again when no chat is
///   known.
/// - Once idle for ten minutes, nothing is requested in the next ten.
final class _LifecycleRun {
  _LifecycleRun(this.async, this.random) : harness = _Harness(async) {
    harness.repository.supportsForegroundChat = true;
  }

  final FakeAsync async;
  final Random random;
  final _Harness harness;
  final trace = <String>[];

  static const _chats = ['a', 'b'];
  static const _elapses = [1, 5, 15, 30, 60];

  static RemoteWorktreeChatTarget _target(String chatId) =>
      RemoteWorktreeChatTarget(
        workspaceLocalId: 'ws',
        worktreeLocalId: 'wt',
        chatId: chatId,
      );

  HydrationCoordinator get coordinator => harness.coordinator;
  int get requests => harness.repository.requestChatTranscriptCalls;

  Map<String, String?> _errors() => {
    for (final chat in _chats)
      chat: coordinator.chatHydrationError(_target(chat)),
  };

  String _pick() {
    final chat = _chats[random.nextInt(_chats.length)];
    return switch (random.nextInt(13)) {
      0 || 1 => 'discover',
      2 || 3 => 'name:$chat',
      4 => 'unname',
      5 || 6 => 'ensure:$chat',
      7 || 8 => 'elapse:${_elapses[random.nextInt(_elapses.length)]}',
      9 => harness.backgrounded ? 'foreground' : 'background',
      10 => random.nextBool() ? 'snapshot:$chat' : 'retry:$chat',
      11 => switch (random.nextInt(4)) {
        0 => 'dismiss:$chat',
        1 => 'reopen:$chat',
        2 => 'live:$chat',
        _ => 'recover',
      },
      _ => random.nextInt(4) == 0 ? 'reset' : 'elapse:60',
    };
  }

  void run({required int steps}) {
    for (var i = 0; i < steps; i++) {
      _step(_pick());
    }
    _settle();
  }

  void replay(List<String> actions) {
    actions.forEach(_step);
    _settle();
  }

  void _step(String action) {
    trace.add(action);
    final reason = 'trace: ${trace.join(' ')}';
    final before = _errors();
    final requestsBefore = requests;
    final discoveryFailed = coordinator.foregroundChatError('ws', 'wt') != null;
    final [verb, ...args] = action.split(':');
    final chat = args.firstOrNull;
    switch (verb) {
      case 'discover':
        coordinator.ensureForegroundWorktreeChat(
          workspaceLocalId: 'ws',
          worktreeLocalId: 'wt',
        );
      case 'name':
        harness.summaries = [
          for (final id in _chats)
            RemoteChatSummary(
              chatId: id,
              scope: RemoteChatScope.worktree,
              title: id,
              active: id == chat,
            ),
        ];
      case 'unname':
        harness.summaries = [];
      case 'ensure':
        coordinator.ensureChatTranscript(_target(chat!));
      case 'elapse':
        async.elapse(Duration(seconds: int.parse(chat!)));
      case 'background':
        harness.backgrounded = true;
        coordinator.pauseChatLoads();
      case 'foreground':
        harness.backgrounded = false;
        coordinator.resumeChatLoads();
      case 'snapshot':
        // As in the engine, a chat's snapshot also answers the worktree's
        // discovery.
        final key = (scope: RemoteChatScope.worktree, chatId: chat!);
        coordinator
          ..resolveChatTranscript(key)
          ..resolveForegroundChat(_worktree, chat: key);
      case 'retry':
        coordinator.retryChatTranscript(_target(chat!));
      case 'dismiss':
        coordinator.dismissChatHydrationError(_target(chat!));
      case 'reopen':
        coordinator.reopenChatTranscript(_target(chat!));
      case 'live':
        coordinator.clearChatHydrationError((
          scope: RemoteChatScope.worktree,
          chatId: chat!,
        ));
      case 'recover':
        coordinator.restartFailedChatLoads();
      case 'reset':
        coordinator.reset();
      default:
        fail('unknown action $action');
    }
    async.flushMicrotasks();
    final after = _errors();
    if (verb != 'elapse') {
      for (final id in _chats) {
        if (before[id] == null) {
          expect(after[id], isNull, reason: 'error appeared on $id; $reason');
        }
      }
    }
    if (verb == 'ensure' && before[chat] != null) {
      expect(requests, requestsBefore, reason: 'rebuild retried; $reason');
    }
    if (verb == 'elapse' && harness.backgrounded) {
      expect(requests, requestsBefore, reason: 'background request; $reason');
      expect(after, before, reason: 'background error; $reason');
    }
    if (verb case 'snapshot' || 'dismiss' || 'live') {
      expect(after[chat], isNull, reason: '$verb kept error; $reason');
      for (final id in _chats.where((id) => id != chat)) {
        expect(after[id], before[id], reason: '$verb cleared $id; $reason');
      }
    }
    if (verb case 'reset' || 'recover') {
      expect(after.values.nonNulls, isEmpty, reason: '$verb kept; $reason');
    }
    // With no chat known, no rebuild can load one: the discovery goes out
    // again by itself.
    if (verb == 'recover' && discoveryFailed && harness.summaries.isEmpty) {
      expect(requests, requestsBefore + 1, reason: 'no discovery; $reason');
    }
  }

  void _settle() {
    if (harness.backgrounded) _step('foreground');
    async.elapse(const Duration(minutes: 10));
    final settled = requests;
    async.elapse(const Duration(minutes: 10));
    expect(
      requests,
      settled,
      reason: 'requests kept going; trace: ${trace.join(' ')}',
    );
  }
}
