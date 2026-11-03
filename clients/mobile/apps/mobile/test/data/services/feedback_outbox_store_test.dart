import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feedback_outbox_store.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences_platform_interface/types.dart';

FeedbackOutboxEntry _rate(
  String messageId, {
  int queuedAtMs = 0,
  int seq = 0,
}) => FeedbackOutboxEntry(
  kind: FeedbackOutboxKind.rate,
  clientUserMessageId: messageId,
  clientChatId: 'chat-abc',
  rating: TurnFeedbackRating.down,
  queuedAtMs: queuedAtMs,
  seq: seq,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('entry round-trips through JSON', () {
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.rate,
      clientUserMessageId: 'msg-1-1',
      clientChatId: 'chat-abc',
      rating: TurnFeedbackRating.down,
      reason: TurnFeedbackReason.gotStuck,
      comment: 'looped forever',
      queuedAtMs: 1757000000000,
      seq: 0,
    );

    final decoded = FeedbackOutboxEntry.fromJson(entry.toJson());

    expect(decoded, isNotNull);
    expect(decoded!.reason, TurnFeedbackReason.gotStuck);
    expect(decoded.comment, 'looped forever');
    expect(decoded.rating, TurnFeedbackRating.down);
  });

  test('the five context fields round-trip through JSON', () {
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.rate,
      clientUserMessageId: 'msg-1-1',
      clientChatId: 'chat-abc',
      rating: TurnFeedbackRating.down,
      queuedAtMs: 1757000000000,
      seq: 0,
      provider: 'claude',
      model: 'claude-opus-4',
      chatMode: 'canopy',
      appVersion: '1.2.3',
      eventType: 'worktree_chat',
    );

    final decoded = FeedbackOutboxEntry.fromJson(entry.toJson());

    expect(decoded, isNotNull);
    expect(decoded!.provider, 'claude');
    expect(decoded.model, 'claude-opus-4');
    expect(decoded.chatMode, 'canopy');
    expect(decoded.appVersion, '1.2.3');
    expect(decoded.eventType, 'worktree_chat');
  });

  test('an entry without context fields decodes them as null', () {
    final decoded = FeedbackOutboxEntry.fromJson(_rate('msg-a').toJson());

    expect(decoded, isNotNull);
    expect(decoded!.provider, isNull);
    expect(decoded.model, isNull);
    expect(decoded.chatMode, isNull);
    expect(decoded.appVersion, isNull);
    expect(decoded.eventType, isNull);
  });

  test('accountId round-trips through JSON', () {
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.rate,
      clientUserMessageId: 'msg-1-1',
      clientChatId: 'chat-abc',
      accountId: 'acct-a',
      rating: TurnFeedbackRating.down,
      queuedAtMs: 1757000000000,
      seq: 0,
    );

    final decoded = FeedbackOutboxEntry.fromJson(entry.toJson());

    expect(decoded, isNotNull);
    expect(decoded!.accountId, 'acct-a');
  });

  test('a version 1 payload reads as empty rather than being replayed '
      'unscoped', () async {
    // Version 1 entries predate `accountId`, so there is no way to tell which
    // account authored one. Sending it under whoever signs in next is exactly
    // the leak the field prevents, so the whole payload is dropped.
    SharedPreferences.setMockInitialValues(<String, Object>{
      'canopy.feedback_outbox':
          '{"version":1,"entries":[{"kind":"rate","clientUserMessageId":"msg-1",'
          '"clientChatId":"chat-1","queuedAtMs":1757000000000,"rating":"down"}]}',
    });

    expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
  });

  test('a version 2 payload reads as empty because it lacks API-environment '
      'scope', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      'canopy.feedback_outbox':
          '{"version":2,"entries":[{"kind":"rate",'
          '"clientUserMessageId":"msg-1","clientChatId":"chat-1",'
          '"accountId":"acct-a","queuedAtMs":1757000000000,'
          '"rating":"down"}]}',
    });

    expect(feedbackOutboxVersion, 3);
    expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
  });

  test('upsert replaces only the same turn under the SAME account', () {
    final entries = <FeedbackOutboxEntry>[
      FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.rate,
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-abc',
        accountId: 'acct-a',
        rating: TurnFeedbackRating.down,
        queuedAtMs: 1,
        seq: 0,
      ),
    ];

    // Another account rating the same turn id must not evict the first
    // account's still-undelivered entry.
    final next = upsertFeedbackOutbox(
      entries,
      FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.rate,
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-abc',
        accountId: 'acct-b',
        rating: TurnFeedbackRating.up,
        queuedAtMs: 2,
        seq: 0,
      ),
    );

    expect(next, hasLength(2));
    expect(
      next.map((e) => e.accountId),
      containsAll(<String>['acct-a', 'acct-b']),
    );

    // ...but the same account re-rating it still replaces in place.
    final replaced = upsertFeedbackOutbox(
      next,
      FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.rate,
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-abc',
        accountId: 'acct-a',
        rating: TurnFeedbackRating.up,
        queuedAtMs: 3,
        seq: 0,
      ),
    );

    expect(replaced, hasLength(2));
    expect(
      replaced.firstWhere((e) => e.accountId == 'acct-a').rating,
      TurnFeedbackRating.up,
    );
  });

  test('seq round-trips through JSON, and a row without one decodes to 0', () {
    // `seq` is the ordering basis for every local comparison the repository
    // makes, so it has to survive the persisted round trip -- and a row
    // written before the field existed has to decode as OLDER than every
    // sequence the current run will issue, which is what 0 means.
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.rate,
      clientUserMessageId: 'msg-1',
      clientChatId: 'chat-abc',
      rating: TurnFeedbackRating.down,
      queuedAtMs: 1757000000000,
      seq: 42,
    );

    expect(FeedbackOutboxEntry.fromJson(entry.toJson())?.seq, 42);

    final json = entry.toJson()..remove('seq');
    expect(FeedbackOutboxEntry.fromJson(json)?.seq, 0);
  });

  test('the prune count cap orders by seq, not by a clock that moved '
      'backwards', () {
    // The age cutoff is wall time (14 days is a calendar span) but the count
    // cap orders entries against each other, and a backward device/NTP step
    // would otherwise make the NEWEST entries look oldest and drop them first.
    const nowMs = 1757000000000;
    final entries = <FeedbackOutboxEntry>[
      for (var i = 0; i < feedbackOutboxMaxEntries + 1; i += 1)
        _rate(
          'msg-$i',
          // Wall time runs BACKWARDS relative to the sequence: the newest
          // entry (highest seq) carries the oldest stamp.
          queuedAtMs: nowMs - i * 1000,
          seq: i + 1,
        ),
    ];

    final pruned = pruneFeedbackOutbox(entries, nowMs: nowMs);

    expect(pruned, hasLength(feedbackOutboxMaxEntries));
    expect(pruned.first.seq, feedbackOutboxMaxEntries + 1);
    expect(
      pruned.any((entry) => entry.seq == 1),
      isFalse,
      reason: 'the lowest sequence is the genuinely oldest entry',
    );
  });

  test('a malformed entry decodes to null instead of throwing', () {
    expect(FeedbackOutboxEntry.fromJson(<String, dynamic>{}), isNull);
    expect(FeedbackOutboxEntry.fromJson('nonsense'), isNull);
  });

  test('upsert replaces the entry for the same message id', () {
    final entries = <FeedbackOutboxEntry>[_rate('msg-a'), _rate('msg-b')];

    final next = upsertFeedbackOutbox(
      entries,
      FeedbackOutboxEntry(
        kind: FeedbackOutboxKind.rate,
        clientUserMessageId: 'msg-a',
        clientChatId: 'chat-abc',
        rating: TurnFeedbackRating.up,
        queuedAtMs: 5,
        seq: 0,
      ),
    );

    expect(next, hasLength(2));
    expect(
      next.firstWhere((e) => e.clientUserMessageId == 'msg-a').rating,
      TurnFeedbackRating.up,
    );
  });

  test('prune drops entries past the age limit', () {
    const nowMs = 1757000000000;
    final entries = <FeedbackOutboxEntry>[
      _rate(
        'fresh',
        queuedAtMs: nowMs - const Duration(days: 1).inMilliseconds,
        seq: 0,
      ),
      _rate(
        'stale',
        queuedAtMs: nowMs - const Duration(days: 30).inMilliseconds,
        seq: 0,
      ),
    ];

    final pruned = pruneFeedbackOutbox(entries, nowMs: nowMs);

    expect(pruned.map((e) => e.clientUserMessageId), <String>['fresh']);
  });

  test('prune keeps only the newest entries at the count cap', () {
    const nowMs = 1757000000000;
    final entries = <FeedbackOutboxEntry>[
      for (var i = 0; i < feedbackOutboxMaxEntries + 10; i += 1)
        _rate('msg-$i', queuedAtMs: nowMs - i),
    ];

    final pruned = pruneFeedbackOutbox(entries, nowMs: nowMs);

    expect(pruned, hasLength(feedbackOutboxMaxEntries));
    expect(pruned.first.clientUserMessageId, 'msg-0');
  });

  test('in-memory store round-trips', () async {
    final store = InMemoryFeedbackOutboxStore();
    await store.write(<FeedbackOutboxEntry>[_rate('msg-a')]);
    expect(await store.read(), hasLength(1));
  });

  test('a corrupt persisted payload reads as empty', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      'canopy.feedback_outbox': '{not json',
    });

    expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
  });

  test('an unknown persisted version reads as empty', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      'canopy.feedback_outbox': '{"version":99,"entries":[]}',
    });

    expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
  });

  test('detail entry kind, feedbackId, reason and comment round-trip', () {
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.detail,
      clientUserMessageId: 'msg-1-1',
      clientChatId: 'chat-abc',
      feedbackId: 'feedback-xyz',
      reason: TurnFeedbackReason.gotStuck,
      comment: 'looped forever',
      queuedAtMs: 1757000000000,
      seq: 0,
    );

    final decoded = FeedbackOutboxEntry.fromJson(entry.toJson());

    expect(decoded, isNotNull);
    expect(decoded!.kind, FeedbackOutboxKind.detail);
    expect(decoded.feedbackId, 'feedback-xyz');
    expect(decoded.reason, TurnFeedbackReason.gotStuck);
    expect(decoded.comment, 'looped forever');
    // A `detail` entry never carries a rating.
    expect(decoded.rating, isNull);
  });

  test('clear entry kind and feedbackId round-trip through JSON', () {
    final entry = FeedbackOutboxEntry(
      kind: FeedbackOutboxKind.clear,
      clientUserMessageId: 'msg-1-1',
      clientChatId: 'chat-abc',
      feedbackId: 'feedback-xyz',
      queuedAtMs: 1757000000000,
      seq: 0,
    );

    final decoded = FeedbackOutboxEntry.fromJson(entry.toJson());

    expect(decoded, isNotNull);
    expect(decoded!.kind, FeedbackOutboxKind.clear);
    expect(decoded.feedbackId, 'feedback-xyz');
    expect(decoded.clientUserMessageId, 'msg-1-1');
    expect(decoded.clientChatId, 'chat-abc');
    expect(decoded.queuedAtMs, 1757000000000);
  });

  test('prune count-cap keeps newest and drops oldest when order shuffled', () {
    const nowMs = 1757000000000;
    // Build entries with shuffled timestamps to verify sort is doing the work:
    // Create times 1..110 (in reverse insertion order), so the sort must work.
    // Entry msg-1 is newest (nowMs-1), msg-110 is oldest (nowMs-110, dropped).
    final entries = <FeedbackOutboxEntry>[
      for (var i = feedbackOutboxMaxEntries + 10; i >= 1; i -= 1)
        _rate('msg-$i', queuedAtMs: nowMs - i),
    ];

    final pruned = pruneFeedbackOutbox(entries, nowMs: nowMs);

    expect(pruned, hasLength(feedbackOutboxMaxEntries));
    // After sort by queuedAtMs descending, newest (msg-1, time nowMs-1) is first.
    expect(pruned.first.queuedAtMs, nowMs - 1);
    // Oldest retained entry is msg-100, time nowMs-100.
    expect(pruned.last.queuedAtMs, nowMs - feedbackOutboxMaxEntries);
    // Entry msg-110 (oldest overall) was dropped.
    expect(
      pruned.where((e) => e.clientUserMessageId == 'msg-110').isEmpty,
      true,
    );
  });

  test(
    'a persisted payload with valid JSON but non-Map value reads as empty',
    () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'canopy.feedback_outbox': '[]',
      });

      expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
    },
  );

  test(
    'a persisted payload with non-List entries value reads as empty',
    () async {
      SharedPreferences.setMockInitialValues(<String, Object>{
        'canopy.feedback_outbox':
            '{"version":$feedbackOutboxVersion,"entries":"not a list"}',
      });

      expect(await SharedPrefsFeedbackOutboxStore().read(), isEmpty);
    },
  );

  group('a store write the platform rejects', () {
    // `prefs.setString` returns Future<bool>. On Android that bool is
    // `Editor.commit()`'s result, so `false` means the disk write genuinely
    // failed. Discarding it made one of the four refusal cases
    // `_TurnWrite.queue` documents -- "The store itself failed. Nothing was
    // persisted, so `false` is the honest answer" -- unreachable on the one
    // platform that reports it.
    //
    // It is worse than a silent no-op: `SharedPreferences._setValue` writes
    // `_preferenceCache[key]` BEFORE calling the store and regardless of the
    // result, so in-session reads keep returning the entry and the loss only
    // appears at next launch.
    void useRejectingStore() {
      SharedPreferences.resetStatic();
      SharedPreferencesStorePlatform.instance =
          _RejectingSharedPreferencesStore();
      addTearDown(SharedPreferences.resetStatic);
    }

    test('surfaces as a thrown failure rather than a silent no-op', () async {
      useRejectingStore();

      await expectLater(
        SharedPrefsFeedbackOutboxStore().write(<FeedbackOutboxEntry>[
          _rate('msg-1'),
        ]),
        throwsA(isA<FeedbackOutboxWriteFailure>()),
      );
    });

    test('an accepted write still completes normally', () async {
      SharedPreferences.setMockInitialValues(<String, Object>{});

      final store = SharedPrefsFeedbackOutboxStore();
      await store.write(<FeedbackOutboxEntry>[_rate('msg-1', seq: 3)]);

      final read = await store.read();
      expect(read.single.clientUserMessageId, 'msg-1');
    });

    test('reaches the repository as `dropped`, not as a durable queue', () async {
      // The end-to-end loss this fix closes. Network fails retryably, so the
      // rating is queued -- but the disk write is rejected. Before the fix the
      // store swallowed that, `queue()` returned true, and the repository
      // reported `synced: false, dropped: false` (durably queued): the thumb
      // stays selected and the rating plus the user's typed comment are simply
      // gone at next launch. Honoring the signal routes it through the six
      // hand-written catch sites that already implement the documented
      // degradation.
      useRejectingStore();

      final repo = HttpTurnFeedbackRepository(
        service: TurnFeedbackApiService(
          apiClient: ApiClient(
            baseUrl: 'https://api.test',
            httpClient: MockClient(
              (_) async => http.Response(jsonEncode(<String, dynamic>{}), 500),
            ),
          ),
        ),
        outbox: SharedPrefsFeedbackOutboxStore(),
        accountId: () => 'acct-a',
      );

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
        reason:
            'nothing was persisted, so the user must not be told it is queued',
      );
    });

    test('still replays a queue it can READ', () async {
      // A readable-but-unwritable store. `_pruneAndReadLocked` is the only
      // `outbox.write` call site that wrote UNCONDITIONALLY, and it is the
      // first thing `flushOutbox` does -- so honoring the store's failure
      // signal turned every flush on such a device into a no-op. The read
      // succeeded, the queue is in hand and the server is healthy; failing to
      // persist a PRUNE that removed nothing must not cost the replay.
      //
      // Two entries, one of them aged out, so the prune genuinely CHANGES the
      // list and the write is actually attempted and rejected. A single fresh
      // entry would prune to the same length, skip the write, and leave the
      // failure path unexercised.
      final now = DateTime.now().millisecondsSinceEpoch;
      final seeded = jsonEncode(<String, dynamic>{
        'version': feedbackOutboxVersion,
        'entries': <dynamic>[
          FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: 'msg-1',
            clientChatId: 'chat-1',
            accountId: 'acct-a',
            rating: TurnFeedbackRating.down,
            comment: 'typed before the flight',
            queuedAtMs: now,
            seq: 7,
          ).toJson(),
          FeedbackOutboxEntry(
            kind: FeedbackOutboxKind.rate,
            clientUserMessageId: 'msg-aged-out',
            clientChatId: 'chat-1',
            accountId: 'acct-a',
            rating: TurnFeedbackRating.up,
            queuedAtMs: now - const Duration(days: 30).inMilliseconds,
            seq: 6,
          ).toJson(),
        ],
      });
      SharedPreferences.resetStatic();
      SharedPreferencesStorePlatform.instance =
          _SeededRejectingSharedPreferencesStore(seeded);
      addTearDown(SharedPreferences.resetStatic);

      final requests = <http.Request>[];
      final repo = HttpTurnFeedbackRepository(
        service: TurnFeedbackApiService(
          apiClient: ApiClient(
            baseUrl: 'https://api.test',
            httpClient: MockClient((request) async {
              requests.add(request);
              return http.Response(
                jsonEncode(<String, dynamic>{
                  'feedbackId': 'fb-1',
                  'clientUserMessageId': 'msg-1',
                  'rating': 'down',
                }),
                200,
              );
            }),
          ),
        ),
        outbox: SharedPrefsFeedbackOutboxStore(),
        accountId: () => 'acct-a',
      );

      final replayed = await repo.flushOutbox();

      expect(
        requests.map((request) => request.method).toList(),
        <String>['POST', 'PATCH'],
        reason:
            'the queue was readable and the server healthy: a failed prune '
            'write must not swallow the replay',
      );
      expect(replayed.single.feedbackId, 'fb-1');
      expect(jsonDecode(requests.first.body)['clientUserMessageId'], 'msg-1');
      expect(
        jsonDecode(requests.last.body)['comment'],
        'typed before the flight',
      );
    });
  });
}

/// The same rejecting platform, but with a queue an EARLIER SESSION already
/// persisted. Reads succeed and return it; every write is refused.
final class _SeededRejectingSharedPreferencesStore
    extends _RejectingSharedPreferencesStore {
  _SeededRejectingSharedPreferencesStore(this.payload);

  final String payload;

  Map<String, Object> get _seeded => <String, Object>{
    'flutter.canopy.feedback_outbox': payload,
  };

  @override
  Future<Map<String, Object>> getAll() async => _seeded;

  @override
  Future<Map<String, Object>> getAllWithParameters(
    GetAllParameters parameters,
  ) async => _seeded;

  @override
  Future<Map<String, Object>> getAllWithPrefix(String prefix) async => _seeded;
}

/// A `shared_preferences` platform whose writes all REPORT FAILURE, the way
/// `shared_preferences_android` does when `Editor.commit()` returns false.
/// Reads still work, mirroring the real failure mode: the disk write is what
/// fails, not the plugin.
base class _RejectingSharedPreferencesStore
    extends SharedPreferencesStorePlatform {
  @override
  Future<bool> clear() async => false;

  @override
  Future<bool> clearWithParameters(ClearParameters parameters) async => false;

  @override
  Future<bool> clearWithPrefix(String prefix) async => false;

  @override
  Future<Map<String, Object>> getAll() async => <String, Object>{};

  @override
  Future<Map<String, Object>> getAllWithParameters(
    GetAllParameters parameters,
  ) async => <String, Object>{};

  @override
  Future<Map<String, Object>> getAllWithPrefix(String prefix) async =>
      <String, Object>{};

  @override
  Future<bool> remove(String key) async => false;

  @override
  Future<bool> setValue(String valueType, String key, Object value) async =>
      false;
}
