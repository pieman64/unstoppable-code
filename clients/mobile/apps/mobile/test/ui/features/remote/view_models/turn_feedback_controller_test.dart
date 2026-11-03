import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';

void main() {
  test('a rating that replayed out of the outbox can still be retracted, '
      'without waiting for a cold start', () async {
    // The flow this PR flags for manual device verification: rate while
    // offline (durably queued), foreground the app, let the resume flush
    // drain the queue, then tap the selected thumb again to retract.
    //
    // The replay is the only path that learns the turn's `feedbackId`, and it
    // had no channel to hand it back. The controller's entry therefore stayed
    // `feedbackId: null` for the whole session, so the retraction took the
    // repository's "nothing on the server to retract" branch: no DELETE, and
    // `setRating` still reported success while the server kept the rating.
    final requests = <String>[];
    var serverDown = true;
    final client = MockClient((request) async {
      requests.add('${request.method} ${request.url.path}');
      if (serverDown) return http.Response('', 503);
      return http.Response(
        jsonEncode(<String, dynamic>{
          'feedbackId': 'fb-1',
          'clientUserMessageId': 'msg-1',
          'rating': 'down',
          'hasComment': false,
        }),
        200,
      );
    });
    final controller = TurnFeedbackController(
      repository: HttpTurnFeedbackRepository(
        service: TurnFeedbackApiService(
          apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
        ),
        outbox: InMemoryFeedbackOutboxStore(),
        accountId: () => 'acct-a',
      ),
    );

    await controller.setRating(
      chatId: 'chat-1',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    expect(
      controller.entryFor('chat-1', 'msg-1')?.syncState,
      TurnFeedbackSyncState.failed,
      reason: 'queued, not lost — the thumb stays selected',
    );
    expect(controller.entryFor('chat-1', 'msg-1')?.feedbackId, isNull);

    serverDown = false;
    await controller.flushOutbox();

    expect(
      controller.entryFor('chat-1', 'msg-1')?.feedbackId,
      'fb-1',
      reason: 'the replay learned the id, so the controller must adopt it',
    );

    requests.clear();
    final stands = await controller.setRating(
      chatId: 'chat-1',
      clientUserMessageId: 'msg-1',
      rating: null,
    );

    expect(requests, <String>[
      'DELETE /api/v1/feedback/turns/fb-1',
    ], reason: 'the retraction must actually reach the server');
    expect(stands, isTrue);
    expect(controller.entryFor('chat-1', 'msg-1'), isNull);
  });

  test(
    'a comment typed after the outbox drained still reaches the server',
    () async {
      // The other half of the same missing id: `submitDetail` passes the
      // entry's `feedbackId` through, so a null one leaves the typed comment
      // with nothing to PATCH.
      final requests = <String>[];
      var serverDown = true;
      final client = MockClient((request) async {
        requests.add('${request.method} ${request.url.path}');
        if (serverDown) return http.Response('', 503);
        return http.Response(
          jsonEncode(<String, dynamic>{
            'feedbackId': 'fb-1',
            'clientUserMessageId': 'msg-1',
            'rating': 'down',
            'hasComment': false,
          }),
          200,
        );
      });
      final controller = TurnFeedbackController(
        repository: HttpTurnFeedbackRepository(
          service: TurnFeedbackApiService(
            apiClient: ApiClient(
              baseUrl: 'https://api.test',
              httpClient: client,
            ),
          ),
          outbox: InMemoryFeedbackOutboxStore(),
          accountId: () => 'acct-a',
        ),
      );

      await controller.setRating(
        chatId: 'chat-1',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.down,
      );
      serverDown = false;
      await controller.flushOutbox();

      requests.clear();
      await controller.submitDetail(
        chatId: 'chat-1',
        clientUserMessageId: 'msg-1',
        reason: TurnFeedbackReason.gotStuck,
        comment: 'it looped forever',
      );

      expect(requests, <String>['PATCH /api/v1/feedback/turns/fb-1']);
    },
  );

  test('a flush that resolves after resetHydration does not adopt the previous '
      "account's feedbackId", () async {
    // An outbox replay from account A must not replace account B's rating.
    final repository = _ManualFlushRepository();
    final controller = TurnFeedbackController(repository: repository);
    final flushCompleter = repository.enqueueFlush();

    final flush = controller.flushOutbox();
    controller.resetHydration();
    final rate = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-1',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );
    rate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-account-b'),
    );
    await rating;
    expect(controller.entryFor('chat-1', 'msg-1')?.feedbackId, 'fb-account-b');

    flushCompleter.complete(<TurnFeedbackReplayedRating>[
      const TurnFeedbackReplayedRating(
        clientChatId: 'chat-1',
        clientUserMessageId: 'msg-1',
        feedbackId: 'fb-account-a',
      ),
    ]);
    await flush;

    expect(controller.entryFor('chat-1', 'msg-1')?.feedbackId, 'fb-account-b');
  });

  test('a flush that reports only ids the controller already has does not '
      'notify', () async {
    // Foreground replay must not notify when no cached entry changes.
    final repository = _ManualFlushRepository();
    final controller = TurnFeedbackController(repository: repository);
    final rate = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-1',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    rate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    var notifications = 0;
    controller.addListener(() => notifications += 1);

    final flushCompleter = repository.enqueueFlush();
    final flush = controller.flushOutbox();
    flushCompleter.complete(<TurnFeedbackReplayedRating>[
      const TurnFeedbackReplayedRating(
        clientChatId: 'chat-1',
        clientUserMessageId: 'msg-1',
        feedbackId: 'fb-1',
      ),
      // A turn this session never cached: nothing to correct, and inventing
      // an entry would resurrect a rating the user may have let go of.
      const TurnFeedbackReplayedRating(
        clientChatId: 'chat-1',
        clientUserMessageId: 'msg-unknown',
        feedbackId: 'fb-2',
      ),
    ]);
    await flush;

    expect(notifications, 0);
    expect(controller.entryFor('chat-1', 'msg-unknown'), isNull);
  });

  test(
    'a queued rating does not erase the feedbackId the turn already had',
    () async {
      // A queued write reports `feedbackId: null` — it has not spoken to the
      // server. That is not "the row is gone": re-rating a turn that is already
      // synced (or whose id a flush just carried back) must keep the id, or the
      // next retraction has nothing to DELETE.
      final repository = _ManualWriteRepository();
      final controller = TurnFeedbackController(repository: repository);

      final first = repository.enqueueRate();
      final rating = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.down,
      );
      first.complete(
        const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
      );
      await rating;

      final second = repository.enqueueRate();
      final requeued = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.up,
      );
      second.complete(const TurnFeedbackWriteResult(synced: false));
      await requeued;

      expect(controller.entryFor('chat-abc', 'msg-1')?.feedbackId, 'fb-1');
    },
  );

  test(
    'a rating is selected optimistically before the write settles',
    () async {
      final controller = TurnFeedbackController(
        repository: MockTurnFeedbackRepository(
          latency: const Duration(milliseconds: 50),
        ),
      );

      final pending = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.up,
      );

      // Selected immediately, before the repository answers.
      expect(
        controller.entryFor('chat-abc', 'msg-1')?.rating,
        TurnFeedbackRating.up,
      );
      expect(
        controller.entryFor('chat-abc', 'msg-1')?.syncState,
        TurnFeedbackSyncState.pending,
      );

      await pending;

      expect(
        controller.entryFor('chat-abc', 'msg-1')?.syncState,
        TurnFeedbackSyncState.synced,
      );
    },
  );

  test('a failed write keeps the rating selected', () async {
    // A rejected upload must never silently revert the user's tap.
    final controller = TurnFeedbackController(
      repository: MockTurnFeedbackRepository(failWrites: true),
    );

    await controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(entry?.rating, TurnFeedbackRating.down);
    expect(entry?.syncState, TurnFeedbackSyncState.failed);
  });

  test('the write-token map is bounded, and eviction costs an in-flight write '
      'only what never having written the turn would', () async {
    // `_writeTokens` grows by one entry for every turn the user ever rates, on
    // an app-lifetime singleton, and `resetHydration()` deliberately does not
    // clear it — so not even a sign-out bounds it. The repository caps the
    // equivalent `_settled` map and documents this exact hazard; this pins the
    // controller doing the same.
    //
    // The bound is observed through its cost rather than the private map: an
    // evicted turn's still-in-flight write is no longer "the latest issued",
    // so it declines to settle and the thumb stays `pending`. That is the
    // pre-first-write behavior, which is the whole argument for the eviction
    // being affordable.
    final repository = _HeldRateRepository('msg-held');
    final controller = TurnFeedbackController(repository: repository);

    final held = controller.setRating(
      chatId: 'chat-1',
      clientUserMessageId: 'msg-held',
      rating: TurnFeedbackRating.down,
    );
    for (var i = 0; i < TurnFeedbackController.writeTokenCapacity; i++) {
      await controller.setRating(
        chatId: 'chat-1',
        clientUserMessageId: 'msg-$i',
        rating: TurnFeedbackRating.up,
      );
    }

    repository.held.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    expect(
      await held,
      isFalse,
      reason: 'the evicted token can no longer be the latest one',
    );
    expect(
      controller.entryFor('chat-1', 'msg-held')?.syncState,
      TurnFeedbackSyncState.pending,
      reason: 'the tap is still on screen; only the settle was declined',
    );
  });

  test('a null rating clears the entry', () async {
    final controller = TurnFeedbackController(
      repository: MockTurnFeedbackRepository(),
    );
    await controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );

    await controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: null,
    );

    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);
  });

  test('ratings are scoped per chat', () async {
    final controller = TurnFeedbackController(
      repository: MockTurnFeedbackRepository(),
    );

    await controller.setRating(
      chatId: 'chat-a',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );

    expect(controller.entryFor('chat-b', 'msg-1'), isNull);
  });

  for (final resetAccount in [false, true]) {
    test('a later-issued write with the same rating wins over an earlier one '
        'that resolves after it (account reset: $resetAccount)', () async {
      // Two "up" taps for the same turn (e.g. a double-tap race). Even
      // though both carry the same rating, only the later-issued write may
      // settle the entry — a stale value-only comparison would let the
      // earlier one win just because its rating still matches.
      final repository = _ManualRateRepository();
      final controller = TurnFeedbackController(repository: repository);

      final firstCompleter = repository.enqueueRate();
      final firstPending = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.up,
      );

      if (resetAccount) controller.resetHydration();

      final secondCompleter = repository.enqueueRate();
      final secondPending = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.up,
      );

      // The later-issued write settles first, with an outcome that differs
      // from the earlier one so a wrong "winner" is observable.
      secondCompleter.complete(const TurnFeedbackWriteResult(synced: false));
      await secondPending;

      expect(
        controller.entryFor('chat-abc', 'msg-1')?.syncState,
        TurnFeedbackSyncState.failed,
      );

      // The earlier write resolves last; it must be ignored rather than
      // reverting the settled state back to synced.
      firstCompleter.complete(const TurnFeedbackWriteResult(synced: true));
      expect(await firstPending, isFalse);

      final entry = controller.entryFor('chat-abc', 'msg-1');
      expect(entry?.rating, TurnFeedbackRating.up);
      expect(entry?.syncState, TurnFeedbackSyncState.failed);
    });
  }

  test('up -> down -> up settles to the third write even when the first '
      'resolves last', () async {
    final repository = _ManualRateRepository();
    final controller = TurnFeedbackController(repository: repository);

    final firstCompleter = repository.enqueueRate();
    final firstPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );

    final secondCompleter = repository.enqueueRate();
    final secondPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );

    final thirdCompleter = repository.enqueueRate();
    final thirdPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );

    // Resolve out of issue order: third (latest) first, then second, then
    // first (the earliest, resolving last).
    thirdCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-3'),
    );
    await thirdPending;

    secondCompleter.complete(const TurnFeedbackWriteResult(synced: false));
    await secondPending;

    firstCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await firstPending;

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(entry?.rating, TurnFeedbackRating.up);
    expect(entry?.syncState, TurnFeedbackSyncState.synced);
    expect(entry?.feedbackId, 'fb-3');
  });

  test('a clear issued while a rate is in flight keeps the entry cleared when '
      'the stale rate resolves', () async {
    final repository = _ManualRateRepository();
    final controller = TurnFeedbackController(repository: repository);

    final rateCompleter = repository.enqueueRate();
    final ratePending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );

    expect(
      controller.entryFor('chat-abc', 'msg-1')?.syncState,
      TurnFeedbackSyncState.pending,
    );

    await controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: null,
    );

    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);

    rateCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await ratePending;

    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);
  });

  test('a write the server DROPPED reverts the optimistic selection', () async {
    // A queued write keeps its thumb (it will still land). A dropped one —
    // a 400/403, or no signed-in account to queue under — never will, so
    // leaving the thumb selected would misreport what happened.
    final repository = _ManualRateRepository();
    final controller = TurnFeedbackController(repository: repository);

    final completer = repository.enqueueRate();
    final pending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    expect(
      controller.entryFor('chat-abc', 'msg-1')?.syncState,
      TurnFeedbackSyncState.pending,
    );

    completer.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    await pending;

    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);
  });

  test('a dropped write restores the PREVIOUS rating rather than clearing '
      'the turn outright', () async {
    final repository = _ManualRateRepository();
    final controller = TurnFeedbackController(repository: repository);

    final firstCompleter = repository.enqueueRate();
    final firstPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );
    firstCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await firstPending;

    final secondCompleter = repository.enqueueRate();
    final secondPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    secondCompleter.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    await secondPending;

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(entry?.rating, TurnFeedbackRating.up);
    expect(entry?.syncState, TurnFeedbackSyncState.synced);
    expect(entry?.feedbackId, 'fb-1');
  });

  test('a merely QUEUED write still keeps its thumb selected', () async {
    final repository = _ManualRateRepository();
    final controller = TurnFeedbackController(repository: repository);

    final completer = repository.enqueueRate();
    final pending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    completer.complete(const TurnFeedbackWriteResult(synced: false));
    await pending;

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(entry?.rating, TurnFeedbackRating.down);
    expect(entry?.syncState, TurnFeedbackSyncState.failed);
  });

  test('a clear the server DROPPED restores the rating it removed', () async {
    // A 400/403/404 DELETE never reached the server's state and was not
    // queued, so the rating is still recorded there. Leaving the thumb
    // unselected claims a retraction that did not happen.
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final rateCompleter = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    rateCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    final clearCompleter = repository.enqueueClear();
    final clearing = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: null,
    );
    // De-selected optimistically while the DELETE is in flight.
    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);

    clearCompleter.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    final stands = await clearing;

    // State first: the rendered thumb is the thing that must not lie.
    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(entry?.rating, TurnFeedbackRating.down);
    expect(entry?.feedbackId, 'fb-1');
    expect(entry?.syncState, TurnFeedbackSyncState.synced);
    expect(stands, isFalse);
  });

  test('a merely QUEUED clear stays cleared', () async {
    // The other direction: the retraction is durably queued and WILL land,
    // so restoring the thumb would be the same lie in reverse.
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final rateCompleter = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    rateCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    final clearCompleter = repository.enqueueClear();
    final clearing = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: null,
    );
    clearCompleter.complete(const TurnFeedbackWriteResult(synced: false));
    await clearing;

    expect(controller.entryFor('chat-abc', 'msg-1'), isNull);
  });

  test('setRating reports whether the rating STANDS, so a refused thumbs-down '
      'never opens the reason sheet', () async {
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final dropped = repository.enqueueRate();
    final droppedPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    dropped.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    expect(await droppedPending, isFalse);

    final queued = repository.enqueueRate();
    final queuedPending = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-2',
      rating: TurnFeedbackRating.down,
    );
    queued.complete(const TurnFeedbackWriteResult(synced: false));
    expect(
      await queuedPending,
      isTrue,
      reason: 'a queued rating still lands, so the sheet must still open',
    );
  });

  test(
    'a DROPPED detail rolls back the optimistically applied reason',
    () async {
      final repository = _ManualWriteRepository();
      final controller = TurnFeedbackController(repository: repository);

      final rateCompleter = repository.enqueueRate();
      final rating = controller.setRating(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        rating: TurnFeedbackRating.down,
      );
      rateCompleter.complete(
        const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
      );
      await rating;

      final detailCompleter = repository.enqueueDetail();
      final detail = controller.submitDetail(
        chatId: 'chat-abc',
        clientUserMessageId: 'msg-1',
        reason: TurnFeedbackReason.gotStuck,
      );
      expect(
        controller.entryFor('chat-abc', 'msg-1')?.reason,
        TurnFeedbackReason.gotStuck,
      );

      detailCompleter.complete(
        const TurnFeedbackWriteResult(synced: false, dropped: true),
      );

      // Reported to the caller, not just to the cache. A dropped detail means
      // the user's typed comment is gone with nothing left to retry it; a
      // `void` return made that indistinguishable from a delivered one.
      expect(await detail, isFalse);
      expect(controller.entryFor('chat-abc', 'msg-1')?.reason, isNull);
      // Only the reason is rolled back — the rating itself still stands.
      expect(
        controller.entryFor('chat-abc', 'msg-1')?.rating,
        TurnFeedbackRating.down,
      );
    },
  );

  test('a merely QUEUED detail keeps its optimistic reason', () async {
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final rateCompleter = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    rateCompleter.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    final detailCompleter = repository.enqueueDetail();
    final detail = controller.submitDetail(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      reason: TurnFeedbackReason.incorrectOrDidntWork,
    );
    detailCompleter.complete(const TurnFeedbackWriteResult(synced: false));

    // Queued, not dropped: the detail still stands, so the caller is told so.
    expect(await detail, isTrue);
    expect(
      controller.entryFor('chat-abc', 'msg-1')?.reason,
      TurnFeedbackReason.incorrectOrDidntWork,
    );
  });

  test('a DROPPED detail does not clobber a newer rating that replaced its '
      'optimistic entry mid-flight', () async {
    // The rollback target is captured when `submitDetail` starts. If another
    // write for the same turn lands while the PATCH is in flight, that target
    // is stale, and restoring it resurrects a rating the user has already
    // replaced -- the same staleness `setRating` guards with its token, on
    // the one path that has no token.
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final firstRate = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    firstRate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    // A detail goes out against that thumbs-down and hangs.
    final detailCompleter = repository.enqueueDetail();
    final detail = controller.submitDetail(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      reason: TurnFeedbackReason.gotStuck,
    );

    // While it is in flight the user flips to thumbs-up, and that write lands.
    final secondRate = repository.enqueueRate();
    final reRating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );
    secondRate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-2'),
    );
    expect(await reRating, isTrue);
    expect(
      controller.entryFor('chat-abc', 'msg-1')?.rating,
      TurnFeedbackRating.up,
    );

    // Only now is the detail refused outright.
    detailCompleter.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    expect(await detail, isFalse);

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(
      entry?.rating,
      TurnFeedbackRating.up,
      reason:
          'rolling back to the pre-detail entry would revert the thumbs-up '
          'the user has since chosen',
    );
    expect(entry?.feedbackId, 'fb-2');
  });

  // --- Guards the round-4 mutation sweep found unpinned.

  test('a DROPPED retraction does not clobber a newer rating issued while it '
      'was in flight', () async {
    // The clear path's own staleness guard. Its rollback target is the entry
    // the retraction removed; a newer rating that landed in the meantime has
    // already replaced it.
    final repository = _ManualWriteRepository();
    final controller = TurnFeedbackController(repository: repository);

    final firstRate = repository.enqueueRate();
    final rating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.down,
    );
    firstRate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-1'),
    );
    await rating;

    final clearCompleter = repository.enqueueClear();
    final retraction = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: null,
    );

    // While the retraction is in flight the user taps thumbs-up, and it lands.
    final secondRate = repository.enqueueRate();
    final reRating = controller.setRating(
      chatId: 'chat-abc',
      clientUserMessageId: 'msg-1',
      rating: TurnFeedbackRating.up,
    );
    secondRate.complete(
      const TurnFeedbackWriteResult(synced: true, feedbackId: 'fb-2'),
    );
    expect(await reRating, isTrue);

    clearCompleter.complete(
      const TurnFeedbackWriteResult(synced: false, dropped: true),
    );
    expect(await retraction, isFalse);

    final entry = controller.entryFor('chat-abc', 'msg-1');
    expect(
      entry?.rating,
      TurnFeedbackRating.up,
      reason:
          'restoring the retraction\'s rollback target would revert the '
          'thumbs-up the user has since chosen',
    );
    expect(entry?.feedbackId, 'fb-2');
  });
}

/// A [MockTurnFeedbackRepository] whose `rate()` calls are settled manually
/// via queued [Completer]s, so tests can drive out-of-order resolution
/// deterministically instead of racing real delays.
final class _ManualRateRepository extends MockTurnFeedbackRepository {
  final List<Completer<TurnFeedbackWriteResult>> _rateCompleters =
      <Completer<TurnFeedbackWriteResult>>[];

  Completer<TurnFeedbackWriteResult> enqueueRate() {
    final completer = Completer<TurnFeedbackWriteResult>();
    _rateCompleters.add(completer);
    return completer;
  }

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) => _rateCompleters.removeAt(0).future;
}

/// [_ManualRateRepository] extended to every write, so a test can drive a
/// clear or a detail to a chosen outcome — `dropped` in particular — without
/// racing a real delay.
final class _ManualWriteRepository extends _ManualRateRepository {
  final List<Completer<TurnFeedbackWriteResult>> _clearCompleters =
      <Completer<TurnFeedbackWriteResult>>[];
  final List<Completer<TurnFeedbackWriteResult>> _detailCompleters =
      <Completer<TurnFeedbackWriteResult>>[];

  Completer<TurnFeedbackWriteResult> enqueueClear() {
    final completer = Completer<TurnFeedbackWriteResult>();
    _clearCompleters.add(completer);
    return completer;
  }

  Completer<TurnFeedbackWriteResult> enqueueDetail() {
    final completer = Completer<TurnFeedbackWriteResult>();
    _detailCompleters.add(completer);
    return completer;
  }

  @override
  Future<TurnFeedbackWriteResult> clear({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
  }) => _clearCompleters.removeAt(0).future;

  @override
  Future<TurnFeedbackWriteResult> attachDetail({
    required String clientUserMessageId,
    required String clientChatId,
    String? feedbackId,
    TurnFeedbackReason? reason,
    String? comment,
  }) => _detailCompleters.removeAt(0).future;
}

/// A [MockTurnFeedbackRepository] whose `flushOutbox()` is settled manually,
/// so a test can hold a replay open across an account change.
final class _ManualFlushRepository extends _ManualRateRepository {
  final List<Completer<List<TurnFeedbackReplayedRating>>> _flushCompleters =
      <Completer<List<TurnFeedbackReplayedRating>>>[];

  Completer<List<TurnFeedbackReplayedRating>> enqueueFlush() {
    final completer = Completer<List<TurnFeedbackReplayedRating>>();
    _flushCompleters.add(completer);
    return completer;
  }

  @override
  Future<List<TurnFeedbackReplayedRating>> flushOutbox() =>
      _flushCompleters.removeAt(0).future;
}

/// A [MockTurnFeedbackRepository] that holds ONE turn's `rate` open, so a
/// write can still be in flight while later writes fill the controller's
/// write-token map past its bound.
final class _HeldRateRepository extends MockTurnFeedbackRepository {
  _HeldRateRepository(this.heldTurnId);

  final String heldTurnId;
  final Completer<TurnFeedbackWriteResult> held =
      Completer<TurnFeedbackWriteResult>();

  @override
  Future<TurnFeedbackWriteResult> rate({
    required String clientUserMessageId,
    required String clientChatId,
    required TurnFeedbackRating rating,
    required TurnFeedbackContext context,
  }) {
    if (clientUserMessageId == heldTurnId) return held.future;
    return super.rate(
      clientUserMessageId: clientUserMessageId,
      clientChatId: clientChatId,
      rating: rating,
      context: context,
    );
  }
}
