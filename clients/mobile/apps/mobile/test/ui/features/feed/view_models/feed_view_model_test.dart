import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/ui/features/feed/view_models/feed_sharing_guidance.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';

/// Records the filters passed to each fetch.
final class _RecordingFeedRepository implements FeedRepository {
  int calls = 0;
  List<FeedItemType>? lastTypes;
  String? lastQuery;
  String? lastActorId;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    calls++;
    lastTypes = types;
    lastQuery = query;
    lastActorId = actorId;
    return FeedPageResponse(items: const []);
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

void main() {
  group('FeedViewModel', () {
    test('loads with no filters by default', () async {
      final repo = _RecordingFeedRepository();
      final vm = FeedViewModel(repository: repo);

      await vm.loadFeed();

      expect(vm.hasActiveFilters, isFalse);
      expect(repo.lastTypes, isNull);
      expect(repo.lastQuery, isNull);
    });

    test(
      'setFilters records the active filters (trimmed) and reloads',
      () async {
        final repo = _RecordingFeedRepository();
        final vm = FeedViewModel(repository: repo);

        await vm.setFilters(types: {FeedItemType.prMerged}, query: '  auth  ');

        expect(vm.hasActiveFilters, isTrue);
        expect(vm.activeTypes, {FeedItemType.prMerged});
        expect(vm.query, 'auth');
        expect(repo.lastTypes, [FeedItemType.prMerged]);
        expect(repo.lastQuery, 'auth');
      },
    );

    test('setFilters records the actor filter (trimmed) and reloads', () async {
      final repo = _RecordingFeedRepository();
      final vm = FeedViewModel(repository: repo);

      await vm.setFilters(
        types: const {},
        query: '',
        actorId: '  actor-uuid-1  ',
        actorLabel: 'Alex Rivera',
      );

      expect(vm.hasActiveFilters, isTrue);
      expect(vm.actorId, 'actor-uuid-1'); // trimmed
      expect(vm.actorLabel, 'Alex Rivera');
      expect(repo.calls, 1);
      expect(repo.lastActorId, 'actor-uuid-1');
    });

    test('a blank actorId clears the actor filter and its label', () async {
      final repo = _RecordingFeedRepository();
      final vm = FeedViewModel(repository: repo);

      await vm.setFilters(
        types: const {},
        query: '',
        actorId: '   ',
        actorLabel: 'ignored',
      );

      expect(vm.actorId, isNull);
      expect(vm.actorLabel, isNull);
      expect(vm.hasActiveFilters, isFalse);
      expect(repo.lastActorId, isNull);
    });

    test('changing the actor filter reloads (resets pagination)', () async {
      final repo = _RecordingFeedRepository();
      final vm = FeedViewModel(repository: repo);

      await vm.setFilters(types: const {}, query: '', actorId: 'actor-uuid-1');
      expect(repo.calls, 1);
      expect(repo.lastActorId, 'actor-uuid-1');

      // Switching to a different actor triggers another full reload.
      await vm.setFilters(types: const {}, query: '', actorId: 'actor-uuid-2');
      expect(repo.calls, 2);
      expect(repo.lastActorId, 'actor-uuid-2');
    });

    test('clearFilters resets and reloads with no filters', () async {
      final repo = _RecordingFeedRepository();
      final vm = FeedViewModel(repository: repo);

      await vm.setFilters(
        types: {FeedItemType.prMerged},
        query: 'x',
        actorId: 'actor-uuid-1',
        actorLabel: 'Alex Rivera',
      );
      await vm.clearFilters();

      expect(vm.hasActiveFilters, isFalse);
      expect(vm.actorId, isNull);
      expect(vm.actorLabel, isNull);
      expect(repo.lastTypes, isNull);
      expect(repo.lastQuery, isNull);
      expect(repo.lastActorId, isNull);
    });

    test('the mock repository actually applies the type filter', () async {
      final vm = FeedViewModel(repository: MockFeedRepository());

      await vm.setFilters(types: {FeedItemType.prMerged}, query: '');

      expect(vm.items, isNotEmpty);
      expect(vm.items.every((i) => i.type == FeedItemType.prMerged), isTrue);
    });

    test('the mock repository actually applies the actor filter', () async {
      final vm = FeedViewModel(repository: MockFeedRepository());

      // MockFeedRepository seeds items from user-001 (Alex) and user-002 (Sam).
      await vm.setFilters(types: const {}, query: '', actorId: 'user-002');

      expect(vm.items, isNotEmpty);
      expect(vm.items.every((i) => i.actor.userId == 'user-002'), isTrue);
    });
  });

  group('CAN-3715 state sequences', () {
    test('appends pages in order without duplicates, retries a failed '
        'append, and stops at the last cursor', () async {
      var failAppend = true;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) async {
          switch (cursor) {
            case null:
              return FeedPageResponse(
                items: [_row('a'), _row('b')],
                nextCursor: 'c1',
              );
            case 'c1':
              if (failAppend) throw Exception('offline');
              // Overlaps the first page when new work lands in between.
              return FeedPageResponse(
                items: [_row('b'), _row('c')],
                nextCursor: 'c2',
              );
            default:
              return FeedPageResponse(items: [_row('d')]);
          }
        }),
      );
      await vm.loadFeed();
      await vm.loadMore();
      expect(vm.loadMoreError, isNotNull);
      expect(vm.items.map((i) => i.id), ['a', 'b']);
      expect(vm.hasMore, isTrue);

      failAppend = false;
      await vm.loadMore();
      await vm.loadMore();

      expect(vm.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
      expect(vm.loadMoreError, isNull);
      expect(vm.hasMore, isFalse);
    });

    test('a repeated cursor ends pagination instead of looping', () async {
      final cursors = <String?>[];
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) async {
          cursors.add(cursor);
          return FeedPageResponse(
            items: [_row('row-${cursors.length}')],
            nextCursor: 'same',
          );
        }),
      );
      await vm.loadFeed();
      await vm.loadMore();
      await vm.loadMore();

      expect(cursors, [null, 'same']);
      expect(vm.hasMore, isFalse);
    });

    test('a refresh discards an append that completes after it', () async {
      final append = Completer<FeedPageResponse>();
      var firstPages = 0;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) {
          if (cursor == 'next-1') return append.future;
          // The refresh reads its new work down to the shown row.
          if (cursor == 'next-2') {
            return Future.value(
              FeedPageResponse(items: [_row('fresh-1')], nextCursor: 'next-1'),
            );
          }
          firstPages++;
          return Future.value(
            FeedPageResponse(
              items: [_row('fresh-$firstPages')],
              nextCursor: 'next-$firstPages',
            ),
          );
        }),
      );
      await vm.loadFeed();
      final pendingAppend = vm.loadMore();
      expect(vm.isLoadingMore, isTrue);

      await vm.loadFeed();
      append.complete(FeedPageResponse(items: [_row('stale')]));
      await pendingAppend;

      expect(vm.items.map((i) => i.id), ['fresh-2', 'fresh-1']);
      expect(vm.isLoadingMore, isFalse);
      expect(vm.hasMore, isTrue);
    });

    test('a newer filter owns rows, errors and flags when an older query '
        'completes last', () async {
      final older = Completer<FeedPageResponse>();
      final repository = _ScriptedFeedRepository((_) => older.future);
      final vm = FeedViewModel(repository: repository);
      final first = vm.loadFeed();
      final newer = Completer<FeedPageResponse>();
      repository.next = (_) => newer.future;
      final second = vm.setFilters(types: const {}, query: 'auth');

      newer.complete(FeedPageResponse(items: [_row('b')]));
      await second;
      older.completeError(Exception('late failure'));
      await first;

      expect(vm.items.map((i) => i.id), ['b']);
      expect(vm.error, isNull);
      expect(vm.isLoading, isFalse);
    });

    test('a filter change clears the old rows and cursor at once', () async {
      final pending = Completer<FeedPageResponse>();
      final repository = _ScriptedFeedRepository(
        (_) async => FeedPageResponse(items: [_row('a')], nextCursor: 'c'),
      );
      final vm = FeedViewModel(repository: repository);
      await vm.loadFeed();
      repository.next = (_) => pending.future;

      final filtered = vm.setFilters(types: const {}, query: 'other');

      expect(vm.items, isEmpty);
      expect(vm.hasMore, isFalse);
      pending.complete(FeedPageResponse(items: const []));
      await filtered;
    });

    test('overlapping refresh signals share one request', () async {
      final page = Completer<FeedPageResponse>();
      var calls = 0;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((_) {
          calls++;
          return page.future;
        }),
      );
      final tab = vm.loadFeed();
      final resume = vm.loadFeed();
      page.complete(FeedPageResponse(items: [_row('a')]));
      await Future.wait([tab, resume]);

      expect(calls, 1);
      await vm.loadFeed();
      expect(calls, 2);
    });

    test('a retry after a failed refresh replaces the kept rows', () async {
      var fail = false;
      var version = 0;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) async {
          if (fail) throw Exception('offline');
          version++;
          return FeedPageResponse(items: [_row('v$version')]);
        }),
      );
      await vm.loadFeed();
      fail = true;
      await vm.loadFeed();
      expect(vm.items.map((i) => i.id), ['v1']);

      fail = false;
      await vm.loadFeed();
      expect(vm.items.map((i) => i.id), ['v2']);
      expect(vm.error, isNull);
    });

    test('responses after dispose do not notify', () async {
      final page = Completer<FeedPageResponse>();
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((_) => page.future),
      );
      final load = vm.loadFeed();
      vm.dispose();
      page.complete(FeedPageResponse(items: [_row('late')]));

      await expectLater(load, completes);
    });
  });

  group('sharing guidance (CAN-3715)', () {
    FeedViewModel withSharing(
      FeedSharingStatus? status, {
      Object? sharingError,
    }) => FeedViewModel(
      repository: _ScriptedFeedRepository(
        (_) async => FeedPageResponse(items: [_row('a')]),
        sharing: () async {
          if (sharingError != null) throw sharingError;
          return status;
        },
      ),
    );

    FeedSharingStatus status(
      FeedSharingState metadata, [
      FeedSharingState plans = FeedSharingState.shared,
      FeedSharingState summaries = FeedSharingState.shared,
    ]) => FeedSharingStatus(
      metadata: metadata,
      plans: plans,
      summaries: summaries,
    );

    test('resolves the web feed-activity rules', () {
      const shared = FeedSharingState.shared;
      const private = FeedSharingState.private;
      const unknown = FeedSharingState.unknown;
      const prohibited = FeedSharingState.prohibited;
      expect(
        resolveFeedSharingGuidance(status(shared)),
        FeedSharingGuidance.none,
      );
      expect(
        resolveFeedSharingGuidance(status(private)),
        FeedSharingGuidance.offer,
      );
      expect(
        resolveFeedSharingGuidance(status(shared, unknown)),
        FeedSharingGuidance.offer,
      );
      expect(
        resolveFeedSharingGuidance(status(prohibited, shared, unknown)),
        FeedSharingGuidance.managed,
      );
      // Policy alone never invites the viewer to share.
      expect(
        resolveFeedSharingGuidance(status(shared, prohibited, prohibited)),
        FeedSharingGuidance.none,
      );
      expect(
        resolveFeedSharingGuidance(status(shared, prohibited, unknown)),
        FeedSharingGuidance.offer,
      );
    });

    test('shows evidence only after a successful unfiltered load', () async {
      final vm = withSharing(status(FeedSharingState.private));
      expect(vm.sharingGuidance, FeedSharingGuidance.none);
      await vm.loadFeed();
      expect(vm.sharingGuidance, FeedSharingGuidance.offer);

      await vm.setFilters(types: const {}, query: 'auth');
      expect(vm.sharingGuidance, FeedSharingGuidance.none);
    });

    test('a same-scope refresh keeps the settled guidance', () async {
      var page = Completer<FeedPageResponse>();
      final repository = _ScriptedFeedRepository(
        (_) => page.future,
        sharing: () async => status(FeedSharingState.private),
      );
      final vm = FeedViewModel(repository: repository);
      Future<void> settle(Future<void> load, {Object? error}) async {
        if (error == null) {
          page.complete(FeedPageResponse(items: [_row('a')]));
        } else {
          page.completeError(error);
        }
        await load;
        page = Completer();
      }

      var load = vm.loadFeed();
      expect(vm.sharingGuidance, FeedSharingGuidance.none);
      await settle(load);
      expect(vm.sharingGuidance, FeedSharingGuidance.offer);

      load = vm.loadFeed();
      expect(vm.isLoading, isTrue);
      expect(vm.sharingGuidance, FeedSharingGuidance.offer);
      await settle(load, error: Exception('offline'));
      expect(vm.sharingGuidance, FeedSharingGuidance.none);

      await settle(vm.loadFeed());
      expect(vm.sharingGuidance, FeedSharingGuidance.offer);

      load = vm.setFilters(types: const {}, query: 'auth');
      expect(vm.sharingGuidance, FeedSharingGuidance.none);
      await settle(load);
      expect(vm.sharingGuidance, FeedSharingGuidance.none);

      // Cleared filters have no settled page yet.
      load = vm.clearFilters();
      expect(vm.sharingGuidance, FeedSharingGuidance.none);
      await settle(load);
      expect(vm.sharingGuidance, FeedSharingGuidance.offer);
    });

    test('a stalled sharing read never holds the page or later refreshes', () {
      final stalled = Completer<FeedSharingStatus?>();
      var pages = 0;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((_) async {
          pages++;
          return FeedPageResponse(items: [_row('v$pages')]);
        }, sharing: () => stalled.future),
      );
      var settled = false;
      FakeAsync().run((async) {
        vm.loadFeed().then((_) => settled = true);
        async.flushMicrotasks();
        expect(settled, isTrue);
        expect(vm.items.map((i) => i.id), ['v1']);
        expect(vm.hasLoaded, isTrue);
        expect(vm.isLoading, isFalse);

        settled = false;
        vm.loadFeed().then((_) => settled = true);
        async.flushMicrotasks();
        expect(pages, 2);
        expect(settled, isTrue);
        expect(vm.items.map((i) => i.id), ['v2']);
        expect(vm.isLoading, isFalse);
      });
    });

    test('only the newest load applies a late sharing read', () {
      final reads = <Completer<FeedSharingStatus?>>[];
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository(
          (_) async => FeedPageResponse(items: [_row('a')]),
          sharing: () {
            reads.add(Completer());
            return reads.last.future;
          },
        ),
      );
      FakeAsync().run((async) {
        vm.loadFeed();
        async.flushMicrotasks();
        vm.loadFeed();
        async.flushMicrotasks();
        // The older read lands after a newer refresh owns the guidance.
        reads[0].complete(status(FeedSharingState.private));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.none);
        reads[1].complete(status(FeedSharingState.prohibited));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.managed);

        // A filter round trip supersedes the read that started under filters.
        vm.setFilters(types: const {}, query: 'auth');
        async.flushMicrotasks();
        vm.clearFilters();
        async.flushMicrotasks();
        reads[2].complete(status(FeedSharingState.shared));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.managed);
        reads[3].complete(status(FeedSharingState.private));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.offer);

        var notified = 0;
        vm.loadFeed();
        async.flushMicrotasks();
        vm.addListener(() => notified++);
        vm.dispose();
        reads[4].complete(status(FeedSharingState.prohibited));
        async.flushMicrotasks();
        expect(notified, 0);
      });
    });

    test('a failed page drops its sharing read and a later page keeps the '
        'settled guidance until its own read lands', () {
      var failPage = false;
      final reads = <Completer<FeedSharingStatus?>>[];
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository(
          (_) async {
            if (failPage) throw Exception('offline');
            return FeedPageResponse(items: [_row('a')]);
          },
          sharing: () {
            reads.add(Completer());
            return reads.last.future;
          },
        ),
      );
      FakeAsync().run((async) {
        vm.loadFeed();
        reads[0].complete(status(FeedSharingState.private));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.offer);

        failPage = true;
        vm.loadFeed();
        async.flushMicrotasks();
        reads[1].complete(status(FeedSharingState.prohibited));
        async.flushMicrotasks();
        expect(vm.error, isNotNull);
        expect(vm.items.map((i) => i.id), ['a']);
        expect(vm.sharingGuidance, FeedSharingGuidance.none);

        failPage = false;
        vm.loadFeed();
        async.flushMicrotasks();
        expect(vm.error, isNull);
        expect(vm.isLoading, isFalse);
        expect(vm.sharingGuidance, FeedSharingGuidance.offer);
        // A failed read is absent evidence, so the guidance goes silent.
        reads[2].completeError(Exception('403'));
        async.flushMicrotasks();
        expect(vm.sharingGuidance, FeedSharingGuidance.none);
      });
    });

    test('a failed or absent sharing read never fails the feed', () async {
      final failing = withSharing(null, sharingError: Exception('403'));
      await failing.loadFeed();
      expect(failing.error, isNull);
      expect(failing.items, hasLength(1));
      expect(failing.sharingGuidance, FeedSharingGuidance.none);

      final personal = withSharing(null);
      await personal.loadFeed();
      expect(personal.sharingGuidance, FeedSharingGuidance.none);
    });
  });

  group('CAN-3715 same-context refresh', () {
    /// Serves [feed] and records each cursor as the ID it names. [hold]
    /// answers a fetch instead when it returns a response.
    FeedViewModel serve(
      _KeysetFeed feed, {
      List<String?>? cursors,
      Future<FeedPageResponse>? Function(String? cursor)? hold,
    }) => FeedViewModel(
      repository: _ScriptedFeedRepository((cursor) {
        cursors?.add(cursor?.split('|').last);
        return hold?.call(cursor) ?? feed.page(cursor);
      }),
    );

    test('a refresh after Load more reads to the last read row, keeps the '
        'read rows and continues after them', () async {
      final feed = _KeysetFeed(20, pageSize: 5);
      final cursors = <String?>[];
      final vm = serve(feed, cursors: cursors);
      await vm.loadFeed();
      await vm.loadMore();
      expect(_ids(vm), feed.ids.take(10));

      feed.arrive(1);
      feed.update('row-18');
      await vm.loadFeed();

      // The page that holds the last read row ends the read.
      expect(cursors, [null, 'row-15', null, 'row-16', 'row-11']);
      expect(_ids(vm), feed.ids.take(15));
      expect(vm.hasMore, isTrue);
      await vm.loadMore();
      await vm.loadMore();
      expect(_ids(vm), feed.ids);
      expect(vm.hasMore, isFalse);
    });

    test('a refresh after the final page reads to the end', () async {
      final feed = _KeysetFeed(12, pageSize: 5);
      final vm = serve(feed);
      await vm.loadFeed();
      await vm.loadMore();
      await vm.loadMore();
      expect(vm.hasMore, isFalse);

      feed.arrive(1);
      await vm.loadFeed();

      expect(_ids(vm), feed.ids);
      expect(vm.hasMore, isFalse);
    });

    test('a refresh with more new work than a page reads it down to the '
        'read rows', () async {
      final feed = _KeysetFeed(20, pageSize: 5);
      final cursors = <String?>[];
      final vm = serve(feed, cursors: cursors);
      await vm.loadFeed();
      await vm.loadMore();

      // The first page is all new work, so it cannot reach the read rows.
      feed.arrive(7);
      await vm.loadFeed();

      expect(cursors.skip(2), [null, 'new-2', 'row-17', 'row-12']);
      expect(_ids(vm), feed.ids.take(20));
      expect(_ids(vm).take(7), [for (var i = 6; i >= 0; i--) 'new-$i']);
      expect(vm.hasMore, isTrue);
      await vm.loadMore();
      await vm.loadMore();
      expect(_ids(vm), feed.ids);
      expect(vm.hasMore, isFalse);
    });

    test('removed read rows go', () async {
      // The read rows are removed and new work lands.
      final gone = _KeysetFeed(10, pageSize: 5);
      final vm = serve(gone);
      await vm.loadFeed();
      for (final id in _ids(vm)) {
        gone.remove(id);
      }
      gone.arrive(2);
      await vm.loadFeed();
      expect(_ids(vm), gone.ids.take(5));
      expect(vm.hasMore, isTrue);

      // The whole feed fits one page: rows missing from it are gone.
      final whole = _KeysetFeed(3, pageSize: 5);
      final small = serve(whole);
      await small.loadFeed();
      whole.remove('row-1');
      whole.arrive(1);
      await small.loadFeed();
      expect(_ids(small), ['new-0', 'row-2', 'row-0']);
      expect(_ids(small), whole.ids);
      expect(small.hasMore, isFalse);
    });

    test('a repeated cursor in new work ends it', () async {
      final cursors = <String?>[];
      var firstPages = 0;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) async {
          cursors.add(cursor);
          if (cursor == null && firstPages++ == 0) {
            return FeedPageResponse(
              items: [_row('a', at: 10)],
              nextCursor: 'c1',
            );
          }
          if (cursor == null) {
            return FeedPageResponse(
              items: [_row('x', at: 30)],
              nextCursor: 'y',
            );
          }
          return FeedPageResponse(items: [_row('z', at: 20)], nextCursor: 'y');
        }),
      );
      await vm.loadFeed();
      await vm.loadFeed();

      expect(cursors, [null, null, 'y']);
      expect(_ids(vm), ['x', 'z']);
      expect(vm.hasMore, isFalse);
    });

    test('a failed page of new work keeps the read rows, and its retry '
        'reads them', () async {
      final feed = _KeysetFeed(20, pageSize: 5);
      var fail = false;
      final vm = serve(
        feed,
        hold: (cursor) =>
            fail && cursor != null ? Future.error(Exception('offline')) : null,
      );
      await vm.loadFeed();
      await vm.loadMore();
      final read = _ids(vm);

      feed.arrive(7);
      fail = true;
      await vm.loadFeed();
      expect(vm.error, isNotNull);
      expect(_ids(vm), read);
      expect(vm.hasMore, isTrue);

      fail = false;
      await vm.loadFeed();
      expect(vm.error, isNull);
      expect(_ids(vm), feed.ids.take(20));
      expect(vm.hasMore, isTrue);
    });

    test(
      'a filter change drops a refresh that is still reading new work',
      () async {
        final feed = _KeysetFeed(20, pageSize: 5);
        final late = Completer<FeedPageResponse>();
        var hold = false;
        final vm = serve(
          feed,
          hold: (cursor) {
            if (!hold || cursor == null) return null;
            hold = false;
            return late.future;
          },
        );
        await vm.loadFeed();
        await vm.loadMore();
        feed.arrive(7);

        hold = true;
        final refresh = vm.loadFeed();
        await pumpEventQueue();
        expect(hold, isFalse);
        await vm.setFilters(types: const {}, query: 'auth');
        final filtered = _ids(vm);
        expect(filtered, feed.ids.take(5));
        expect(vm.hasMore, isTrue);

        late.complete(await feed.page('0|'));
        await refresh;
        expect(_ids(vm), filtered);
        expect(vm.hasMore, isTrue);
        expect(vm.isLoading, isFalse);
      },
    );

    test(
      'a failed refresh keeps appended rows, and its retry reads them',
      () async {
        final feed = _KeysetFeed(20, pageSize: 5);
        var fail = false;
        final vm = serve(
          feed,
          hold: (cursor) => fail ? Future.error(Exception('offline')) : null,
        );
        await vm.loadFeed();
        await vm.loadMore();
        final read = _ids(vm);

        feed.arrive(1);
        fail = true;
        await vm.loadFeed();
        expect(vm.error, isNotNull);
        expect(_ids(vm), read);
        expect(vm.hasMore, isTrue);

        fail = false;
        await vm.loadFeed();
        expect(vm.error, isNull);
        expect(_ids(vm), feed.ids.take(15));
        expect(vm.hasMore, isTrue);
      },
    );

    test('overlapping refresh signals after Load more join once', () async {
      final feed = _KeysetFeed(20, pageSize: 5);
      final page = Completer<FeedPageResponse>();
      var hold = false;
      final cursors = <String?>[];
      final vm = serve(
        feed,
        cursors: cursors,
        hold: (cursor) => hold && cursor == null ? page.future : null,
      );
      await vm.loadFeed();
      await vm.loadMore();

      hold = true;
      final tab = vm.loadFeed();
      final resume = vm.loadFeed();
      page.complete(await feed.page(null));
      await Future.wait([tab, resume]);

      expect(cursors, [null, 'row-15', null, 'row-15']);
      expect(_ids(vm), feed.ids.take(10));
    });

    test('a filter change never joins the old rows', () async {
      final feed = _KeysetFeed(12, pageSize: 5);
      final vm = serve(feed);
      await vm.loadFeed();
      await vm.loadMore();

      await vm.setFilters(types: const {}, query: 'auth');
      expect(_ids(vm), feed.ids.take(5));

      await vm.clearFilters();
      expect(_ids(vm), feed.ids.take(5));
      expect(vm.hasMore, isTrue);
    });

    test(
      'an updated row moves to the top without dropping read rows',
      () async {
        // All 35 rows are read (30, then 5), and the oldest one is updated.
        final feed = _KeysetFeed(35, pageSize: 30);
        final vm = FeedViewModel(
          repository: _ScriptedFeedRepository(feed.page),
        );
        await vm.loadFeed();
        await vm.loadMore();
        final read = _ids(vm);
        expect(read, hasLength(35));
        expect(vm.hasMore, isFalse);

        feed.update(read.last);
        await vm.loadFeed();

        expect(_ids(vm), [read.last, ...read.take(34)]);
        expect(_ids(vm), feed.ids);
        expect(vm.hasMore, isFalse);
      },
    );

    test('an updated row that ends the first page is read past', () async {
      // The update lands before a page of new work, so the first page ends
      // with the updated copy of the last read row. That row moved, so the
      // refresh reads to a row older than it: here the end of the feed.
      final feed = _KeysetFeed(35, pageSize: 30);
      final cursors = <String?>[];
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) {
          cursors.add(cursor);
          return feed.page(cursor);
        }),
      );
      await vm.loadFeed();
      await vm.loadMore();
      final read = _ids(vm);

      feed.update(read.last);
      feed.arrive(29);
      await vm.loadFeed();

      expect(cursors, hasLength(5));
      expect(_ids(vm), feed.ids);
      expect(vm.hasMore, isFalse);
    });

    test('a refresh drops read rows that the new pages no longer hold, and '
        'continues after them', () async {
      final feed = _KeysetFeed(6, pageSize: 3);
      final vm = FeedViewModel(repository: _ScriptedFeedRepository(feed.page));
      await vm.loadFeed();
      expect(_ids(vm), ['row-5', 'row-4', 'row-3']);

      feed.remove('row-4');
      feed.remove('row-3');
      await vm.loadFeed();

      expect(_ids(vm), ['row-5', 'row-2', 'row-1']);
      expect(vm.hasMore, isTrue);
      await vm.loadMore();
      expect(_ids(vm), feed.ids);
      expect(vm.hasMore, isFalse);
    });

    test('a refresh that ends the feed keeps the read rows in place', () async {
      // Twenty rows fit one page, so every refresh reads the whole feed.
      final feed = _KeysetFeed(20, pageSize: 30);
      final vm = FeedViewModel(repository: _ScriptedFeedRepository(feed.page));
      await vm.loadFeed();
      final read = _ids(vm);

      feed.arrive(1);
      await vm.loadFeed();
      expect(_ids(vm), ['new-0', ...read]);
      expect(vm.hasMore, isFalse);

      // The first read row is removed.
      feed.remove(read.first);
      feed.arrive(1);
      await vm.loadFeed();
      expect(_ids(vm), ['new-1', 'new-0', ...read.skip(1)]);
    });

    test('rows that sync late below a read row stay reachable', () async {
      // All 35 rows are read (30, then 5). Then rows sync late: their event
      // times sort just below the newest read row.
      for (final count in [3, 30]) {
        final feed = _KeysetFeed(35, pageSize: 30);
        final vm = FeedViewModel(
          repository: _ScriptedFeedRepository(feed.page),
        );
        await vm.loadFeed();
        await vm.loadMore();
        expect(vm.hasMore, isFalse);

        feed.syncLate(feed.ids.first, count);
        await vm.loadFeed();

        expect(_ids(vm), feed.ids, reason: '$count late rows');
        expect(vm.hasMore, isFalse);
      }
    });

    test('late rows between read rows and below the cursor stay reachable, '
        'and removed read rows go', () async {
      final feed = _KeysetFeed(40, pageSize: 10);
      final vm = FeedViewModel(repository: _ScriptedFeedRepository(feed.page));
      await vm.loadFeed();
      await vm.loadMore();
      expect(_ids(vm).last, 'row-20');
      expect(vm.hasMore, isTrue);

      // Late rows land inside the first page, across its end, just above
      // the cursor and below it. Read rows are removed below the first page.
      feed.syncLate('row-39', 2);
      feed.syncLate('row-30', 3);
      feed.syncLate('row-21', 2);
      feed.syncLate('row-15', 2);
      feed.remove('row-25');
      feed.remove('row-20');
      await vm.loadFeed();

      // Every current row down to the depth already read is shown.
      final depth = feed.ids.indexOf('row-21');
      expect(_ids(vm).take(depth + 1), feed.ids.take(depth + 1));
      for (var i = 0; i < 10 && vm.hasMore; i++) {
        await vm.loadMore();
      }
      expect(_ids(vm), feed.ids);
    });

    test('rows tied with the last read row stay reachable once', () async {
      // Ties sort by ID, as the server sorts them by its source ID.
      final feed = _KeysetFeed(12, pageSize: 5);
      feed.tie('row-2', 'row-2-old');
      final vm = FeedViewModel(repository: _ScriptedFeedRepository(feed.page));
      await vm.loadFeed();
      await vm.loadMore();
      expect(_ids(vm).sublist(8), ['row-3', 'row-2-old']);

      // Tied rows land on both sides of the last read row, and a tied read
      // row is removed.
      feed.tie('row-2', 'row-2-new');
      feed.tie('row-2', 'row-1-tie');
      feed.remove('row-2-old');
      await vm.loadFeed();
      expect(_ids(vm), isNot(contains('row-2-old')));
      expect(_ids(vm), feed.ids.take(_ids(vm).length));

      for (var i = 0; i < 10 && vm.hasMore; i++) {
        await vm.loadMore();
      }
      expect(_ids(vm), feed.ids);
    });

    test('seeded updates and removals keep an ordered run of the feed and '
        'never drop or revive read rows', () async {
      const pageSize = 5;
      for (var seed = 0; seed < 300; seed++) {
        final random = Random(seed);
        // Small feeds end within one refresh; larger ones need Load more.
        final feed = _KeysetFeed(
          random.nextInt(pageSize * 4),
          pageSize: pageSize,
        );
        final vm = FeedViewModel(
          repository: _ScriptedFeedRepository(feed.page),
        );
        await vm.loadFeed();
        final steps = <String>[];
        for (var step = 0; step < 30; step++) {
          final before = vm.items;
          final choice = random.nextInt(5);
          final live = feed.ids;
          if (choice == 0) {
            final count = random.nextInt(pageSize + 2);
            feed.arrive(count);
            steps.add('arrive $count');
          } else if (choice == 1 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            feed.update(id);
            steps.add('update $id');
          } else if (choice == 2 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            feed.remove(id);
            steps.add('remove $id');
          } else if (choice == 3) {
            await vm.loadFeed();
            steps.add('refresh');
            _expectRefreshed(vm, feed, before, 'seed $seed: $steps');
          } else {
            await vm.loadMore();
            steps.add('more');
          }
          final reason = 'seed $seed: $steps';
          final ids = _ids(vm);
          expect(ids.toSet(), hasLength(ids.length), reason: reason);
          // While every shown row is current, they are one run of the feed.
          if (vm.items.every((i) => feed.occurredAt(i.id) == i.occurredAt) &&
              ids.isNotEmpty) {
            final start = feed.ids.indexOf(ids.first);
            expect(
              ids,
              feed.ids.sublist(start, start + ids.length),
              reason: reason,
            );
            if (!vm.hasMore) {
              expect(start + ids.length, feed.ids.length, reason: reason);
            }
          }
        }
      }
    });

    test('seeded arrival, refresh and append sequences keep a gap-free '
        'run of the feed and never drop read rows', () async {
      const pageSize = 5;
      for (var seed = 0; seed < 200; seed++) {
        final random = Random(seed);
        final feed = _KeysetFeed(23, pageSize: pageSize);
        final vm = FeedViewModel(
          repository: _ScriptedFeedRepository(feed.page),
        );
        await vm.loadFeed();
        final steps = <String>[];
        for (var step = 0; step < 25; step++) {
          final shown = _ids(vm);
          switch (random.nextInt(3)) {
            case 0:
              final count = random.nextInt(pageSize + 2);
              feed.arrive(count);
              steps.add('arrive $count');
            case 1:
              await vm.loadFeed();
              steps.add('refresh');
              final reason = 'seed $seed: ${steps.join(', ')}';
              expect(_ids(vm).first, feed.ids.first, reason: reason);
              expect(_ids(vm), containsAll(shown), reason: reason);
            default:
              await vm.loadMore();
              steps.add('more');
          }
          final reason = 'seed $seed: ${steps.join(', ')}';
          final ids = _ids(vm);
          final start = feed.ids.indexOf(ids.first);
          expect(start, isNonNegative, reason: reason);
          expect(
            ids,
            feed.ids.sublist(start, start + ids.length),
            reason: reason,
          );
          expect(
            vm.hasMore,
            start + ids.length < feed.ids.length,
            reason: reason,
          );
        }
      }
    });

    test('seeded late syncs, ties, updates and removals keep a refreshed '
        'list current to the read depth and every row reachable', () async {
      const pageSize = 5;
      for (var seed = 0; seed < 300; seed++) {
        final random = Random(seed);
        final feed = _KeysetFeed(
          random.nextInt(pageSize * 5),
          pageSize: pageSize,
        );
        final vm = FeedViewModel(
          repository: _ScriptedFeedRepository(feed.page),
        );
        await vm.loadFeed();
        final steps = <String>[];
        var ties = 0;
        for (var step = 0; step < 30; step++) {
          final before = vm.items;
          final live = feed.ids;
          final choice = random.nextInt(7);
          if (choice == 0) {
            final count = random.nextInt(pageSize + 2);
            feed.arrive(count);
            steps.add('arrive $count');
          } else if (choice == 1 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            feed.update(id);
            steps.add('update $id');
          } else if (choice == 2 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            feed.remove(id);
            steps.add('remove $id');
          } else if (choice == 3 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            final count = 1 + random.nextInt(pageSize + 2);
            feed.syncLate(id, count);
            steps.add('late $count below $id');
          } else if (choice == 4 && live.isNotEmpty) {
            final id = live[random.nextInt(live.length)];
            feed.tie(id, '$id-tie-${ties++}');
            steps.add('tie $id');
          } else if (choice == 5) {
            await vm.loadFeed();
            steps.add('refresh');
            final reason = 'seed $seed: ${steps.join(', ')}';
            final ids = _ids(vm);
            // The refreshed rows are the feed's own rows, in its order.
            expect(ids, feed.ids.take(ids.length), reason: reason);
            expect(vm.hasMore, ids.length < feed.ids.length, reason: reason);
            // They reach at least as deep as the rows read before.
            if (before.isNotEmpty) {
              final depth = DateTime.parse(before.last.occurredAt);
              for (final id in feed.ids) {
                if (DateTime.parse(feed.occurredAt(id)!).isAfter(depth)) {
                  expect(ids, contains(id), reason: reason);
                }
              }
            }
          } else {
            await vm.loadMore();
            steps.add('more');
          }
          final ids = _ids(vm);
          final reason = 'seed $seed: ${steps.join(', ')}';
          expect(ids.toSet(), hasLength(ids.length), reason: reason);
        }
        // A refresh and Load more reach every row once, in order.
        await vm.loadFeed();
        for (var i = 0; i < 100 && vm.hasMore; i++) {
          await vm.loadMore();
        }
        expect(
          _ids(vm),
          feed.ids,
          reason: 'seed $seed: ${steps.join(', ')}, refresh, more',
        );
      }
    });
  });

  group('CAN-3715 failed refresh', () {
    test('a failed refresh keeps the current rows', () async {
      var fail = false;
      final vm = FeedViewModel(
        repository: _ScriptedFeedRepository((cursor) async {
          if (fail) throw Exception('offline');
          return FeedPageResponse(items: [_row('a'), _row('b')]);
        }),
      );
      await vm.loadFeed();
      fail = true;
      await vm.loadFeed();

      expect(vm.items.map((i) => i.id), ['a', 'b']);
      expect(vm.error, isNotNull);
    });
  });
}

FeedItem _row(String id, {String? branch, int at = 0}) =>
    WorktreeUpdatedFeedItem(
      actor: FeedActor(displayName: 'Brady', userId: 'user-1'),
      id: id,
      occurredAt: DateTime.utc(
        2026,
        8,
        20,
        12,
      ).add(Duration(seconds: at)).toIso8601String(),
      branchName: branch ?? 'branch-$id',
    );

List<String> _ids(FeedViewModel vm) => [for (final item in vm.items) item.id];

/// Checks a refresh of the [before] rows against [feed].
void _expectRefreshed(
  FeedViewModel vm,
  _KeysetFeed feed,
  List<FeedItem> before,
  String reason,
) {
  final ids = _ids(vm);
  // The rows are the feed's current rows from its top, without a gap.
  expect(ids, feed.ids.take(ids.length), reason: reason);
  if (!vm.hasMore) expect(ids, feed.ids, reason: reason);
  // Read rows that still exist stay shown.
  for (final item in before) {
    if (feed.occurredAt(item.id) != null) {
      expect(ids, contains(item.id), reason: reason);
    }
  }
}

/// A newest-first keyset feed in the server's order: occurredAt, then ID
/// descending (the server breaks ties by an internal source ID that mobile
/// cannot see). An update moves a row to the top under the same ID. A cursor
/// holds the occurredAt and ID of the last row of its page, as the server's
/// value cursor does, and a page holds only the rows after it.
final class _KeysetFeed {
  _KeysetFeed(int rows, {required this.pageSize}) {
    for (var i = 0; i < rows; i++) {
      _times['row-$i'] = _clock += _step;
    }
  }

  /// Seconds between events, so late rows fit below a row.
  static const _step = 1000;

  final int pageSize;
  final _times = <String, int>{};
  var _clock = 0;
  var _arrivals = 0;
  var _late = 0;

  List<String> get ids => _times.keys.toList()
    ..sort((a, b) {
      final byTime = _times[b]!.compareTo(_times[a]!);
      return byTime != 0 ? byTime : b.compareTo(a);
    });

  /// The current occurredAt of row [id], or null when it is gone.
  String? occurredAt(String id) {
    final at = _times[id];
    return at == null ? null : _row(id, at: at).occurredAt;
  }

  void arrive(int count) {
    for (var i = 0; i < count; i++) {
      _times['new-${_arrivals++}'] = _clock += _step;
    }
  }

  void update(String id) => _times[id] = _clock += _step;

  void remove(String id) => _times.remove(id);

  /// [count] rows sync late: their event times sort just below row [below].
  void syncLate(String below, int count) {
    for (var i = 0; i < count; i++) {
      _times['late-${_late++}'] = _times[below]! - i - 1;
    }
  }

  /// Adds row [id] with the occurredAt of row [like]; the IDs break the tie.
  void tie(String like, String id) => _times[id] = _times[like]!;

  Future<FeedPageResponse> page(String? cursor) async {
    var rows = ids;
    if (cursor != null) {
      final [time, after] = cursor.split('|');
      final before = int.parse(time);
      rows = [
        for (final id in rows)
          if (_times[id]! < before ||
              (_times[id] == before && id.compareTo(after) < 0))
            id,
      ];
    }
    final page = rows.take(pageSize).toList();
    return FeedPageResponse(
      items: [for (final id in page) _row(id, at: _times[id]!)],
      nextCursor: rows.length > page.length
          ? '${_times[page.last]}|${page.last}'
          : null,
    );
  }
}

/// Answers each fetch through [next], keyed by the requested cursor.
final class _ScriptedFeedRepository implements FeedRepository {
  _ScriptedFeedRepository(this.next, {this.sharing});

  Future<FeedPageResponse> Function(String? cursor) next;
  final Future<FeedSharingStatus?> Function()? sharing;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) => next(cursor);

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => sharing?.call();
}
