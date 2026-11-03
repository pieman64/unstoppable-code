import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';

void main() {
  group('shouldQueueTurnFeedbackFailure', () {
    test('queues transport failures', () {
      expect(
        shouldQueueTurnFeedbackFailure(Exception('socket closed')),
        isTrue,
      );
    });

    test('queues 5xx, 401, 408 and 429', () {
      for (final status in <int>[500, 502, 401, 408, 429]) {
        expect(
          shouldQueueTurnFeedbackFailure(
            ApiException(statusCode: status, body: ''),
          ),
          isTrue,
          reason: 'status $status should be retried',
        );
      }
    });

    test('does NOT queue a deliberate client rejection', () {
      // A 400/403/404 will fail identically on every retry. Queueing it burns
      // the outbox slot forever and hides the real problem.
      for (final status in <int>[400, 403, 404, 409, 413]) {
        expect(
          shouldQueueTurnFeedbackFailure(
            ApiException(statusCode: status, body: ''),
          ),
          isFalse,
          reason: 'status $status should not be retried',
        );
      }
    });

    test('the generic retry classifier excludes successful-response decode '
        'failures', () {
      // A FormatException here comes from `jsonDecode`/`fromJson` on a 2xx
      // body: the request reached the server and the server ACCEPTED it, so
      // the write already landed. Retrying re-sends a write that succeeded,
      // and the identical body decodes identically forever, so the entry
      // could never leave the queue. `rate` handles this signal separately as
      // accepted-but-unconfirmed and performs best-effort reconciliation.
      expect(
        shouldQueueTurnFeedbackFailure(
          const FormatException('Unrecognized turn feedback rating'),
        ),
        isFalse,
      );
    });

    test('still queues a genuine transport failure alongside that rule', () {
      // The other branch of the same decision: a socket error never reached a
      // server that could have accepted anything, so it must still retry.
      expect(shouldQueueTurnFeedbackFailure(Exception('broken pipe')), isTrue);
    });
  });

  group('HttpTurnFeedbackRepository outbox behavior', () {
    const summaryJson = <String, dynamic>{
      'feedbackId': 'fb-1',
      'clientUserMessageId': 'msg-1',
      'rating': 'down',
      'hasComment': false,
    };

    // Every entry the repository queues is stamped with the account that
    // authored it, so the fixtures below seed entries under [accountA] and
    // build the repository signed in as the same account unless a test is
    // specifically exercising the cross-account rules.
    const accountA = 'acct-a';
    const accountB = 'acct-b';

    HttpTurnFeedbackRepository build(
      MockClient client,
      FeedbackOutboxStore outbox, {
      String? Function()? accountId,
      DateTime Function()? now,
      Duration? requestTimeout,
      Duration? storeTimeout,
    }) => HttpTurnFeedbackRepository(
      service: TurnFeedbackApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      ),
      outbox: outbox,
      accountId: accountId ?? () => accountA,
      now: now ?? () => DateTime.fromMillisecondsSinceEpoch(1757000000000),
      requestTimeout: requestTimeout ?? const Duration(seconds: 30),
      storeTimeout: storeTimeout ?? const Duration(seconds: 5),
    );

    // `_runWrite` serializes every write against one turn, so a second VERB
    // can no longer be in flight beside the first. The concurrent writer that
    // remains is the durable store itself: `flushOutbox` replays out of it
    // without taking a turn's write slot. Seeding a row WHILE A REQUEST IS
    // OPEN is that writer, and is the level at which the ordering guards below
    // still apply.
    //
    // Note what this is NOT modelling: a queue left by a previous run of the
    // app. Those rows are already in the store before this run issues any
    // sequence, and `_readLocked` raises the counter past them first, so they
    // are always strictly older than anything a write here would store. The
    // seeds below are deliberately mid-request for that reason.
    FeedbackOutboxEntry seeded({
      required FeedbackOutboxKind kind,
      required int seq,
      String turn = 'msg-1',
      String? account = accountA,
      TurnFeedbackRating? rating,
      String? feedbackId,
      TurnFeedbackReason? reason,
      String? comment,
      int queuedAtMs = 1757000000000,
    }) => FeedbackOutboxEntry(
      kind: kind,
      clientUserMessageId: turn,
      clientChatId: 'chat-1',
      accountId: account,
      rating: rating,
      feedbackId: feedbackId,
      reason: reason,
      comment: comment,
      queuedAtMs: queuedAtMs,
      seq: seq,
    );

    test('rate against a 503 returns synced:false and leaves exactly one entry '
        'in the outbox', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(result.synced, isFalse);
      final entries = await outbox.read();
      expect(entries, hasLength(1));
      expect(entries.single.clientUserMessageId, 'msg-1');
      expect(entries.single.clientChatId, 'chat-1');
      expect(entries.single.kind, FeedbackOutboxKind.rate);
      expect(entries.single.rating, TurnFeedbackRating.down);
    });

    test(
      'rate against a 400 returns synced:false and leaves the outbox empty',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        final client = MockClient((request) async => http.Response('', 400));
        final repo = build(client, outbox);

        final result = await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );

        expect(result.synced, isFalse);
        expect(await outbox.read(), isEmpty);
      },
    );

    test('flushOutbox after the server recovers replays the queued rating and '
        'empties the outbox', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        if (callCount == 1) return http.Response('', 503);
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final first = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(first.synced, isFalse);
      expect(await outbox.read(), hasLength(1));

      await repo.flushOutbox();

      expect(callCount, 2);
      expect(await outbox.read(), isEmpty);
    });

    test('clear for a turn whose rate is still queued empties the outbox and '
        'issues no HTTP call', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[
        const FeedbackOutboxEntry(
          kind: FeedbackOutboxKind.rate,
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          accountId: accountA,
          rating: TurnFeedbackRating.down,
          queuedAtMs: 1757000000000,
          // Older than every stamp this test issues — see `queuedRateFor`.
          seq: 0,
        ),
      ]);
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        return http.Response('', 200);
      });
      final repo = build(client, outbox);

      final cleared = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );

      expect(cleared.synced, isTrue);
      expect(await outbox.read(), isEmpty);
      expect(callCount, 0);
    });

    test("a queued rating's context fields survive the flush and reach "
        'service.rate', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      late http.Request replayedRequest;
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        if (callCount == 1) return http.Response('', 503);
        replayedRequest = request;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(
          provider: 'claude',
          model: 'claude-opus-4',
          chatMode: 'canopy',
          appVersion: '1.2.3',
          eventType: 'worktree_chat',
        ),
      );

      await repo.flushOutbox();

      expect(callCount, 2);
      expect(jsonDecode(replayedRequest.body), <String, dynamic>{
        'clientUserMessageId': 'msg-1',
        'clientChatId': 'chat-1',
        'rating': 'down',
        'provider': 'claude',
        'model': 'claude-opus-4',
        'chatMode': 'canopy',
        'appVersion': '1.2.3',
        'eventType': 'worktree_chat',
      });
    });

    test(
      'a rate that queues while a flush is mid-network survives the flush',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        // Close to (but distinct from) the fixed clock `build()` uses for
        // newly queued entries below, so pruneFeedbackOutbox's 14-day age
        // check does not drop this seed entry before the flush even starts.
        await outbox.write(<FeedbackOutboxEntry>[
          const FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: 'msg-a',
            clientChatId: 'chat-1',
            accountId: accountA,
            rating: TurnFeedbackRating.down,
            queuedAtMs: 1757000000000 - 5000,
            // Seeded as pre-existing: sequence 0 is older than every stamp the
            // repository will issue in this test, so an ordering bound can never
            // spare this entry by accident. See [FeedbackOutboxEntry.seq].
            seq: 0,
          ),
        ]);

        final aRequestReceived = Completer<void>();
        final releaseA = Completer<void>();
        final client = MockClient((request) async {
          final body = jsonDecode(request.body);
          if (body is Map && body['clientUserMessageId'] == 'msg-a') {
            aRequestReceived.complete();
            await releaseA.future;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'feedbackId': 'fb-a',
                'clientUserMessageId': 'msg-a',
                'rating': 'down',
                'hasComment': false,
              }),
              200,
            );
          }
          // msg-b: simulate offline so rate() queues it instead of syncing.
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        // Start the flush but do not await it yet: it will block mid-network
        // on msg-a's request until releaseA completes below.
        final flush = repo.flushOutbox();
        await aRequestReceived.future;

        // While the flush is still mid-network for msg-a, a brand new rating
        // for a different turn queues. This must NOT be lost when the flush
        // finishes and writes back its (now stale) snapshot.
        final bResult = await repo.rate(
          clientUserMessageId: 'msg-b',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        expect(bResult.synced, isFalse);

        releaseA.complete();
        await flush;

        final remaining = await outbox.read();
        expect(remaining, hasLength(1));
        expect(remaining.single.clientUserMessageId, 'msg-b');
      },
    );

    test('attachDetail against a 503 with a known feedbackId queues a detail '
        'entry, and flushOutbox replays it', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      var callCount = 0;
      late http.Request replayedRequest;
      final client = MockClient((request) async {
        callCount += 1;
        if (callCount == 1) return http.Response('', 503);
        replayedRequest = request;
        return http.Response('', 200);
      });
      final repo = build(client, outbox);

      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      final queued = await outbox.read();
      expect(queued, hasLength(1));
      expect(queued.single.kind, FeedbackOutboxKind.detail);
      expect(queued.single.feedbackId, 'fb-1');
      expect(queued.single.reason, TurnFeedbackReason.gotStuck);
      expect(queued.single.comment, 'looped forever');
      // A `detail` entry never carries a rating: attachDetail() never
      // receives one, so there is nothing correct to invent.
      expect(queued.single.rating, isNull);

      await repo.flushOutbox();

      expect(callCount, 2);
      expect(replayedRequest.method, 'PATCH');
      expect(replayedRequest.url.path, '/api/v1/feedback/turns/fb-1');
      expect(jsonDecode(replayedRequest.body), <String, dynamic>{
        'reason': 'got-stuck',
        'comment': 'looped forever',
      });
      expect(await outbox.read(), isEmpty);
    });

    test('clear with no feedbackId does not discard a queued clear entry for '
        'the same turn', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      const queuedClear = FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.clear,
        clientUserMessageId: 'msg-2',
        clientChatId: 'chat-1',
        accountId: accountA,
        feedbackId: 'fb-2',
        queuedAtMs: 1757000000000,
        // Older than every stamp this test issues — see `queuedRateFor`.
        seq: 0,
      );
      await outbox.write(<FeedbackOutboxEntry>[queuedClear]);
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        return http.Response('', 200);
      });
      final repo = build(client, outbox);

      final cleared = await repo.clear(
        clientUserMessageId: 'msg-2',
        clientChatId: 'chat-1',
      );

      expect(cleared.synced, isFalse);
      expect(callCount, 0);
      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.kind, FeedbackOutboxKind.clear);
      expect(remaining.single.feedbackId, 'fb-2');
    });

    test("attaching a detail to a still-queued rating preserves the rating's "
        'context fields alongside the merged reason and comment', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(
          provider: 'claude',
          model: 'claude-opus-4',
          chatMode: 'canopy',
          appVersion: '1.2.3',
          eventType: 'worktree_chat',
        ),
      );

      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      final queued = await outbox.read();
      expect(queued, hasLength(1));
      final entry = queued.single;
      expect(entry.kind, FeedbackOutboxKind.rate);
      expect(entry.provider, 'claude');
      expect(entry.model, 'claude-opus-4');
      expect(entry.chatMode, 'canopy');
      expect(entry.appVersion, '1.2.3');
      expect(entry.eventType, 'worktree_chat');
      expect(entry.reason, TurnFeedbackReason.gotStuck);
      expect(entry.comment, 'looped forever');
    });

    // The outbox holds one entry per turn (`upsertFeedbackOutbox` keys
    // solely on clientUserMessageId), so queueing a `detail` must not
    // silently clobber a pending `rate`/`clear` in the same slot, and a new
    // `rate` must fully replace whatever was queued before it. One test per
    // rule in `_queueDetail`'s doc comment.

    test('queuing a detail for a turn with a pending rate merges into the '
        'rate entry', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      final queued = await outbox.read();
      expect(queued, hasLength(1));
      expect(queued.single.kind, FeedbackOutboxKind.rate);
      expect(queued.single.rating, TurnFeedbackRating.down);
      expect(queued.single.reason, TurnFeedbackReason.gotStuck);
      expect(queued.single.comment, 'looped forever');
    });

    test('queuing a rate for a turn with a pending detail replaces it '
        'entirely, carrying no stale reason or comment forward', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[
        const FeedbackOutboxEntry(
          kind: FeedbackOutboxKind.detail,
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          accountId: accountA,
          feedbackId: 'fb-1',
          reason: TurnFeedbackReason.gotStuck,
          comment: 'looped forever',
          queuedAtMs: 1757000000000,
          // Older than every stamp this test issues — see `queuedRateFor`.
          seq: 0,
        ),
      ]);
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      final queued = await outbox.read();
      expect(queued, hasLength(1));
      final entry = queued.single;
      expect(entry.kind, FeedbackOutboxKind.rate);
      expect(entry.rating, TurnFeedbackRating.up);
      expect(entry.reason, isNull);
      expect(entry.comment, isNull);
    });

    test('queuing a detail for a turn with a pending clear drops the detail '
        'and leaves the clear untouched', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[
        const FeedbackOutboxEntry(
          kind: FeedbackOutboxKind.clear,
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          accountId: accountA,
          feedbackId: 'fb-9',
          queuedAtMs: 1757000000000,
          // Older than every stamp this test issues — see `queuedRateFor`.
          seq: 0,
        ),
      ]);
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-9',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      expect(callCount, 1);
      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.kind, FeedbackOutboxKind.clear);
      expect(remaining.single.feedbackId, 'fb-9');
      // The clear entry is untouched: no reason/comment leaked onto it.
      expect(remaining.single.reason, isNull);
      expect(remaining.single.comment, isNull);
    });

    test('queuing a detail for a turn with nothing pending inserts a '
        'standalone detail entry', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-5',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      final queued = await outbox.read();
      expect(queued, hasLength(1));
      expect(queued.single.kind, FeedbackOutboxKind.detail);
      expect(queued.single.feedbackId, 'fb-5');
      expect(queued.single.reason, TurnFeedbackReason.gotStuck);
      expect(queued.single.comment, 'looped forever');
      expect(queued.single.rating, isNull);
    });

    // The bug this pins: a `detail` whose PATCH failed retryably used to be
    // inserted as a standalone `detail` entry, and because the outbox holds
    // one entry per turn that insert CLOBBERED the queued re-`rate` in the
    // same slot — silently discarding the user's new rating. The pre-existing
    // "pending rate merges" test only covers the `feedbackId == null` path,
    // which never took the standalone-insert branch and so worked before the
    // fix too. This is the configuration that was actually broken: a queued
    // re-rate PLUS a PATCH failure carrying the stale feedbackId of the
    // rating the re-rate is replacing.
    test('a retryable PATCH failure carrying a stale feedbackId merges into '
        'the queued re-rate instead of clobbering it', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        // Both the re-rate POST and the detail PATCH fail retryably.
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      // The user re-rates a turn that already has a synced rating on the
      // server (feedbackId 'fb-1'); the write fails retryably and queues.
      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(provider: 'claude'),
      );

      // Then they submit the sheet. The controller still holds the STALE
      // feedbackId from the rating that was just superseded, so attachDetail
      // takes the PATCH path first — and that PATCH also fails retryably.
      final attached = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      expect(attached.synced, isFalse);
      // The PATCH really was attempted: 1 POST + 1 PATCH.
      expect(callCount, 2);
      final queued = await outbox.read();
      expect(queued, hasLength(1));
      final entry = queued.single;
      // Still the re-rate, with its rating and context intact...
      expect(entry.kind, FeedbackOutboxKind.rate);
      expect(entry.rating, TurnFeedbackRating.up);
      expect(entry.provider, 'claude');
      // ...carrying the reason and comment rather than losing them.
      expect(entry.reason, TurnFeedbackReason.gotStuck);
      expect(entry.comment, 'looped forever');
      // The stale feedbackId is deliberately NOT carried onto the merged
      // entry: the queued re-rate has no server row of its own yet, and the
      // flush attaches the detail to whatever id the replayed POST returns.
      expect(entry.feedbackId, isNull);
    });

    test('a detail merged into a queued rate while that rate is mid-flush is '
        'not swept away by the flush', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      // Seeded with a DIFFERENT queuedAtMs than the fixed clock `build()`
      // uses, so "the merge re-stamped queuedAtMs" is observable.
      const seededAtMs = 1757000000000 - 5000;
      await outbox.write(<FeedbackOutboxEntry>[
        const FeedbackOutboxEntry(
          kind: FeedbackOutboxKind.rate,
          clientUserMessageId: 'msg-a',
          clientChatId: 'chat-1',
          accountId: accountA,
          rating: TurnFeedbackRating.down,
          queuedAtMs: seededAtMs,
          // Older than every stamp this test issues — see `queuedRateFor`.
          seq: 0,
        ),
      ]);

      final rateRequestReceived = Completer<void>();
      final releaseRate = Completer<void>();
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        rateRequestReceived.complete();
        await releaseRate.future;
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-a',
            'clientUserMessageId': 'msg-a',
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      // Block the flush mid-network on msg-a's replay.
      final flush = repo.flushOutbox();
      await rateRequestReceived.future;

      // The user finishes typing their comment while that replay is still in
      // flight. It merges into the queued entry — and must survive the
      // flush's removal pass, which keys on (account, id, queuedAtMs).
      await repo.attachDetail(
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'looped forever',
      );

      releaseRate.complete();
      await flush;

      expect(callCount, 1);
      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.comment, 'looped forever');
      expect(remaining.single.reason, TurnFeedbackReason.gotStuck);
      // Re-stamped, which is exactly why it did not match the in-flight
      // flush's removal set.
      expect(remaining.single.queuedAtMs, 1757000000000);
      expect(remaining.single.queuedAtMs, isNot(seededAtMs));
    });

    // Account scoping. The outbox is durable across sign-out and a 401 is a
    // retryable failure, so without these rules one account's queued rating
    // (and its typed comment) would be POSTed under the next account's
    // session — the server upserts on (userId, clientUserMessageId) and does
    // no chat-ownership check.

    FeedbackOutboxEntry queuedRateFor(String account) => FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.rate,
      clientUserMessageId: 'msg-1',
      clientChatId: 'chat-1',
      accountId: account,
      rating: TurnFeedbackRating.down,
      comment: 'this answer was wrong',
      queuedAtMs: 1757000000000,
      // Sequence 0 is the load-bearing part of this fixture, not filler.
      //
      // Every ordering bound in the repository spares entries queued AFTER
      // the request it is bounded against began. A seeded entry that lands on
      // or past that boundary is therefore kept by the bound alone, and every
      // OTHER predicate in the same removal — the kind narrowing, the
      // cross-account guard — stops being tested: the assertions pass whether
      // or not those predicates exist. That is exactly how a previous round's
      // fixtures (stamped at the frozen clock's own instant) silently
      // un-tested both of them.
      //
      // 0 is "queued by an earlier run of the app": strictly older than every
      // sequence this repository will issue, so the bound always admits these
      // entries and whatever survives, survives on the predicate under test.
      seq: 0,
    );

    test("another account's queued rating is not sent after a different "
        'account signs in', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[queuedRateFor(accountA)]);
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => accountB);

      await repo.flushOutbox();

      expect(callCount, 0);
      // Not merely unsent — still queued, intact, for account A.
      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.accountId, accountA);
      expect(remaining.single.comment, 'this answer was wrong');
    });

    test(
      'a queued rating IS sent once its own account signs back in',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        await outbox.write(<FeedbackOutboxEntry>[queuedRateFor(accountA)]);
        var current = accountB;
        final requests = <http.Request>[];
        final client = MockClient((request) async {
          requests.add(request);
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox, accountId: () => current);

        // Account B is signed in: nothing goes out.
        await repo.flushOutbox();
        expect(requests, isEmpty);

        // Account A signs back in. Its own entry is delivered, not discarded.
        current = accountA;
        await repo.flushOutbox();

        expect(requests, hasLength(2));
        expect(jsonDecode(requests.first.body), <String, dynamic>{
          'clientUserMessageId': 'msg-1',
          'clientChatId': 'chat-1',
          'rating': 'down',
        });
        // The queued comment rides along on the follow-up PATCH.
        expect(requests.last.method, 'PATCH');
        expect(jsonDecode(requests.last.body), <String, dynamic>{
          'comment': 'this answer was wrong',
        });
        expect(await outbox.read(), isEmpty);
      },
    );

    test('flushOutbox sends nothing while signed out', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      // The second row belongs to NO account. The per-entry account filter
      // compares against the current account, which while signed out is also
      // null — so the signed-out check above it is the only thing that can
      // refuse this one.
      await outbox.write(<FeedbackOutboxEntry>[
        queuedRateFor(accountA),
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 2,
          turn: 'msg-2',
          account: null,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      var callCount = 0;
      final client = MockClient((request) async {
        callCount += 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => null);

      await repo.flushOutbox();

      expect(callCount, 0);
      expect(await outbox.read(), hasLength(2));
    });

    test('a failed write while signed out is not queued at all', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 401));
      final repo = build(client, outbox, accountId: () => null);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      // A 401 is retryable, but there is no account to attribute the entry
      // to — queueing it could only ever replay it under whoever signs in
      // next, which is the leak account scoping exists to prevent.
      expect(result.synced, isFalse);
      expect(await outbox.read(), isEmpty);
      // ...and because nothing was stored, the caller must be told the write
      // was DROPPED, not merely unsynced: there is nothing left to retry.
      expect(result.dropped, isTrue);
    });

    test('a SUCCESSFUL rate removes the entry an earlier failed rate had '
        'queued for the same turn', () async {
      // The bug: offline thumbs-down queues `rate(down)`; the user comes back
      // online and taps thumbs-up, which succeeds. Without this, the next
      // flush replays the stale `down` and silently reverts the user's own
      // newer choice.
      //
      // Uses the ADVANCING clock: the removal is bounded to entries queued
      // strictly before the successful POST started, which a frozen clock
      // cannot satisfy — every stamp it hands out is the same millisecond,
      // and that tie deliberately breaks toward keeping the entry.
      final outbox = InMemoryFeedbackOutboxStore();
      var offline = true;
      var rateCalls = 0;
      final client = MockClient((request) async {
        rateCalls += 1;
        if (offline) return http.Response('', 503);
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-1',
            'clientUserMessageId': 'msg-1',
            'rating': 'up',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      final queued = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(queued.synced, isFalse);
      expect(await outbox.read(), hasLength(1));

      offline = false;
      final online = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      expect(online.synced, isTrue);
      expect(await outbox.read(), isEmpty);

      // And a later flush must not resurrect it.
      final before = rateCalls;
      await repo.flushOutbox();
      expect(rateCalls, before);
    });

    test('a successful rate leaves ANOTHER account\'s queued entry for the '
        'same turn untouched', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[queuedRateFor(accountB)]);
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      final entries = await outbox.read();
      expect(entries, hasLength(1));
      expect(entries.single.accountId, accountB);
    });

    test('a SUCCESSFUL attachDetail removes the detail entry an earlier '
        'failed one had queued for the same turn', () async {
      // Advancing clock, for the same reason the rate supersession test uses
      // one: the removal is bounded to entries queued strictly before the
      // PATCH started, and a frozen clock stamps both with the same
      // millisecond — the ambiguous case the bound resolves toward KEEPING.
      final outbox = InMemoryFeedbackOutboxStore();
      var offline = true;
      final client = MockClient((request) async {
        if (offline) return http.Response('', 503);
        return http.Response('{}', 200);
      });
      final repo = build(client, outbox);

      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'first attempt',
      );
      expect(await outbox.read(), hasLength(1));
      expect((await outbox.read()).single.kind, FeedbackOutboxKind.detail);

      offline = false;
      final synced = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'second attempt',
      );

      expect(synced.synced, isTrue);
      expect(await outbox.read(), isEmpty);
    });

    test('a successful attachDetail does NOT drop a still-queued rate for the '
        'same turn', () async {
      // The PATCH lands against the PREVIOUS feedback row; the queued rate is
      // a newer rating the server still has not seen, so it must survive.
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[queuedRateFor(accountA)]);
      final client = MockClient((request) async => http.Response('{}', 200));
      final repo = build(client, outbox);

      final synced = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-old',
        reason: TurnFeedbackReason.gotStuck,
      );

      expect(synced.synced, isTrue);
      final entries = await outbox.read();
      expect(entries, hasLength(1));
      expect(entries.single.kind, FeedbackOutboxKind.rate);
    });

    test(
      'a rate refused outright reports dropped; a retryable one does not',
      () async {
        final refusedOutbox = InMemoryFeedbackOutboxStore();
        final refused =
            await build(
              MockClient((request) async => http.Response('', 400)),
              refusedOutbox,
            ).rate(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              rating: TurnFeedbackRating.down,
              context: const TurnFeedbackContext(),
            );
        expect(refused.synced, isFalse);
        expect(refused.dropped, isTrue);
        expect(await refusedOutbox.read(), isEmpty);

        final queuedOutbox = InMemoryFeedbackOutboxStore();
        final queued =
            await build(
              MockClient((request) async => http.Response('', 503)),
              queuedOutbox,
            ).rate(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              rating: TurnFeedbackRating.down,
              context: const TurnFeedbackContext(),
            );
        expect(queued.synced, isFalse);
        expect(queued.dropped, isFalse);
        expect(await queuedOutbox.read(), hasLength(1));
      },
    );

    test('a rate whose SUCCESSFUL response fails to decode keeps the rating '
        'and queues reconciliation', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient(
        (request) async => http.Response('not json at all', 200),
      );
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(result.synced, isFalse);
      expect(
        result.dropped,
        isFalse,
        reason: 'the server accepted the POST, so the optimistic thumb stands',
      );
      expect(
        await outbox.read(),
        hasLength(1),
        reason: 'an idempotent replay can recover a decodable feedbackId',
      );
    });

    // Ordering of the success-path removals against writes queued WHILE the
    // request was in flight. `_serialized` cannot express this: it orders
    // store access, and the removal is only enqueued AFTER the network await,
    // so it is ordered against the wrong thing. Both tests below hold the
    // in-flight request open with a Completer so the interleaving actually
    // happens rather than being hoped for.

    test('an entry queued WHILE a rate request is in flight survives that '
        "request's success", () async {
      // The success-path sweep is bounded to `entry.seq <= startSeq`, so a
      // write removes only what was already queued when it BEGAN. Seeding the
      // store mid-request is what the concurrent thumbs-down used to be: a row
      // that appeared after this POST opened, and is therefore newer than what
      // the server is about to accept.
      final outbox = InMemoryFeedbackOutboxStore();
      final upRequestReceived = Completer<void>();
      final releaseUp = Completer<void>();
      final client = MockClient((request) async {
        upRequestReceived.complete();
        await releaseUp.future;
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-up',
            'clientUserMessageId': 'msg-1',
            'rating': 'up',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      final up = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      // The interleaving is real, not incidental: nothing below runs until
      // the `up` POST is genuinely open on the wire.
      await upRequestReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      releaseUp.complete();
      expect((await up).synced, isTrue);

      final remaining = await outbox.read();
      expect(
        remaining,
        hasLength(1),
        reason:
            'the down queued mid-flight is NEWER than the up the server '
            'accepted, so it must survive',
      );
      expect(remaining.single.rating, TurnFeedbackRating.down);
      expect(remaining.single.kind, FeedbackOutboxKind.rate);
    });

    test('an entry queued WHILE a DELETE is in flight survives that '
        "retraction's success", () async {
      // The same bound on `clear`'s success path. Both need it or the fix is
      // half-applied.
      final outbox = InMemoryFeedbackOutboxStore();
      final deleteReceived = Completer<void>();
      final releaseDelete = Completer<void>();
      final client = MockClient((request) async {
        deleteReceived.complete();
        await releaseDelete.future;
        return http.Response('', 200);
      });
      final repo = build(client, outbox);

      final clearing = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );
      await deleteReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      releaseDelete.complete();
      expect((await clearing).synced, isTrue);

      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.kind, FeedbackOutboxKind.rate);
      expect(remaining.single.rating, TurnFeedbackRating.down);
    });

    test('an entry queued WHILE a PATCH is in flight survives that '
        "request's success", () async {
      // The third instance of the same shape. The kind filter spares a queued
      // `rate` or `clear`, but NOT a newer `detail` — so without the bound a
      // reason the user typed while the first PATCH was open is swept away by
      // that PATCH succeeding.
      final outbox = InMemoryFeedbackOutboxStore();
      final firstPatchReceived = Completer<void>();
      final releaseFirstPatch = Completer<void>();
      final client = MockClient((request) async {
        firstPatchReceived.complete();
        await releaseFirstPatch.future;
        return http.Response('{}', 200);
      });
      final repo = build(client, outbox);

      final first = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'first comment',
      );
      // The interleaving is real, not incidental: nothing below runs until
      // the first PATCH is genuinely open on the wire.
      await firstPatchReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 50,
          feedbackId: 'fb-1',
          comment: 'second comment',
        ),
      ]);

      releaseFirstPatch.complete();
      expect((await first).synced, isTrue);

      final remaining = await outbox.read();
      expect(
        remaining,
        hasLength(1),
        reason:
            'the detail queued mid-flight is NEWER than the one the '
            'server accepted, so it must survive',
      );
      expect(remaining.single.kind, FeedbackOutboxKind.detail);
      expect(remaining.single.comment, 'second comment');
    });

    test(
      'a clear refused outright reports dropped; a retryable one does not',
      () async {
        // `clear` needs the same `dropped` signal `rate` has. A 400/403/404
        // DELETE never reached a state where the rating is gone, and nothing is
        // queued to try again — so a caller that left the thumb unselected
        // would be claiming a retraction that did not happen.
        final refusedOutbox = InMemoryFeedbackOutboxStore();
        final refused =
            await build(
              MockClient((request) async => http.Response('', 403)),
              refusedOutbox,
            ).clear(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              feedbackId: 'fb-1',
            );
        expect(refused.synced, isFalse);
        expect(refused.dropped, isTrue);
        expect(await refusedOutbox.read(), isEmpty);

        final queuedOutbox = InMemoryFeedbackOutboxStore();
        final queued =
            await build(
              MockClient((request) async => http.Response('', 503)),
              queuedOutbox,
            ).clear(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              feedbackId: 'fb-1',
            );
        expect(queued.synced, isFalse);
        expect(queued.dropped, isFalse);
        expect(await queuedOutbox.read(), hasLength(1));
        expect(
          (await queuedOutbox.read()).single.kind,
          FeedbackOutboxKind.clear,
        );
      },
    );

    test('a clear with no account to queue under reports dropped', () async {
      // The other way a retraction is lost with nothing to retry it.
      final outbox = InMemoryFeedbackOutboxStore();
      final result =
          await build(
            MockClient((request) async => http.Response('', 503)),
            outbox,
            accountId: () => null,
          ).clear(
            clientUserMessageId: 'msg-1',
            clientChatId: 'chat-1',
            feedbackId: 'fb-1',
          );

      expect(result.synced, isFalse);
      expect(result.dropped, isTrue);
      expect(await outbox.read(), isEmpty);
    });

    test(
      'a detail refused outright reports dropped; a retryable one does not',
      () async {
        final refusedOutbox = InMemoryFeedbackOutboxStore();
        final refused =
            await build(
              MockClient((request) async => http.Response('', 400)),
              refusedOutbox,
            ).attachDetail(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              feedbackId: 'fb-1',
              comment: 'it looped forever',
            );
        expect(refused.synced, isFalse);
        expect(refused.dropped, isTrue);
        expect(await refusedOutbox.read(), isEmpty);

        final queuedOutbox = InMemoryFeedbackOutboxStore();
        final queued =
            await build(
              MockClient((request) async => http.Response('', 503)),
              queuedOutbox,
            ).attachDetail(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              feedbackId: 'fb-1',
              comment: 'it looped forever',
            );
        expect(queued.synced, isFalse);
        expect(queued.dropped, isFalse);
        expect(await queuedOutbox.read(), hasLength(1));
      },
    );

    test('a detail with nothing to attach it to reports dropped', () async {
      // No feedbackId and nothing queued for the turn: `_queueDetail` stores
      // nothing, so the reason will never reach the server.
      final outbox = InMemoryFeedbackOutboxStore();
      final result =
          await build(
            MockClient((request) async => http.Response('{}', 200)),
            outbox,
          ).attachDetail(
            clientUserMessageId: 'msg-1',
            clientChatId: 'chat-1',
            reason: TurnFeedbackReason.gotStuck,
          );

      expect(result.synced, isFalse);
      expect(result.dropped, isTrue);
      expect(await outbox.read(), isEmpty);
    });

    // --- Ordering of INSERTIONS, not just removals. A write that fails and
    // queues is ordered against every other write for the same turn by the
    // same rule its success path would have used: an entry that a newer
    // settled write would have swept must not be inserted after the fact.
    // Both tests hold the losing request open with a Completer so the
    // interleaving genuinely happens.

    test('a retraction issued while a rating is still in flight cancels it '
        'once it lands', () async {
      // 1. thumbs-up POST hangs.
      // 2. the user taps again to retract it. The retraction is SERIALIZED
      //    behind the rating rather than racing it.
      // 3. the thumbs-up POST fails 503 and is durably queued.
      // 4. the retraction then runs, finds that queued rate, and drops it.
      // Dropping the pending rate IS the retraction: there is no feedbackId,
      // so there is nothing on the server to DELETE.
      final outbox = InMemoryFeedbackOutboxStore();
      final rateReceived = Completer<void>();
      final releaseRate = Completer<void>();
      var httpCalls = 0;
      final client = MockClient((request) async {
        httpCalls += 1;
        rateReceived.complete();
        await releaseRate.future;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final rating = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await rateReceived.future;

      final retraction = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );
      await pumpEventQueue();

      releaseRate.complete();
      final settled = await rating;
      expect(settled.synced, isFalse);
      expect(
        settled.dropped,
        isFalse,
        reason: 'the rating was durably queued before the retraction ran',
      );

      final retractionResult = await retraction;
      expect(
        retractionResult.synced,
        isTrue,
        reason: 'dropping the pending rate IS the completed retraction',
      );
      expect(
        await outbox.read(),
        isEmpty,
        reason: 'a rating the user explicitly retracted must not stay queued',
      );

      // ...and no later flush can resurrect it.
      await repo.flushOutbox();
      expect(httpCalls, 1);
      expect(await outbox.read(), isEmpty);
    });

    test('a rating superseded by a newer one that already reached the server '
        'is not queued when its own POST finally fails', () async {
      // 1. thumbs-up POST hangs.
      // 2. a newer rating reaches the server WHILE it hangs — now through the
      //    replay path, the only writer that can still overlap a verb.
      // 3. the thumbs-up POST fails 503.
      // Queueing step 3 would put the server back on `up` at the next flush
      // while the UI still reads `down`.
      final outbox = InMemoryFeedbackOutboxStore();
      final upReceived = Completer<void>();
      final releaseUp = Completer<void>();
      final client = MockClient((request) async {
        final body = jsonDecode(request.body);
        if (body is Map && body['rating'] == 'up') {
          upReceived.complete();
          await releaseUp.future;
          return http.Response('', 503);
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-down',
            'clientUserMessageId': 'msg-1',
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      final up = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await upReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();
      expect(await outbox.read(), isEmpty);

      releaseUp.complete();
      final upResult = await up;

      expect(upResult.synced, isFalse);
      expect(upResult.dropped, isTrue);
      expect(
        await outbox.read(),
        isEmpty,
        reason:
            'the up POST lost the race to a newer rating that already '
            'reached the server, so replaying it would revert the user',
      );
    });

    test('a detail superseded by a newer rating is not queued when its own '
        'PATCH fails', () async {
      // The same insertion rule on the third verb. The PATCH describes the
      // feedback row the newer rating replaced, so queueing it would attach
      // the user's comment to a rating that no longer exists.
      final outbox = InMemoryFeedbackOutboxStore();
      final patchReceived = Completer<void>();
      final releasePatch = Completer<void>();
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          patchReceived.complete();
          await releasePatch.future;
          return http.Response('', 503);
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-new',
            'clientUserMessageId': 'msg-1',
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      final detail = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-old',
        comment: 'it looped forever',
      );
      await patchReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();
      expect(await outbox.read(), isEmpty);

      releasePatch.complete();
      final detailResult = await detail;

      expect(detailResult.synced, isFalse);
      expect(detailResult.dropped, isTrue);
      expect(await outbox.read(), isEmpty);
    });

    test(
      'an older failed rating cannot replace a newer queued rating',
      () async {
        // No watermark here: a retryable failure never SETTLES, so the only
        // thing that can order this write against the row already occupying the
        // turn's single outbox slot is that row's own sequence. The row is
        // seeded AFTER the POST opened, which is the only way a newer row can
        // exist at all — a queue persisted by a previous run is raised past by
        // `_readLocked` before `startSeq` is issued, and `_runWrite` rules out
        // a concurrent verb. The guard is defence in depth; this is the shape
        // that still reaches it.
        final outbox = InMemoryFeedbackOutboxStore();
        final upReceived = Completer<void>();
        final releaseUp = Completer<void>();
        final client = MockClient((request) async {
          upReceived.complete();
          await releaseUp.future;
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        final older = repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        await upReceived.future;

        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 50,
            rating: TurnFeedbackRating.down,
          ),
        ]);

        releaseUp.complete();
        final olderResult = await older;

        expect(olderResult.dropped, isTrue);
        final queued = (await outbox.read()).single;
        expect(queued.kind, FeedbackOutboxKind.rate);
        expect(queued.rating, TurnFeedbackRating.down);
        expect(
          queued.seq,
          50,
          reason: 'the newer row is untouched, not replaced in place',
        );
      },
    );

    test(
      'an older failed clear cannot replace a newer queued rating',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        final clearReceived = Completer<void>();
        final releaseClear = Completer<void>();
        final client = MockClient((request) async {
          clearReceived.complete();
          await releaseClear.future;
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        final older = repo.clear(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          feedbackId: 'fb-old',
        );
        await clearReceived.future;

        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 50,
            rating: TurnFeedbackRating.down,
          ),
        ]);

        releaseClear.complete();
        final olderResult = await older;

        expect(olderResult.dropped, isTrue);
        final queued = (await outbox.read()).single;
        expect(queued.kind, FeedbackOutboxKind.rate);
        expect(queued.rating, TurnFeedbackRating.down);
      },
    );

    test('an older failed detail MERGES into a newer queued rating rather '
        'than being refused by the stale-replacement rule', () async {
      // The one exemption. Replacing a newer row with an older write is
      // always wrong; MERGING into it is the documented behavior of
      // `_buildQueuedDetail` and the only way a reason the user typed while a
      // rating was still unsent ever reaches the server. The merge re-stamps
      // with a fresh sequence, so it is by construction newer than the row it
      // merged into and the refusal cannot fire on it.
      final outbox = InMemoryFeedbackOutboxStore();
      final detailReceived = Completer<void>();
      final releaseDetail = Completer<void>();
      final client = MockClient((request) async {
        detailReceived.complete();
        await releaseDetail.future;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final older = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-old',
        comment: 'it looped forever',
      );
      await detailReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      releaseDetail.complete();
      final olderResult = await older;

      expect(olderResult.dropped, isFalse);
      final queued = (await outbox.read()).single;
      expect(
        queued.kind,
        FeedbackOutboxKind.rate,
        reason: 'the queued rating keeps its kind and its payload',
      );
      expect(queued.rating, TurnFeedbackRating.down);
      expect(
        queued.comment,
        'it looped forever',
        reason: 'the comment the user typed must survive',
      );
      expect(
        queued.seq,
        greaterThan(50),
        reason:
            'a merge re-stamps, so a flush already handling the old row '
            'identity cannot sweep it away',
      );
    });

    test('a stale detail checks the DETAIL watermark even when it would merge '
        'into a queued rate', () async {
      // `queue` asks two different questions that used to share one argument.
      // The watermark question is about the verb that FAILED (`detail`); the
      // sweep question is about the row that would be WRITTEN (here `rate`,
      // because the detail merges into a queued rating). Judging the failed
      // detail against `watermark[rate]` lets a detail a newer one already
      // superseded attach itself to the queued rating anyway.
      final outbox = InMemoryFeedbackOutboxStore();
      final staleReceived = Completer<void>();
      final releaseStale = Completer<void>();
      var patches = 0;
      final client = MockClient((request) async {
        patches += 1;
        if (patches == 1) {
          staleReceived.complete();
          await releaseStale.future;
          return http.Response('', 503);
        }
        return http.Response('', 204);
      });
      final repo = build(client, outbox);

      final stale = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'stale detail',
      );
      await staleReceived.future;

      // A NEWER detail lands while the stale PATCH is still open, publishing a
      // watermark narrowed to `detail`.
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 20,
          feedbackId: 'fb-1',
          comment: 'newer detail',
        ),
      ]);
      await repo.flushOutbox();
      expect(await outbox.read(), isEmpty);

      // ...and a rating the server has never seen is queued for the same turn,
      // which is what the stale detail would merge into. `watermark[rate]` is
      // untouched by a detail replay, so only the DETAIL watermark can refuse
      // this.
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 5,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      releaseStale.complete();
      final staleResult = await stale;

      expect(staleResult.dropped, isTrue);
      final queued = (await outbox.read()).single;
      expect(queued.kind, FeedbackOutboxKind.rate);
      expect(queued.comment, isNull);
    });

    test('flushOutbox stops sending the moment the signed-in account '
        'changes', () async {
      // `service.*` builds its headers from the LIVE session, so an account
      // change partway through a multi-entry replay would send the rest of
      // account A's ratings -- and their typed comments -- under account B's
      // bearer. The server upserts on (userId, clientUserMessageId) with no
      // ownership check, so that is a silent cross-account write.
      final outbox = InMemoryFeedbackOutboxStore();
      var current = accountA;
      var offline = true;
      var replays = 0;
      final sent = <String>[];
      final firstReplay = Completer<void>();
      final releaseFirstReplay = Completer<void>();
      final client = MockClient((request) async {
        if (offline) return http.Response('', 503);
        final body = jsonDecode(request.body);
        final id = body is Map ? body['clientUserMessageId'] : null;
        sent.add(id is String ? id : '?');
        replays += 1;
        if (replays == 1) {
          firstReplay.complete();
          await releaseFirstReplay.future;
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-$id',
            'clientUserMessageId': id,
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox, accountId: () => current);

      for (final id in <String>['msg-1', 'msg-2']) {
        final queued = await repo.rate(
          clientUserMessageId: id,
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
        expect(queued.synced, isFalse);
      }
      expect(await outbox.read(), hasLength(2));

      offline = false;
      final flush = repo.flushOutbox();
      await firstReplay.future;
      // Sign-out and sign-in, mid-flush.
      current = accountB;
      releaseFirstReplay.complete();
      await flush;

      expect(
        sent,
        hasLength(1),
        reason: "account A's second entry must not go out under B's bearer",
      );
      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.accountId, accountA);
      expect(
        remaining.single.clientUserMessageId,
        isNot(sent.single),
        reason: 'the unsent entry stays queued for its OWN account',
      );
    });

    test('a refused retraction leaves the pending rating it would have '
        'replaced still queued', () async {
      // The drop of a pending `rate` is part of the retraction, so it may not
      // happen until the retraction itself has an outcome. A DELETE refused
      // outright changes nothing on the server, and the caller restores the
      // thumb -- so a queue that already threw the rating away would match
      // neither the server nor the user's intent.
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async {
        if (request.method == 'DELETE') return http.Response('', 403);
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final queued = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(queued.synced, isFalse);
      expect(await outbox.read(), hasLength(1));

      // The same turn also has a row on the server from an earlier session,
      // so retracting attempts a DELETE -- which is refused.
      final retraction = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );

      expect(retraction.synced, isFalse);
      expect(retraction.dropped, isTrue);
      final remaining = await outbox.read();
      expect(
        remaining,
        hasLength(1),
        reason:
            'the retraction never happened, so the rating the restored '
            'thumb shows must still be queued',
      );
      expect(remaining.single.kind, FeedbackOutboxKind.rate);
      expect(remaining.single.rating, TurnFeedbackRating.down);
    });

    test('an entry that looks OLDER by wall clock but newer by sequence is '
        'not removed by the request it was queued during', () async {
      // Ordering is decided by a monotonic sequence, never by wall time. A
      // device/NTP correction inside a request window makes the entry queued
      // DURING that request look older than the request's own start; a sweep
      // that trusted the clock would delete it on the success path — the exact
      // loss the bound exists to prevent.
      final outbox = InMemoryFeedbackOutboxStore();
      var wallMs = 1757000005000;
      final upReceived = Completer<void>();
      final releaseUp = Completer<void>();
      final client = MockClient((request) async {
        upReceived.complete();
        await releaseUp.future;
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-up',
            'clientUserMessageId': 'msg-1',
            'rating': 'up',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(
        client,
        outbox,
        now: () => DateTime.fromMillisecondsSinceEpoch(wallMs),
      );

      final up = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await upReceived.future;

      // The device clock steps five seconds BACKWARDS while the POST is open,
      // so the row queued after it stamps an EARLIER wall time than the
      // request that is still running.
      wallMs = 1757000000000;
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
          queuedAtMs: wallMs,
        ),
      ]);

      releaseUp.complete();
      expect((await up).synced, isTrue);

      final remaining = await outbox.read();
      expect(
        remaining,
        hasLength(1),
        reason:
            'the down was queued AFTER the up POST started; a clock that '
            'moved backwards must not make it look older',
      );
      expect(remaining.single.rating, TurnFeedbackRating.down);
    });

    // --- The watermark itself. `_isSuperseded` and `settle` read one shared
    // record of "what has already settled for this turn", and every defect
    // below is that record being wrong rather than either reader being wrong:
    // narrowed by a later write, missing entirely after a replay, or applied
    // to a write that started after it.

    test('a narrow detail that settles last does not un-supersede the kinds a '
        'broader earlier write already ruled out', () async {
      // 1. clear(fb-1): the DELETE hangs.
      // 2. a queued rating replays successfully — every kind is superseded.
      // 3. a queued detail replays successfully — it supersedes `detail` ONLY.
      // 4. the hung DELETE fails 503.
      // Step 3 is newer than step 2, but narrower. A watermark that holds one
      // (seq, supersedes) pair for the whole turn is REPLACED by it, so step 4
      // sees `{detail}` and is allowed to queue — and the next flush DELETEs
      // both the rating and the reason the user just typed.
      final outbox = InMemoryFeedbackOutboxStore();
      final deleteReceived = Completer<void>();
      final releaseDelete = Completer<void>();
      var deletes = 0;
      final client = MockClient((request) async {
        if (request.method == 'DELETE') {
          deletes += 1;
          if (deletes == 1) {
            deleteReceived.complete();
            await releaseDelete.future;
            return http.Response('', 503);
          }
          return http.Response('', 204);
        }
        if (request.method == 'PATCH') return http.Response('', 204);
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final retraction = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );
      await deleteReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 60,
          feedbackId: 'fb-1',
          comment: 'it looped forever',
        ),
      ]);
      await repo.flushOutbox();
      expect(await outbox.read(), isEmpty);

      releaseDelete.complete();
      final retractionResult = await retraction;

      expect(retractionResult.synced, isFalse);
      expect(
        retractionResult.dropped,
        isTrue,
        reason:
            'the DELETE lost the race to a rating that reached the server, '
            'so nothing may retry it',
      );
      expect(
        await outbox.read(),
        isEmpty,
        reason:
            'a later, NARROWER settle must not re-admit a retraction the '
            'broader rating had already superseded',
      );

      await repo.flushOutbox();
      expect(
        deletes,
        1,
        reason: 'no flush may resurrect the superseded retraction',
      );
    });

    test('a replayed entry publishes the same watermark its online verb would '
        'have, so an older in-flight write cannot undo it', () async {
      // 1. clear(fb-1): the DELETE hangs.
      // 2. a rating queued earlier is replayed successfully — the server now
      //    holds `down`.
      // 3. the hung DELETE fails 503.
      // `flushOutbox` was the only definite-outcome path that READ the
      // watermark without ever WRITING it, so step 3 checked an empty record,
      // queued, and the next flush DELETEd the rating step 2 had just landed.
      final outbox = InMemoryFeedbackOutboxStore();
      final deleteReceived = Completer<void>();
      final releaseDelete = Completer<void>();
      var deletes = 0;
      var posts = 0;
      final client = MockClient((request) async {
        if (request.method == 'DELETE') {
          deletes += 1;
          if (deletes == 1) {
            deleteReceived.complete();
            await releaseDelete.future;
            return http.Response('', 503);
          }
          return http.Response('', 204);
        }
        posts += 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final retraction = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );
      await deleteReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();
      expect(posts, 1);
      expect(await outbox.read(), isEmpty);

      releaseDelete.complete();
      final retractionResult = await retraction;

      expect(retractionResult.synced, isFalse);
      expect(
        retractionResult.dropped,
        isTrue,
        reason: 'the replay superseded this DELETE, so nothing may retry it',
      );
      expect(
        await outbox.read(),
        isEmpty,
        reason:
            'queueing the DELETE would retract the rating the replay just '
            'delivered',
      );

      await repo.flushOutbox();
      expect(deletes, 1);
    });

    test(
      'a write that BEGINS after a settle is not superseded by it',
      () async {
        // The ordering bound in `_isSuperseded`. The watermark records WHEN a
        // kind was superseded, not merely THAT it was: a rating the user makes
        // after an earlier one landed is newer than that watermark and must
        // still be allowed to queue when it fails.
        final outbox = InMemoryFeedbackOutboxStore();
        var posts = 0;
        final client = MockClient((request) async {
          posts += 1;
          if (posts == 1) return http.Response(jsonEncode(summaryJson), 200);
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        final first = await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        expect(first.synced, isTrue);

        final second = await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );

        expect(second.synced, isFalse);
        expect(
          second.dropped,
          isFalse,
          reason: 'a newer rating is not superseded by an older settle',
        );
        final entries = await outbox.read();
        expect(entries, hasLength(1));
        expect(entries.single.rating, TurnFeedbackRating.down);
      },
    );

    test('a replayed rating whose follow-up detail fails is still replayed by '
        'the next flush', () async {
      // The other side of the same bound: `flushOutbox` publishes at the
      // REPLAYED ENTRY'S OWN sequence, so the comparison has to be strictly
      // greater. At `>=` an entry left queued by a failed follow-up PATCH
      // would supersede itself and never be sent again.
      final outbox = InMemoryFeedbackOutboxStore();
      var posts = 0;
      var patches = 0;
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          patches += 1;
          return http.Response('', patches == 1 ? 503 : 204);
        }
        posts += 1;
        if (posts == 1) return http.Response('', 503);
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      // Queue a rating, then merge a comment into it.
      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        comment: 'it looped forever',
      );
      expect(await outbox.read(), hasLength(1));

      // First replay: the POST lands, the follow-up PATCH does not, so the
      // entry stays queued.
      await repo.flushOutbox();
      expect(posts, 2);
      expect(patches, 1);
      expect(await outbox.read(), hasLength(1));

      // Second replay must still send it.
      await repo.flushOutbox();
      expect(posts, 3);
      expect(patches, 2);
      expect(await outbox.read(), isEmpty);
    });

    test('a broad write that settles LATE does not lower the watermark a '
        'newer one already raised', () async {
      // 1. attachDetail(fb-1) begins; its PATCH hangs. Its sequence sits
      //    between the two rows replayed below.
      // 2. a queued DETAIL replays — `detail` is superseded at the NEWEST
      //    sequence.
      // 3. a queued RATE with an OLDER sequence replays. It settles broadly,
      //    but it began first, so it must only ever RAISE each kind, never
      //    move `detail` back to its own older sequence.
      // 4. the hung PATCH fails 503.
      // Without the raise-only guard, step 3 rewinds `detail` behind step 1
      // and the abandoned PATCH is queued — re-attaching a comment the newer
      // detail already replaced.
      final outbox = InMemoryFeedbackOutboxStore();
      // Another account's row, which `flushOutbox` never sends. It exists only
      // to anchor the sequence counter, so the in-flight write's own sequence
      // lands between the two replayed rows.
      final anchor = seeded(
        kind: FeedbackOutboxKind.rate,
        seq: 55,
        turn: 'msg-9',
        account: accountB,
        rating: TurnFeedbackRating.up,
      );
      await outbox.write(<FeedbackOutboxEntry>[anchor]);

      final patchReceived = Completer<void>();
      final releasePatch = Completer<void>();
      var patches = 0;
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          patches += 1;
          if (patches == 1) {
            patchReceived.complete();
            await releasePatch.future;
            return http.Response('', 503);
          }
          return http.Response('', 204);
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final stale = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'stale comment',
      );
      await patchReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        anchor,
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 60,
          feedbackId: 'fb-1',
          comment: 'newer comment',
        ),
      ]);
      await repo.flushOutbox();

      await outbox.write(<FeedbackOutboxEntry>[
        anchor,
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();

      releasePatch.complete();
      final staleResult = await stale;

      expect(staleResult.synced, isFalse);
      expect(staleResult.dropped, isTrue);
      expect(
        (await outbox.read()).single.accountId,
        accountB,
        reason:
            'an older write settling late must not lower the watermark and '
            "let a comment the user replaced back into this account's queue",
      );
    });

    // --- A failing store costs durability, not the write. Every store touch
    // on a write path degrades rather than throwing: these calls are driven
    // from `unawaited(onPressed())`, where an escaping error is an unhandled
    // zone error that leaves the thumb `pending` forever.

    test('a store that cannot be READ still lets the rating reach the '
        'server', () async {
      // The read happens on the critical path of every rating, BEFORE the
      // request goes out, purely to issue an ordering sequence.
      final outbox = _FailingFeedbackOutboxStore(failRead: true);
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(
        result.synced,
        isTrue,
        reason: 'a broken store must cost durability, not the write itself',
      );
      expect(result.feedbackId, 'fb-1');
    });

    test('a store that cannot be WRITTEN reports the queue attempt as '
        'dropped instead of throwing', () async {
      final outbox = _FailingFeedbackOutboxStore(failWrite: true);
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(result.synced, isFalse);
      expect(
        result.dropped,
        isTrue,
        reason: 'nothing was persisted, so nothing will ever retry it',
      );
    });

    test('a store that never ANSWERS wedges neither the turn, an unrelated '
        'turn, nor a later flush', () async {
      // `requestTimeout` bounds all nine requests; nothing bounded the OTHER
      // leg. `_serialized`'s chain is process-wide and `_runWrite` awaits it
      // BEFORE opening its request, so one stalled `SharedPreferences` read
      // parked every rating, every retraction and every future flush for the
      // process lifetime -- with a perfectly healthy server. The row disables
      // both thumbs while `pending`, so those turns are simply dead.
      //
      // Without `storeTimeout` every future below stays uncompleted forever
      // and this resolves to 'wedged'.
      final outbox = _StallingFeedbackOutboxStore();
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(
        client,
        outbox,
        storeTimeout: const Duration(milliseconds: 50),
      );

      final work = Future.wait<void>(<Future<void>>[
        repo
            .rate(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              rating: TurnFeedbackRating.down,
              context: const TurnFeedbackContext(),
            )
            .then((_) {}),
        repo
            .rate(
              clientUserMessageId: 'msg-2',
              clientChatId: 'chat-1',
              rating: TurnFeedbackRating.up,
              context: const TurnFeedbackContext(),
            )
            .then((_) {}),
        repo.flushOutbox().then((_) {}),
      ]);

      final outcome = await Future.any<String>(<Future<String>>[
        work.then((_) => 'resolved'),
        Future<String>.delayed(const Duration(seconds: 2), () => 'wedged'),
      ]);

      expect(
        outcome,
        'resolved',
        reason: 'a stalled store must cost durability, not every later write',
      );
    });

    test(
      'a store that never answers on WRITE wedges the queue insert too',
      () async {
        // The other half of the store leg. A store that reads fine and stalls
        // only on write reaches `_TurnWrite.queue`'s `outbox.write` -- inside
        // `_serialized`, so the stall parks the process-wide chain exactly as a
        // stalled read does. Bounding only the read leaves this path unbounded
        // and every later write behind it.
        final outbox = _StallingOnWriteFeedbackOutboxStore();
        final client = MockClient((request) async => http.Response('', 503));
        final repo = build(
          client,
          outbox,
          storeTimeout: const Duration(milliseconds: 50),
        );

        final work = repo
            .rate(
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              rating: TurnFeedbackRating.down,
              context: const TurnFeedbackContext(),
            )
            .then((result) => result.dropped ? 'dropped' : 'queued');

        final outcome = await Future.any<String>(<Future<String>>[
          work,
          Future<String>.delayed(const Duration(seconds: 2), () => 'wedged'),
        ]);

        expect(
          outcome,
          'dropped',
          reason:
              'a write that never lands must report honestly, not hang the '
              'turn and every write behind it',
        );
      },
    );

    test('a store that cannot be WRITTEN does not turn a SUCCESSFUL rating '
        'into a thrown error', () async {
      // The WRITE half of `settle()`'s degradation, which every other test in
      // this group left unpinned by failing only the READ half. `settle` wraps
      // its read AND its `outbox.write` in one try/catch; moving the write out
      // of that try leaves the rest of this suite green, and the escaping
      // error then propagates straight out of `repo.rate` -- called in
      // production as `unawaited(onPressed())`, so it lands as an unhandled
      // zone error with the thumb stuck `pending`.
      //
      // Reaching the write at all takes a NON-EMPTY sweep: `settle` returns
      // early when nothing was superseded. The seeded entry is what makes
      // `removed` non-empty, and `_readLocked` raises the counter past its
      // sequence before this write is issued one, so it is strictly older and
      // genuinely superseded.
      final outbox = _FailingFeedbackOutboxStore(failWrite: true);
      outbox.entries = <FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 5,
          rating: TurnFeedbackRating.up,
        ),
      ];
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(
        result.synced,
        isTrue,
        reason: 'the server accepted the rating; the sweep is bookkeeping',
      );
      expect(result.feedbackId, 'fb-1');
      // The whole point: the failure was absorbed rather than thrown. Awaiting
      // a `rate` that threw would fail this test outright.
      expect(
        outbox.entries.single.seq,
        5,
        reason: 'the sweep could not be persisted, so the stale entry remains',
      );
    });

    test('a store that cannot be read does not turn a SUCCESSFUL retraction '
        'into a thrown error', () async {
      // The success path awaits `settle()`, which reads and rewrites the
      // store to sweep what it superseded. A failure there must not be
      // reported as a failed retraction.
      final outbox = _FailingFeedbackOutboxStore(failRead: true);
      final client = MockClient((request) async => http.Response('', 204));
      final repo = build(client, outbox);

      final result = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );

      expect(result.synced, isTrue);
      expect(result.dropped, isFalse);
    });

    // --- The seq-issuing read is the ONLY thing that raises the ordering
    // counter past the persisted queue. Every test above that exercises a
    // failed read uses a store where EVERY read fails, so `settle` never
    // reaches its sweep and the divergence below is invisible. These four use
    // a store whose FIRST touch is slow or broken and whose every later touch
    // is instant -- a cold-start `SharedPreferences.getInstance()`, which is
    // the shape `storeTimeout` actually turns into a store failure.

    test('a rating whose seq-issuing read TIMED OUT still sweeps the stale '
        'entry a previous session queued', () async {
      // The headline: a merely SLOW store turned into a silent server-side
      // revert. `startSeq` is minted from a counter the timed-out read never
      // raised, so the seeded `up` at seq 7 looks NEWER than the thumbs-down
      // the user just recorded -- the sweep misses it and the next flush
      // replays it over the server's `down`, while the row still shows `down`.
      final outbox = _ColdStartFeedbackOutboxStore(
        firstReadDelay: const Duration(milliseconds: 300),
        entries: <FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 7,
            rating: TurnFeedbackRating.up,
          ),
        ],
      );
      final ratings = <String>[];
      final client = MockClient((request) async {
        if (request.method != 'POST') return http.Response('', 204);
        final body = jsonDecode(request.body);
        final rating = body['rating'].toString();
        ratings.add(rating);
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-${ratings.length}',
            'clientUserMessageId': 'msg-1',
            'rating': rating,
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(
        client,
        outbox,
        storeTimeout: const Duration(milliseconds: 50),
      );

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(result.synced, isTrue);
      expect(
        outbox.entries,
        isEmpty,
        reason:
            'the thumbs-down began after the queued rating was persisted, so '
            'it supersedes it whether or not its sequence says so',
      );

      await repo.flushOutbox();
      expect(ratings, <String>[
        'down',
      ], reason: 'the stale up must never be replayed over the recorded down');
    });

    test(
      'a rating whose seq-issuing read FAILED sweeps the stale entry too',
      () async {
        // The same defect without a timeout: `_readLocked` throwing on the
        // FIRST read and succeeding afterwards. This is the case the existing
        // `failRead: true` fixtures cannot reach -- with every read failing,
        // `settle` never gets past its own read to the sweep.
        final outbox = _ColdStartFeedbackOutboxStore(
          firstReadThrows: true,
          entries: <FeedbackOutboxEntry>[
            seeded(
              kind: FeedbackOutboxKind.rate,
              seq: 7,
              rating: TurnFeedbackRating.up,
            ),
          ],
        );
        final client = MockClient(
          (request) async => http.Response(jsonEncode(summaryJson), 200),
        );
        final repo = build(client, outbox);

        final result = await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );

        expect(result.synced, isTrue);
        expect(outbox.entries, isEmpty);
      },
    );

    test('a rating whose seq-issuing read failed is still allowed to QUEUE '
        'over a stale entry', () async {
      // The insertion half. `queue` refuses when the row it would replace is
      // strictly newer -- a comparison that inverts under an untrusted
      // sequence, so the write the user just made is reported `dropped` and
      // the row keeps showing the OLD rating with nothing queued to correct
      // it.
      final outbox = _ColdStartFeedbackOutboxStore(
        firstReadThrows: true,
        entries: <FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 7,
            rating: TurnFeedbackRating.up,
          ),
        ],
      );
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(
        result.dropped,
        isFalse,
        reason: 'the write is durably queued, not refused',
      );
      expect(outbox.entries.single.rating, TurnFeedbackRating.down);
    });

    test(
      'a rating whose seq-issuing read failed publishes a watermark that '
      'still supersedes the stale entry when the sweep cannot be saved',
      () async {
        // The watermark half, and why the sweep alone is not enough. Reads work
        // from the second one on, writes never do (Android `Editor.commit()`
        // returning false), so the stale row survives the sweep and the
        // watermark is the ONLY thing left that can keep the flush from
        // replaying it.
        final outbox = _ColdStartFeedbackOutboxStore(
          firstReadThrows: true,
          failWrites: true,
          entries: <FeedbackOutboxEntry>[
            seeded(
              kind: FeedbackOutboxKind.rate,
              seq: 7,
              rating: TurnFeedbackRating.up,
            ),
          ],
        );
        final ratings = <String>[];
        final client = MockClient((request) async {
          if (request.method != 'POST') return http.Response('', 204);
          final body = jsonDecode(request.body);
          final rating = body['rating'].toString();
          ratings.add(rating);
          return http.Response(
            jsonEncode(<String, dynamic>{
              'feedbackId': 'fb-${ratings.length}',
              'clientUserMessageId': 'msg-1',
              'rating': rating,
              'hasComment': false,
            }),
            200,
          );
        });
        final repo = build(client, outbox);

        await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
        expect(
          outbox.entries.single.seq,
          7,
          reason:
              'the sweep could not be persisted, so the stale entry remains',
        );

        await repo.flushOutbox();
        expect(
          ratings,
          <String>['down'],
          reason:
              'the settled write is newer than every persisted row, so the '
              'flush must skip the survivor rather than replay it',
        );
      },
    );

    // --- Guards the round-4 mutation sweep found unpinned. Each mutation
    // below shipped green before these tests existed.

    test('a flush skips an entry a settle superseded while the flush was '
        'mid-network', () async {
      // The read half of the ordering rule inside the replay loop. Two turns
      // are queued; the flush hangs on the first, and while it hangs the user
      // retracts the SECOND turn's still-pending rating. The snapshot the
      // flush is walking cannot know that -- the watermark can.
      final outbox = InMemoryFeedbackOutboxStore();
      final firstPostReceived = Completer<void>();
      final releaseFirstPost = Completer<void>();
      final posted = <String>[];
      String? heldId;
      var offline = true;
      final client = MockClient((request) async {
        if (offline) return http.Response('', 503);
        final body = jsonDecode(request.body);
        final id = body is Map ? '${body['clientUserMessageId']}' : '?';
        posted.add(id);
        if (heldId == null) {
          heldId = id;
          firstPostReceived.complete();
          await releaseFirstPost.future;
        }
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-$id',
            'clientUserMessageId': id,
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = build(client, outbox);

      for (final id in <String>['msg-1', 'msg-2']) {
        final queued = await repo.rate(
          clientUserMessageId: id,
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
        expect(queued.synced, isFalse);
      }
      expect(await outbox.read(), hasLength(2));
      offline = false;

      final flush = repo.flushOutbox();
      await firstPostReceived.future;

      // The user retracts the OTHER turn while the flush is stuck on this
      // one. Which entry the replay reaches first is the store's business,
      // so the test follows it rather than assuming an order.
      final held = heldId ?? '';
      final retracted = held == 'msg-1' ? 'msg-2' : 'msg-1';
      final retraction = await repo.clear(
        clientUserMessageId: retracted,
        clientChatId: 'chat-1',
      );
      expect(retraction.synced, isTrue);

      releaseFirstPost.complete();
      await flush;

      expect(posted, <String>[
        held,
      ], reason: '$retracted was retracted after the snapshot was taken');
      expect(await outbox.read(), isEmpty);
    });

    test(
      'a replayed retraction publishes the watermark its online verb would, '
      'so a rating whose POST is still in flight is not queued behind it',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        final postReceived = Completer<void>();
        final releasePost = Completer<void>();
        var deletes = 0;
        final client = MockClient((request) async {
          if (request.method == 'DELETE') {
            deletes += 1;
            return http.Response('', 204);
          }
          postReceived.complete();
          await releasePost.future;
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        final rating = repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        await postReceived.future;

        await outbox.write(<FeedbackOutboxEntry>[
          seeded(kind: FeedbackOutboxKind.clear, seq: 50, feedbackId: 'fb-1'),
        ]);
        await repo.flushOutbox();
        expect(deletes, 1);

        releasePost.complete();
        final result = await rating;

        expect(result.dropped, isTrue);
        expect(
          await outbox.read(),
          isEmpty,
          reason:
              'the replayed retraction is the turn\'s newest truth; queueing '
              'this rating would undo it at the next flush',
        );
      },
    );

    test('a replayed detail publishes the watermark, so an older detail whose '
        'PATCH is still in flight is not queued behind it', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final staleReceived = Completer<void>();
      final releaseStale = Completer<void>();
      var patches = 0;
      final client = MockClient((request) async {
        patches += 1;
        if (patches == 1) {
          staleReceived.complete();
          await releaseStale.future;
          return http.Response('', 503);
        }
        return http.Response('', 204);
      });
      final repo = build(client, outbox);

      final stale = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'stale comment',
      );
      await staleReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 50,
          feedbackId: 'fb-1',
          comment: 'newer comment',
        ),
      ]);
      await repo.flushOutbox();
      expect(patches, 2);
      expect(await outbox.read(), isEmpty);

      releaseStale.complete();
      final staleResult = await stale;

      expect(staleResult.dropped, isTrue);
      expect(
        await outbox.read(),
        isEmpty,
        reason:
            'a newer comment already reached the server, so the stale one '
            'must not replay over it',
      );
    });

    test("a replayed detail's watermark stays narrowed to detail, so a rating "
        'the server has never seen is still queued', () async {
      // The narrowing is the whole point of publishing per kind: a detail
      // PATCH landing says nothing about a RATING the server has not seen, so
      // it must not refuse one.
      final outbox = InMemoryFeedbackOutboxStore();
      final postReceived = Completer<void>();
      final releasePost = Completer<void>();
      final client = MockClient((request) async {
        if (request.method == 'PATCH') return http.Response('', 204);
        postReceived.complete();
        await releasePost.future;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final rating = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await postReceived.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.detail,
          seq: 50,
          feedbackId: 'fb-1',
          comment: 'a comment on the previous rating',
        ),
      ]);
      await repo.flushOutbox();
      expect(await outbox.read(), isEmpty);

      releasePost.complete();
      final result = await rating;

      expect(result.synced, isFalse);
      expect(
        result.dropped,
        isFalse,
        reason: 'a detail replay supersedes details, not ratings',
      );
      final queued = (await outbox.read()).single;
      expect(queued.kind, FeedbackOutboxKind.rate);
      expect(queued.rating, TurnFeedbackRating.down);
    });

    test('a retraction with nothing to DELETE sweeps the detail queued by the '
        'PATCH it was issued behind', () async {
      // The retraction is serialized behind the detail rather than racing it,
      // so it runs once the PATCH has failed and queued. Its empty-handed
      // settle is what removes that entry: a comment describing a rating the
      // user retracted must not stay queued.
      final outbox = InMemoryFeedbackOutboxStore();
      final patchReceived = Completer<void>();
      final releasePatch = Completer<void>();
      final client = MockClient((request) async {
        patchReceived.complete();
        await releasePatch.future;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final detail = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        reason: TurnFeedbackReason.gotStuck,
      );
      await patchReceived.future;

      final retraction = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );
      await pumpEventQueue();

      releasePatch.complete();
      final detailResult = await detail;
      expect(
        detailResult.dropped,
        isFalse,
        reason: 'the detail was durably queued before the retraction ran',
      );

      final retractionResult = await retraction;
      expect(retractionResult.dropped, isFalse);
      expect(
        await outbox.read(),
        isEmpty,
        reason:
            'a comment describing a rating the user retracted must not stay '
            'queued behind the retraction',
      );
    });

    test('a retraction that dropped only a queued detail is not reported as a '
        'completed retraction', () async {
      // `synced` on the no-feedbackId path means "the pending RATING is
      // gone". Sweeping a lone detail retracts nothing the user can see.
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final detail = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        reason: TurnFeedbackReason.gotStuck,
      );
      expect(detail.synced, isFalse);
      expect(await outbox.read(), hasLength(1));

      final retraction = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );

      expect(retraction.synced, isFalse);
      expect(retraction.dropped, isFalse);
      expect(await outbox.read(), isEmpty);
    });

    test("a queued detail never merges into ANOTHER account's entry for the "
        'same turn', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      var current = accountB;
      final repo = build(client, outbox, accountId: () => current);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      expect(await outbox.read(), hasLength(1));

      current = accountA;
      final detail = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-a',
        comment: 'mine',
      );
      expect(detail.synced, isFalse);

      final entries = await outbox.read();
      expect(
        entries,
        hasLength(2),
        reason:
            "merging would file this account's comment under the other "
            "account's queued rating",
      );
      final other = entries.firstWhere((e) => e.accountId == accountB);
      expect(other.kind, FeedbackOutboxKind.rate);
      expect(other.comment, isNull);
      final mine = entries.firstWhere((e) => e.accountId == accountA);
      expect(mine.kind, FeedbackOutboxKind.detail);
      expect(mine.comment, 'mine');
    });

    test('merging a reason into a queued rating keeps the comment already '
        'queued with it', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        comment: 'it looped forever',
      );
      // A second detail carrying only a reason must refine the first, not
      // erase the comment the user already typed.
      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        reason: TurnFeedbackReason.gotStuck,
      );

      final entry = (await outbox.read()).single;
      expect(entry.kind, FeedbackOutboxKind.rate);
      expect(entry.rating, TurnFeedbackRating.down);
      expect(entry.comment, 'it looped forever');
      expect(entry.reason, TurnFeedbackReason.gotStuck);
    });

    test('a fresh repository issues sequences above the queue a previous run '
        'persisted', () async {
      // The ordering counter restarts at zero on every launch; the persisted
      // queue does not. Without raising it past what is on disk, the first
      // write after a restart looks OLDER than everything already queued and
      // its successful settle sweeps nothing.
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[
        FeedbackOutboxEntry(
          kind: FeedbackOutboxKind.rate,
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          accountId: accountA,
          rating: TurnFeedbackRating.up,
          queuedAtMs: 1757000000000,
          seq: 100,
        ),
      ]);
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(result.synced, isTrue);
      expect(
        await outbox.read(),
        isEmpty,
        reason: 'the new rating is newer than anything the last run queued',
      );
    });

    test('a successful write sweeps only its OWN turn', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      var offline = true;
      final client = MockClient(
        (request) async => offline
            ? http.Response('', 503)
            : http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);

      for (final id in <String>['msg-1', 'msg-2']) {
        await repo.rate(
          clientUserMessageId: id,
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
      }
      expect(await outbox.read(), hasLength(2));

      offline = false;
      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(result.synced, isTrue);

      final remaining = await outbox.read();
      expect(remaining, hasLength(1));
      expect(remaining.single.clientUserMessageId, 'msg-2');
    });

    test('a store that cannot be READ reports the queue attempt as dropped '
        'instead of throwing', () async {
      // The companion to the failing-WRITE case: the queue insert reads the
      // store before it writes, and that read is on the failure path of every
      // rating.
      final outbox = _FailingFeedbackOutboxStore(failRead: true);
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      expect(result.synced, isFalse);
      expect(result.dropped, isTrue);
    });

    test('an overlapping flush does not re-send what the first one is still '
        'mid-network on', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final replayReceived = Completer<void>();
      final releaseReplay = Completer<void>();
      var posts = 0;
      final client = MockClient((request) async {
        posts += 1;
        if (posts == 1) return http.Response('', 503);
        if (posts == 2) {
          replayReceived.complete();
          await releaseReplay.future;
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(await outbox.read(), hasLength(1));

      final first = repo.flushOutbox();
      await replayReceived.future;
      // A resume fires a second flush while the first is still mid-network.
      // The entry it would replay has not been removed yet, because removal
      // happens after the loop.
      await repo.flushOutbox();
      releaseReplay.complete();
      await first;

      expect(posts, 2, reason: 'the rating must not be recorded twice');
      expect(await outbox.read(), isEmpty);
    });

    test('flushOutbox degrades when its initial store read fails', () async {
      final outbox = _FailingFeedbackOutboxStore(failRead: true);
      final repo = build(
        MockClient((request) async => http.Response('', 500)),
        outbox,
      );

      await expectLater(repo.flushOutbox(), completes);
    });

    test('flushOutbox degrades when removing sent entries fails', () async {
      final outbox = _FailingOnWriteFeedbackOutboxStore(
        failOnWrite: 2,
        entries: <FeedbackOutboxEntry>[
          const FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: 'msg-1',
            clientChatId: 'chat-1',
            accountId: accountA,
            rating: TurnFeedbackRating.down,
            queuedAtMs: 1757000000000,
            seq: 1,
          ),
        ],
      );
      var posts = 0;
      final repo = build(
        MockClient((request) async {
          posts += 1;
          return http.Response(jsonEncode(summaryJson), 200);
        }),
        outbox,
      );

      await expectLater(repo.flushOutbox(), completes);
      expect(posts, 1);
    });

    // --- FIX 1: at most one in-flight network write per (account, turn). ---
    //
    // Every race rounds 1-5 chased needs two concurrent writes against one
    // turn, and `TurnFeedbackRow` hands one out for free: a double-tap issues
    // two `unawaited` requests. These pin the serialization itself, at the
    // only layer that owns the outbox.

    test('a second write for the same turn does not open its request until '
        'the first has settled', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final upReceived = Completer<void>();
      final releaseUp = Completer<void>();
      var requests = 0;
      final client = MockClient((request) async {
        requests += 1;
        final body = jsonDecode(request.body);
        if (body is Map && body['rating'] == 'up') {
          upReceived.complete();
          await releaseUp.future;
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final up = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await upReceived.future;

      final down = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      // Everything that CAN run without the first write finishing, has.
      await pumpEventQueue();
      expect(
        requests,
        1,
        reason:
            'the second tap must not put a second request on the wire for '
            'the same turn while the first is still in flight',
      );

      releaseUp.complete();
      await up;
      await down;
      expect(requests, 2);
    });

    test('a detail submitted while its rating is still in flight waits for '
        'the rating', () async {
      // The programmatic half of the same hazard: the thumbs-down sheet
      // submits a detail without any tap, so a disabled button cannot be the
      // mechanism.
      final outbox = InMemoryFeedbackOutboxStore();
      final rateReceived = Completer<void>();
      final releaseRate = Completer<void>();
      var patches = 0;
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          patches += 1;
          return http.Response('', 204);
        }
        rateReceived.complete();
        await releaseRate.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final rating = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await rateReceived.future;

      final detail = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'too slow',
      );
      await pumpEventQueue();
      expect(
        patches,
        0,
        reason: 'the PATCH must wait for the rating write to settle',
      );

      releaseRate.complete();
      await rating;
      expect((await detail).synced, isTrue);
      expect(patches, 1);
    });

    test(
      'a write against a DIFFERENT turn is not blocked by one in flight',
      () async {
        // The serialization is per turn, not global: rating one turn must not
        // stall rating another.
        final outbox = InMemoryFeedbackOutboxStore();
        final firstReceived = Completer<void>();
        final releaseFirst = Completer<void>();
        final client = MockClient((request) async {
          final body = jsonDecode(request.body);
          if (body is Map && body['clientUserMessageId'] == 'msg-1') {
            firstReceived.complete();
            await releaseFirst.future;
          }
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox);

        final first = repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        await firstReceived.future;

        // Resolves while `msg-1` is still hung, or this hangs forever.
        final second = await repo.rate(
          clientUserMessageId: 'msg-2',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        expect(second.synced, isTrue);

        releaseFirst.complete();
        expect((await first).synced, isTrue);
      },
    );

    test('a write that THROWS does not wedge the turn behind it', () async {
      // The chain slot is released in a `finally`, so an unanticipated error
      // on the write path costs one write, not the turn.
      final outbox = InMemoryFeedbackOutboxStore();
      var clockCalls = 0;
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(
        client,
        outbox,
        now: () {
          clockCalls += 1;
          // The stamp `queue` puts on the FIRST failed write.
          if (clockCalls == 1) throw StateError('clock unavailable');
          return DateTime.fromMillisecondsSinceEpoch(1757000000000);
        },
      );

      await expectLater(
        repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        ),
        throwsStateError,
      );

      // Same turn: it must not still be waiting on the write that threw.
      final second = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(second.dropped, isFalse);
      expect((await outbox.read()).single.rating, TurnFeedbackRating.down);
    });

    test('a request that never answers releases the turn instead of holding '
        'it forever', () async {
      // The bound on the chain. Without it a socket that never replies parks
      // the turn permanently and every later tap on it hangs.
      final outbox = InMemoryFeedbackOutboxStore();
      final never = Completer<void>();
      addTearDown(() => never.complete());
      final client = MockClient((request) async {
        final body = jsonDecode(request.body);
        if (body is Map && body['rating'] == 'up') await never.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, requestTimeout: Duration.zero);

      final up = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      // Abandoned as an ordinary retryable failure: durably queued, not lost.
      expect(up.synced, isFalse);
      expect(up.dropped, isFalse);

      final down = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(down.synced, isTrue);
    });

    test('eviction drops the LEAST RECENTLY settled turn, not the first one '
        'ever settled', () async {
      // The bound is only tolerable because the turn it sacrifices is the one
      // least likely to still have a request in flight. A map that kept plain
      // insertion order would evict the turn that has settled most recently
      // AND most often, which is the opposite choice.
      const capacity = HttpTurnFeedbackRepository.settledWatermarkCapacity;
      final outbox = InMemoryFeedbackOutboxStore();
      final upReceived = Completer<void>();
      final releaseUp = Completer<void>();
      final client = MockClient((request) async {
        final body = jsonDecode(request.body);
        if (body is Map &&
            body['clientUserMessageId'] == 'msg-0' &&
            body['rating'] == 'up') {
          upReceived.complete();
          await releaseUp.future;
          return http.Response('', 503);
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final up = repo.rate(
        clientUserMessageId: 'msg-0',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await upReceived.future;

      // msg-0 settles FIRST...
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          turn: 'msg-0',
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();

      // ...then half the capacity of other turns settle...
      for (var i = 1; i <= capacity ~/ 2; i++) {
        await repo.rate(
          clientUserMessageId: 'msg-$i',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
      }

      // ...then msg-0 settles AGAIN, making it the most recently settled...
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 60,
          turn: 'msg-0',
          rating: TurnFeedbackRating.down,
        ),
      ]);
      await repo.flushOutbox();

      // ...and the rest of the capacity settles on top.
      for (var i = capacity ~/ 2 + 1; i <= capacity; i++) {
        await repo.rate(
          clientUserMessageId: 'msg-$i',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
      }

      releaseUp.complete();
      expect(
        (await up).dropped,
        isTrue,
        reason:
            "msg-0's watermark was refreshed midway, so it must not be the "
            'entry the cap evicts',
      );
    });

    test("a newer entry belonging to ANOTHER account does not refuse this "
        "account's queue", () async {
      // The stale-replacement rule compares against the row this write would
      // REPLACE. `upsertFeedbackOutbox` keys on account + turn, so another
      // account's row for the same turn is a different slot entirely and
      // cannot be the thing being replaced.
      final outbox = InMemoryFeedbackOutboxStore();
      final received = Completer<void>();
      final release = Completer<void>();
      final client = MockClient((request) async {
        received.complete();
        await release.future;
        return http.Response('', 503);
      });
      final repo = build(client, outbox);

      final rating = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await received.future;

      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 50,
          account: accountB,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      release.complete();
      expect((await rating).dropped, isFalse);
      final entries = await outbox.read();
      expect(entries, hasLength(2));
      expect(
        entries.singleWhere((entry) => entry.accountId == accountA).rating,
        TurnFeedbackRating.up,
      );
    });

    test(
      'a newer entry for a DIFFERENT turn does not refuse this queue',
      () async {
        // Same rule, the other coordinate: the turn's slot is its own.
        final outbox = InMemoryFeedbackOutboxStore();
        final received = Completer<void>();
        final release = Completer<void>();
        final client = MockClient((request) async {
          received.complete();
          await release.future;
          return http.Response('', 503);
        });
        final repo = build(client, outbox);

        final rating = repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        await received.future;

        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 50,
            turn: 'msg-2',
            rating: TurnFeedbackRating.down,
          ),
        ]);

        release.complete();
        expect((await rating).dropped, isFalse);
        final entries = await outbox.read();
        expect(entries, hasLength(2));
        expect(
          entries
              .singleWhere((entry) => entry.clientUserMessageId == 'msg-1')
              .rating,
          TurnFeedbackRating.up,
        );
      },
    );

    test('queueing prunes entries that have aged out', () async {
      // The insert is the outbox's only growth path, so it is where the age
      // cutoff has to be applied; otherwise a device that is offline for a
      // month replays month-old ratings on the next connection.
      final outbox = InMemoryFeedbackOutboxStore();
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          turn: 'msg-old',
          rating: TurnFeedbackRating.down,
          queuedAtMs:
              1757000000000 - feedbackOutboxMaxAge.inMilliseconds - 1000,
        ),
      ]);
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      final entries = await outbox.read();
      expect(entries, hasLength(1));
      expect(entries.single.clientUserMessageId, 'msg-1');
    });

    test('a write issued after the first one finished still waits on the '
        'second', () async {
      // Releasing a slot must leave the tail a successor registered alone.
      // Clearing it unconditionally lets the NEXT write start beside the one
      // that is still running, which is the same double-write this fix exists
      // to remove.
      final outbox = InMemoryFeedbackOutboxStore();
      final firstReceived = Completer<void>();
      final releaseFirst = Completer<void>();
      final secondReceived = Completer<void>();
      final releaseSecond = Completer<void>();
      var requests = 0;
      final client = MockClient((request) async {
        requests += 1;
        final n = requests;
        if (n == 1) {
          firstReceived.complete();
          await releaseFirst.future;
        } else if (n == 2) {
          secondReceived.complete();
          await releaseSecond.future;
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await firstReceived.future;

      final second = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      releaseFirst.complete();
      await first;
      // The second write now owns the turn.
      await secondReceived.future;

      final third = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await pumpEventQueue();
      expect(
        requests,
        2,
        reason:
            'the third write must wait on the second, not on the slot the '
            'first one already released',
      );

      releaseSecond.complete();
      await second;
      await third;
      expect(requests, 3);
    });

    test(
      'a retraction whose request never answers releases the turn',
      () async {
        final outbox = InMemoryFeedbackOutboxStore();
        final never = Completer<void>();
        addTearDown(() => never.complete());
        final client = MockClient((request) async {
          if (request.method == 'DELETE') await never.future;
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox, requestTimeout: Duration.zero);

        final retraction = await repo.clear(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          feedbackId: 'fb-1',
        );
        expect(retraction.synced, isFalse);
        expect(retraction.dropped, isFalse);
        expect((await outbox.read()).single.kind, FeedbackOutboxKind.clear);

        final rating = await repo.rate(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.down,
          context: const TurnFeedbackContext(),
        );
        expect(rating.synced, isTrue);
      },
    );

    test('a detail whose PATCH never answers releases the turn', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final never = Completer<void>();
      addTearDown(() => never.complete());
      final client = MockClient((request) async {
        if (request.method == 'PATCH') await never.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, requestTimeout: Duration.zero);

      final detail = await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'it looped forever',
      );
      expect(detail.synced, isFalse);
      expect(detail.dropped, isFalse);
      expect((await outbox.read()).single.comment, 'it looped forever');

      final rating = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      expect(rating.synced, isTrue);
    });

    test('merging a comment into a queued rating keeps the reason already '
        'queued with it', () async {
      // The mirror of the comment case: a merge refines the queued row, it
      // does not rewrite the fields it was not given.
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async => http.Response('', 503));
      final repo = build(client, outbox);

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        reason: TurnFeedbackReason.gotStuck,
      );
      await repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        comment: 'it looped forever',
      );

      final queued = (await outbox.read()).single;
      expect(queued.reason, TurnFeedbackReason.gotStuck);
      expect(queued.comment, 'it looped forever');
    });

    test(
      'a replay the server REFUSES outright is dropped from the queue',
      () async {
        // Matching every other write path: a 400 fails identically on every
        // retry, so leaving it queued burns the turn's slot forever.
        final outbox = InMemoryFeedbackOutboxStore();
        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 1,
            rating: TurnFeedbackRating.down,
          ),
        ]);
        var posts = 0;
        final client = MockClient((request) async {
          posts += 1;
          return http.Response('', 400);
        });
        final repo = build(client, outbox);

        await repo.flushOutbox();
        expect(posts, 1);
        expect(await outbox.read(), isEmpty);

        await repo.flushOutbox();
        expect(posts, 1, reason: 'nothing is left to retry');
      },
    );

    test('the settled-watermark map is bounded, and an evicted turn loses its '
        'supersession guard', () async {
      // The map lives on an app-lifetime singleton, so it is capped instead of
      // growing once per rated turn. The documented cost of that cap is
      // exactly what this asserts: the least-recently-settled turn stops being
      // able to refuse an older write.
      //
      // The count is DERIVED from the capacity rather than written out, and
      // the under-capacity run is here so a capacity change cannot quietly
      // turn the over-capacity run into a no-op that passes for the wrong
      // reason.
      const capacity = HttpTurnFeedbackRepository.settledWatermarkCapacity;
      expect(capacity, greaterThan(0));

      Future<TurnFeedbackWriteResult> runWithOtherTurns(int otherTurns) async {
        final outbox = InMemoryFeedbackOutboxStore();
        final upReceived = Completer<void>();
        final releaseUp = Completer<void>();
        final client = MockClient((request) async {
          final body = jsonDecode(request.body);
          if (body is Map &&
              body['clientUserMessageId'] == 'msg-0' &&
              body['rating'] == 'up') {
            upReceived.complete();
            await releaseUp.future;
            return http.Response('', 503);
          }
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox);

        final up = repo.rate(
          clientUserMessageId: 'msg-0',
          clientChatId: 'chat-1',
          rating: TurnFeedbackRating.up,
          context: const TurnFeedbackContext(),
        );
        await upReceived.future;

        // msg-0 now has a watermark that would refuse the hung `up`...
        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 50,
            turn: 'msg-0',
            rating: TurnFeedbackRating.down,
          ),
        ]);
        await repo.flushOutbox();

        // ...until enough OTHER turns settle to evict it.
        for (var i = 1; i <= otherTurns; i++) {
          await repo.rate(
            clientUserMessageId: 'msg-$i',
            clientChatId: 'chat-1',
            rating: TurnFeedbackRating.down,
            context: const TurnFeedbackContext(),
          );
        }

        releaseUp.complete();
        return up;
      }

      final stillGuarded = await runWithOtherTurns(capacity - 1);
      expect(
        stillGuarded.dropped,
        isTrue,
        reason:
            'at capacity the watermark is still there and still refuses the '
            'abandoned rating',
      );

      final evicted = await runWithOtherTurns(capacity);
      expect(
        evicted.dropped,
        isFalse,
        reason:
            'one turn past capacity the least-recently-settled watermark is '
            'evicted and the guard is gone — the documented cost of the bound',
      );
    });

    // --- Round 6: the replay loop, the last writer the serialization rule
    // does not cover. ---

    test(
      'flushOutbox reports the feedbackId every replayed rating learned',
      () async {
        // The replay is the only path that obtains a feedbackId and had no way
        // to hand it back: `flushOutbox` returned `Future<void>`. A rating that
        // drains out of the outbox therefore left the controller believing the
        // turn had no server row at all, and the next retraction took `clear`'s
        // "nothing to retract" branch.
        final outbox = InMemoryFeedbackOutboxStore();
        final client = MockClient(
          (request) async => http.Response(jsonEncode(summaryJson), 200),
        );
        final repo = build(client, outbox);
        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.rate,
            seq: 1,
            rating: TurnFeedbackRating.down,
          ),
        ]);

        final replayed = await repo.flushOutbox();

        expect(replayed, hasLength(1));
        expect(replayed.single.clientChatId, 'chat-1');
        expect(replayed.single.clientUserMessageId, 'msg-1');
        expect(replayed.single.feedbackId, 'fb-1');
      },
    );

    test(
      'flushOutbox reports nothing for a replayed clear or detail',
      () async {
        // Only a `rate` learns an id. A retraction removes the row and a detail
        // patches one whose id the caller already had.
        final outbox = InMemoryFeedbackOutboxStore();
        final client = MockClient(
          (request) async => http.Response(jsonEncode(summaryJson), 200),
        );
        final repo = build(client, outbox);
        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: FeedbackOutboxKind.clear,
            seq: 1,
            turn: 'msg-1',
            feedbackId: 'fb-1',
          ),
          seeded(
            kind: FeedbackOutboxKind.detail,
            seq: 2,
            turn: 'msg-2',
            feedbackId: 'fb-2',
            comment: 'looped',
          ),
        ]);

        expect(await repo.flushOutbox(), isEmpty);
      },
    );

    test('a clear issued after a replayed POST lands can use its feedbackId '
        'before the rest of the flush completes', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final patchStarted = Completer<void>();
      final releasePatch = Completer<void>();
      final requests = <http.BaseRequest>[];
      final client = MockClient((request) async {
        requests.add(request);
        if (request.method == 'POST') {
          return http.Response(jsonEncode(summaryJson), 200);
        }
        if (request.method == 'PATCH') {
          patchStarted.complete();
          await releasePatch.future;
          return http.Response('', 204);
        }
        if (request.method == 'DELETE') return http.Response('', 204);
        return http.Response('', 500);
      });
      final repo = build(client, outbox);
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          rating: TurnFeedbackRating.down,
          comment: 'details keep the flush open',
        ),
      ]);

      final flush = repo.flushOutbox();
      await patchStarted.future;

      final cleared = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );

      expect(cleared.synced, isTrue);
      expect(
        requests.where((request) => request.method == 'DELETE'),
        hasLength(1),
        reason: 'the replayed POST already returned feedbackId fb-1',
      );
      releasePatch.complete();
      await flush;
    });

    test('a retryable clear issued during replay queues the feedbackId learned '
        'by that replay', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      final patchStarted = Completer<void>();
      final releasePatch = Completer<void>();
      final client = MockClient((request) async {
        if (request.method == 'POST') {
          return http.Response(jsonEncode(summaryJson), 200);
        }
        if (request.method == 'PATCH') {
          patchStarted.complete();
          await releasePatch.future;
          return http.Response('', 204);
        }
        if (request.method == 'DELETE') return http.Response('', 503);
        return http.Response('', 500);
      });
      final repo = build(client, outbox);
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          rating: TurnFeedbackRating.down,
          comment: 'details keep the flush open',
        ),
      ]);

      final flush = repo.flushOutbox();
      await patchStarted.future;
      final cleared = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
      );

      expect(cleared.synced, isFalse);
      expect(cleared.dropped, isFalse);
      final queuedClear = (await outbox.read()).single;
      expect(queuedClear.kind, FeedbackOutboxKind.clear);
      expect(queuedClear.feedbackId, 'fb-1');

      releasePatch.complete();
      await flush;
      expect((await outbox.read()).single.feedbackId, 'fb-1');
    });

    for (final kind in FeedbackOutboxKind.values) {
      test('a replayed ${kind.name} whose request never answers is abandoned '
          'instead of wedging every later flush', () async {
        // The three replay requests were the only network calls in the class
        // not bounded by `requestTimeout`, and `_flushing` is cleared only in the
        // `finally` of a `flushOutbox()` that never returns — so one half-open
        // socket disabled BOTH flush triggers (resume and sign-in) for the rest
        // of the process. Every kind, because each one is its own call site.
        final outbox = InMemoryFeedbackOutboxStore();
        final never = Completer<void>();
        addTearDown(() => never.complete());
        var requests = 0;
        final client = MockClient((request) async {
          requests += 1;
          await never.future;
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox, requestTimeout: Duration.zero);
        await outbox.write(<FeedbackOutboxEntry>[
          seeded(
            kind: kind,
            seq: 1,
            feedbackId: 'fb-1',
            rating: TurnFeedbackRating.down,
            comment: kind == FeedbackOutboxKind.detail ? 'looped' : null,
          ),
        ]);

        await repo.flushOutbox().timeout(const Duration(seconds: 5));

        expect(requests, 1);
        expect(
          (await outbox.read()).single.kind,
          kind,
          reason: 'a TimeoutException is retryable, so the entry stays queued',
        );

        // The cost of a timeout is that entry, not the whole flush trigger.
        await repo.flushOutbox().timeout(const Duration(seconds: 5));
        expect(requests, 2);
      });
    }

    test('a replayed rating whose follow-up PATCH never answers is abandoned '
        'too', () async {
      // The fourth unbounded call, in the same loop: the optional detail
      // PATCH that follows a replayed rating.
      final outbox = InMemoryFeedbackOutboxStore();
      final never = Completer<void>();
      addTearDown(() => never.complete());
      var patches = 0;
      final client = MockClient((request) async {
        if (request.method == 'PATCH') {
          patches += 1;
          await never.future;
        }
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, requestTimeout: Duration.zero);
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          rating: TurnFeedbackRating.down,
          comment: 'looped forever',
        ),
      ]);

      final replayed = await repo.flushOutbox().timeout(
        const Duration(seconds: 5),
      );

      expect(patches, 1);
      expect(
        (await outbox.read()).single.comment,
        'looped forever',
        reason: 'the comment is still owed to the server, so it stays queued',
      );
      expect(
        replayed.single.feedbackId,
        'fb-1',
        reason:
            'the POST landed, so the id is real and must be reported whether '
            'or not the optional PATCH after it did',
      );
    });

    test('a flush prunes an entry older than the 14-day bound instead of '
        'replaying it', () async {
      // The flush read is a prune-and-read: a queue on a device that has been
      // offline for a month is a storage leak, not durability, and a month-old
      // rating is not something the user still means to send.
      final outbox = InMemoryFeedbackOutboxStore();
      var requests = 0;
      final client = MockClient((request) async {
        requests += 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      const nowMs = 1757000000000;
      final repo = build(
        client,
        outbox,
        now: () => DateTime.fromMillisecondsSinceEpoch(nowMs),
      );
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          rating: TurnFeedbackRating.down,
          queuedAtMs: nowMs - const Duration(days: 15).inMilliseconds,
        ),
      ]);

      await repo.flushOutbox();

      expect(requests, 0);
      expect(await outbox.read(), isEmpty);
    });

    test('a retraction that reaches the server sweeps a rating queued for the '
        'same turn by an earlier run', () async {
      // `clear`'s success settle sweeps EVERY kind on purpose: the retraction
      // is the turn's newest truth, so a queued rating from before it is
      // stale. Narrowing it to `clear` would let the swept rating replay and
      // resurrect what the user just took back.
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient(
        (request) async => http.Response(jsonEncode(summaryJson), 200),
      );
      final repo = build(client, outbox);
      await outbox.write(<FeedbackOutboxEntry>[
        seeded(
          kind: FeedbackOutboxKind.rate,
          seq: 1,
          rating: TurnFeedbackRating.down,
        ),
      ]);

      final result = await repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );

      expect(result.synced, isTrue);
      expect(await outbox.read(), isEmpty);
    });

    test(
      'a settle whose store read fails still publishes its watermark',
      () async {
        // The watermark is recorded in memory BEFORE the sweep's store read, so
        // a failing store costs this turn its sweep and never its ordering.
        // Published after the read instead, a broken store would silently
        // re-admit every older write — the exact "durability, never the write"
        // rule inverted.
        final outbox = _FailingOnReadFeedbackOutboxStore(
          failOnRead: 2,
          entries: <FeedbackOutboxEntry>[
            FeedbackOutboxEntry(
              kind: FeedbackOutboxKind.rate,
              clientUserMessageId: 'msg-1',
              clientChatId: 'chat-1',
              accountId: accountA,
              rating: TurnFeedbackRating.down,
              queuedAtMs: 1757000000000,
              seq: 1,
            ),
          ],
        );
        var posts = 0;
        final client = MockClient((request) async {
          if (request.method == 'POST') posts += 1;
          return http.Response(jsonEncode(summaryJson), 200);
        });
        final repo = build(client, outbox);

        // Read #1 issues the sequence; read #2 is the settle sweep, and fails.
        final result = await repo.clear(
          clientUserMessageId: 'msg-1',
          clientChatId: 'chat-1',
          feedbackId: 'fb-1',
        );
        expect(result.synced, isTrue);
        expect(
          await outbox.read(),
          hasLength(1),
          reason: 'the sweep could not run, so the stale row is still there',
        );

        await repo.flushOutbox();

        expect(
          posts,
          0,
          reason:
              'the watermark still supersedes it, so the flush must refuse to '
              'replay a rating the retraction already ruled out',
        );
      },
    );

    test('a write whose account changes while it waits for its turn is not '
        'sent under the new account', () async {
      // `_runWrite` reads the account on the SYNCHRONOUS path, but the
      // successor's request does not open until the predecessor releases the
      // slot — up to `requestTimeout` later. `service.*` builds its headers from
      // the LIVE session, so without a re-check immediately before the request
      // a `clear` stamped under one account goes out under another.
      // `flushOutbox` already re-checks per iteration; the verbs did not.
      final outbox = InMemoryFeedbackOutboxStore();
      var account = accountA;
      var posts = 0;
      final firstOpen = Completer<void>();
      final release = Completer<void>();
      final client = MockClient((request) async {
        posts += 1;
        if (!firstOpen.isCompleted) firstOpen.complete();
        await release.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => account);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await firstOpen.future;
      final second = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await pumpEventQueue();
      // Sign-out/sign-in while the successor waits for the slot.
      account = accountB;
      release.complete();
      await first;
      final result = await second;

      expect(posts, 1, reason: 'the successor must not be sent as acct-b');
      expect(result.synced, isFalse);
      expect(
        result.dropped,
        isFalse,
        reason: 'an ordinary retryable failure — durably queued, not lost',
      );
      final queued = (await outbox.read()).single;
      expect(queued.accountId, accountA);
      expect(queued.rating, TurnFeedbackRating.down);
    });

    test('a retraction whose account changes while it waits is not sent under '
        'the new account either', () async {
      // The verb the reviewer actually observed crossing accounts.
      final outbox = InMemoryFeedbackOutboxStore();
      var account = accountA;
      var deletes = 0;
      final firstOpen = Completer<void>();
      final release = Completer<void>();
      final client = MockClient((request) async {
        if (request.method == 'DELETE') deletes += 1;
        if (!firstOpen.isCompleted) firstOpen.complete();
        await release.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => account);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await firstOpen.future;
      final retraction = repo.clear(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
      );
      await pumpEventQueue();
      account = accountB;
      release.complete();
      await first;
      final result = await retraction;

      expect(deletes, 0);
      expect(result.synced, isFalse);
      expect(result.dropped, isFalse);
      expect((await outbox.read()).single.kind, FeedbackOutboxKind.clear);
    });

    test('a detail whose account changes while it waits is not PATCHed under '
        'the new account either', () async {
      final outbox = InMemoryFeedbackOutboxStore();
      var account = accountA;
      var patches = 0;
      final firstOpen = Completer<void>();
      final release = Completer<void>();
      final client = MockClient((request) async {
        if (request.method == 'PATCH') patches += 1;
        if (!firstOpen.isCompleted) firstOpen.complete();
        await release.future;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => account);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );
      await firstOpen.future;
      final detail = repo.attachDetail(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        feedbackId: 'fb-1',
        comment: 'it looped forever',
      );
      await pumpEventQueue();
      account = accountB;
      release.complete();
      await first;
      final result = await detail;

      expect(patches, 0);
      expect(result.synced, isFalse);
      expect(result.dropped, isFalse);
      expect((await outbox.read()).single.comment, 'it looped forever');
    });

    test('two writes issued in ONE event-loop turn still serialize', () async {
      // The real shape of `TurnFeedbackRow`'s `unawaited(onPressed())` firing
      // twice: the second call happens with NO await in between. Every other
      // serialization test waits for the first request to open first, which a
      // slot claimed one microtask late would still satisfy — so this is the
      // test that pins the claim to `_runWrite`'s synchronous path.
      final outbox = InMemoryFeedbackOutboxStore();
      var inFlight = 0;
      var maxInFlight = 0;
      final release = Completer<void>();
      final client = MockClient((request) async {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        await release.future;
        inFlight -= 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      final second = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      await pumpEventQueue();
      release.complete();
      await first;
      await second;

      expect(
        maxInFlight,
        1,
        reason: 'the slot must be claimed before the caller regains control',
      );
    });

    test('the write slot is keyed by ACCOUNT as well as turn', () async {
      // Two accounts rating the same turn id are independent writes. Dropping
      // `account` from the key would park the second behind the first — and,
      // worse, hand it the predecessor's ordering position on a turn whose
      // entries it may not touch.
      final outbox = InMemoryFeedbackOutboxStore();
      var account = accountA;
      var inFlight = 0;
      var maxInFlight = 0;
      final firstOpen = Completer<void>();
      final release = Completer<void>();
      final client = MockClient((request) async {
        inFlight += 1;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        if (!firstOpen.isCompleted) firstOpen.complete();
        await release.future;
        inFlight -= 1;
        return http.Response(jsonEncode(summaryJson), 200);
      });
      final repo = build(client, outbox, accountId: () => account);

      final first = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      await firstOpen.future;
      account = accountB;
      final second = repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.down,
        context: const TurnFeedbackContext(),
      );

      await pumpEventQueue();
      expect(
        maxInFlight,
        2,
        reason: "acct-b's write must not wait behind acct-a's",
      );
      release.complete();
      await first;
      await second;
    });
  });

  group('LiveConfigTurnFeedbackRepository', () {
    // A real HttpTurnFeedbackRepository backed by a MockClient that flips
    // httpReached to true the instant it is invoked -- so "never reaches the
    // HTTP path" is verified by the transport layer never firing, not by
    // inspecting a return value that could coincidentally match.
    ({
      HttpTurnFeedbackRepository repo,
      InMemoryFeedbackOutboxStore outbox,
      bool Function() wasReached,
    })
    buildHttp() {
      var reached = false;
      final outbox = InMemoryFeedbackOutboxStore();
      final client = MockClient((request) async {
        reached = true;
        return http.Response(
          jsonEncode(const <String, dynamic>{
            'feedbackId': 'fb-live',
            'clientUserMessageId': 'msg-1',
            'rating': 'up',
            'hasComment': false,
          }),
          200,
        );
      });
      final repo = HttpTurnFeedbackRepository(
        service: TurnFeedbackApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        ),
        outbox: outbox,
        accountId: () => 'acct-live',
      );
      return (repo: repo, outbox: outbox, wasReached: () => reached);
    }

    test('reviewer demo mode (isConfigured false) never reaches the HTTP '
        'transport and never queues into the outbox', () async {
      final httpFixture = buildHttp();
      final repo = LiveConfigTurnFeedbackRepository(
        isConfigured: () => false,
        http: httpFixture.repo,
        mock: MockTurnFeedbackRepository(),
      );

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      expect(httpFixture.wasReached(), isFalse);
      expect(await httpFixture.outbox.read(), isEmpty);
      // The mock repository still answers normally -- demo mode keeps
      // working, it just never talks to the real backend.
      expect(result.synced, isTrue);
    });

    test('auth configured (isConfigured true) takes the HTTP path', () async {
      final httpFixture = buildHttp();
      final repo = LiveConfigTurnFeedbackRepository(
        isConfigured: () => true,
        http: httpFixture.repo,
        mock: MockTurnFeedbackRepository(),
      );

      final result = await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );

      expect(httpFixture.wasReached(), isTrue);
      expect(result.feedbackId, 'fb-live');
    });

    test('re-checks isConfigured live on every call rather than freezing the '
        'choice at construction -- the same repository instance must route '
        'differently once the flag flips', () async {
      var configured = false;
      final httpFixture = buildHttp();
      final repo = LiveConfigTurnFeedbackRepository(
        isConfigured: () => configured,
        http: httpFixture.repo,
        mock: MockTurnFeedbackRepository(),
      );

      await repo.rate(
        clientUserMessageId: 'msg-1',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      expect(httpFixture.wasReached(), isFalse);

      configured = true;
      await repo.rate(
        clientUserMessageId: 'msg-2',
        clientChatId: 'chat-1',
        rating: TurnFeedbackRating.up,
        context: const TurnFeedbackContext(),
      );
      expect(httpFixture.wasReached(), isTrue);
    });
  });
}

/// A store that never answers, modelling a wedged `SharedPreferences`
/// platform channel rather than one that fails. It is the harder case: a
/// throw is caught by the six degradation sites, while a stall reaches none of
/// them without a bound.
final class _StallingFeedbackOutboxStore implements FeedbackOutboxStore {
  @override
  Future<List<FeedbackOutboxEntry>> read() =>
      Completer<List<FeedbackOutboxEntry>>().future;

  @override
  Future<void> write(List<FeedbackOutboxEntry> entries) =>
      Completer<void>().future;
}

/// Reads fine, never answers on write: the half of the store leg a read-only
/// bound would leave unbounded.
final class _StallingOnWriteFeedbackOutboxStore implements FeedbackOutboxStore {
  @override
  Future<List<FeedbackOutboxEntry>> read() async =>
      const <FeedbackOutboxEntry>[];

  @override
  Future<void> write(List<FeedbackOutboxEntry> entries) =>
      Completer<void>().future;
}

/// A store whose read and/or write fails, so the repository's degradation rule
/// -- a broken store costs durability, never the write -- is exercised without
/// a real `SharedPreferences` failure.
final class _FailingFeedbackOutboxStore implements FeedbackOutboxStore {
  _FailingFeedbackOutboxStore({this.failRead = false, this.failWrite = false});

  final bool failRead;
  final bool failWrite;
  List<FeedbackOutboxEntry> entries = const <FeedbackOutboxEntry>[];

  @override
  Future<List<FeedbackOutboxEntry>> read() async {
    if (failRead) throw Exception('store unavailable');
    return entries;
  }

  @override
  Future<void> write(List<FeedbackOutboxEntry> next) async {
    if (failWrite) throw Exception('store unavailable');
    entries = List<FeedbackOutboxEntry>.unmodifiable(next);
  }
}

final class _FailingOnWriteFeedbackOutboxStore implements FeedbackOutboxStore {
  _FailingOnWriteFeedbackOutboxStore({
    required this.failOnWrite,
    required List<FeedbackOutboxEntry> entries,
  }) : _entries = List<FeedbackOutboxEntry>.of(entries);

  final int failOnWrite;
  List<FeedbackOutboxEntry> _entries;
  int _writes = 0;

  @override
  Future<List<FeedbackOutboxEntry>> read() async =>
      List<FeedbackOutboxEntry>.of(_entries);

  @override
  Future<void> write(List<FeedbackOutboxEntry> next) async {
    _writes += 1;
    if (_writes == failOnWrite) throw Exception('store unavailable');
    _entries = List<FeedbackOutboxEntry>.of(next);
  }
}

/// A store whose FIRST touch is slow or broken and whose every later touch is
/// instant: a cold-start `SharedPreferences.getInstance()` rather than a
/// broken store.
///
/// This is the shape the whole-store fakes cannot express. With every read
/// failing, `settle` never gets past its own read to the sweep, so the
/// untrusted-sequence divergence never becomes observable -- which is exactly
/// why it shipped.
final class _ColdStartFeedbackOutboxStore implements FeedbackOutboxStore {
  _ColdStartFeedbackOutboxStore({
    required List<FeedbackOutboxEntry> entries,
    this.firstReadDelay,
    this.firstReadThrows = false,
    this.failWrites = false,
  }) : entries = List<FeedbackOutboxEntry>.of(entries);

  final Duration? firstReadDelay;
  final bool firstReadThrows;
  final bool failWrites;
  List<FeedbackOutboxEntry> entries;
  int reads = 0;

  @override
  Future<List<FeedbackOutboxEntry>> read() async {
    reads += 1;
    if (reads == 1) {
      final delay = firstReadDelay;
      if (delay != null) await Future<void>.delayed(delay);
      if (firstReadThrows) throw Exception('store unavailable');
    }
    return List<FeedbackOutboxEntry>.of(entries);
  }

  @override
  Future<void> write(List<FeedbackOutboxEntry> next) async {
    if (failWrites) throw Exception('store unavailable');
    entries = List<FeedbackOutboxEntry>.of(next);
  }
}

/// A store whose Nth `read()` throws, so a failure can be aimed at one
/// specific critical section (the settle sweep) rather than at every read.
final class _FailingOnReadFeedbackOutboxStore implements FeedbackOutboxStore {
  _FailingOnReadFeedbackOutboxStore({
    required this.failOnRead,
    required List<FeedbackOutboxEntry> entries,
  }) : _entries = List<FeedbackOutboxEntry>.of(entries);

  final int failOnRead;
  List<FeedbackOutboxEntry> _entries;
  int _reads = 0;

  @override
  Future<List<FeedbackOutboxEntry>> read() async {
    _reads += 1;
    if (_reads == failOnRead) throw Exception('store unavailable');
    return List<FeedbackOutboxEntry>.of(_entries);
  }

  @override
  Future<void> write(List<FeedbackOutboxEntry> next) async {
    _entries = List<FeedbackOutboxEntry>.of(next);
  }
}
