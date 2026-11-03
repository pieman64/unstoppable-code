import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_platform_interface.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:mobile/data/models/remote_file_diff.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_diff_cache.dart';

RemoteFileDiffCacheKey _key(
  String path, {
  String worktree = 'wt-1',
  String? revision = 'revision-1',
}) => RemoteFileDiffCacheKey(
  workspaceLocalId: 'ws-1',
  worktreeLocalId: worktree,
  repoId: null,
  path: path,
  source: RemoteDiffSource.uncommitted,
  revision: revision,
  status: 'modified',
  insertions: 1,
  deletions: 0,
);

RemoteFileDiff _diff(String path) =>
    RemoteFileDiff(filePath: path, patch: '+x');

class _RecordingStore extends InMemorySharedPreferencesStore {
  _RecordingStore() : super.empty();
  final writes = <String>[];
  int removes = 0;

  @override
  Future<bool> setValue(String valueType, String key, Object value) {
    if (value is String) writes.add(value);
    return super.setValue(valueType, key, value);
  }

  @override
  Future<bool> remove(String key) {
    removes++;
    return super.remove(key);
  }
}

class _CountingDiff extends RemoteFileDiff {
  _CountingDiff(String path) : super(filePath: path, patch: '');
  int serializations = 0;

  @override
  String get patch {
    serializations++;
    return '雪\n' * 100;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() => SharedPreferences.setMockInitialValues({}));
  group('RemoteFileDiffCache', () {
    test(
      'clear fences an in-flight restore and same-session restores share a load',
      () async {
        final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await first.restoreSession('session-1');
        first.put(_key('a'), _diff('a'));
        await first.flush();
        final cold = RemoteFileDiffCache(maxEntries: 4, persist: true);
        final restoring = cold.restoreSession('session-1');
        expect(cold.restoreSession('session-1'), same(restoring));
        cold.clear();
        await restoring;
        await cold.flush();
        expect(cold.length, 0);
        final restarted = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await restarted.restoreSession('session-1');
        expect(restarted.length, 0);
      },
    );

    test(
      'UTF-8 budget includes session, row separators and LRU replacements',
      () async {
        final store = _RecordingStore();
        SharedPreferencesStorePlatform.instance = store;
        final now = DateTime.utc(2026, 10, 30);
        RemoteFileDiff diff(String path) =>
            RemoteFileDiff(filePath: path, patch: '雪\\\n' * 30);
        final roomy = RemoteFileDiffCache(
          maxEntries: 4,
          persist: true,
          clock: () => now,
        );
        await roomy.restoreSession('session-雪');
        roomy.put(_key('a'), diff('a'));
        roomy.put(_key('b'), diff('b'));
        await roomy.flush();
        final budget = utf8.encode(store.writes.last).length;
        final bounded = RemoteFileDiffCache(
          maxEntries: 4,
          maxBytes: budget,
          persist: true,
          clock: () => now,
        );
        await bounded.restoreSession('session-雪');
        expect(bounded.length, 2);
        expect(bounded.get(_key('a')), isNotNull);
        bounded.put(_key('c'), diff('c'));
        expect(bounded.length, 2);
        expect(bounded.get(_key('b')), isNull);
        expect(bounded.get(_key('a')), isNotNull);
        await bounded.flush();
        expect(utf8.encode(store.writes.last).length, budget);
        bounded.clearWorktree(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
        );
        bounded.put(_key('d'), diff('d'));
        bounded.put(_key('e'), diff('e'));
        expect(bounded.length, 2);
        await bounded.flush();
        expect(utf8.encode(store.writes.last).length, budget);
      },
    );

    test('clear cancels a deferred write before a new pairing', () {
      fakeAsync((async) {
        final store = _RecordingStore();
        SharedPreferencesStorePlatform.instance = store;
        final cache = RemoteFileDiffCache(maxEntries: 4, persist: true);
        cache.restoreSession('old');
        async.flushMicrotasks();
        cache.put(_key('old'), _diff('old'));
        cache.clear();
        cache.restoreSession('new');
        async.flushMicrotasks();
        cache.put(_key('new'), _diff('new'));
        async.elapse(const Duration(milliseconds: 500));
        async.flushMicrotasks();
        expect(store.writes, hasLength(1));
        expect(
          jsonDecode(store.writes.single),
          containsPair('sessionId', 'new'),
        );
        expect(store.writes.single, isNot(contains('"path":"old"')));
      });
    });

    test('puts encode each row once and coalesce storage writes', () {
      fakeAsync((async) {
        final store = _RecordingStore();
        SharedPreferencesStorePlatform.instance = store;
        final cache = RemoteFileDiffCache(maxEntries: 4, persist: true);
        cache.restoreSession('session-1');
        async.flushMicrotasks();
        final diffs = [for (var i = 0; i < 5; i++) _CountingDiff('$i')];
        for (final diff in diffs) {
          cache.put(_key(diff.filePath), diff);
        }
        async.flushMicrotasks();
        expect(store.writes, isEmpty);
        expect(diffs.map((diff) => diff.serializations), everyElement(1));
        async.elapse(const Duration(milliseconds: 500));
        async.flushMicrotasks();
        expect(store.writes, hasLength(1));
        expect(
          utf8.encode(store.writes.single).length,
          lessThanOrEqualTo(cache.maxBytes),
        );
        expect(diffs.map((diff) => diff.serializations), everyElement(1));
        cache.put(_key('next'), _diff('next'));
        cache.flush();
        async.flushMicrotasks();
        expect(store.writes, hasLength(2));
      });
    });

    test('get expiry and revision misses never write storage', () async {
      final store = _RecordingStore();
      SharedPreferencesStorePlatform.instance = store;
      var now = DateTime.utc(2026, 10, 30);
      final cache = RemoteFileDiffCache(
        maxEntries: 4,
        persist: true,
        clock: () => now,
      );
      await cache.restoreSession('session-1');
      cache.put(_key('a'), _diff('a'));
      cache.put(_key('b'), _diff('b'));
      await cache.flush();
      final writes = store.writes.length;
      final removes = store.removes;
      expect(cache.get(_key('a', revision: 'changed')), isNull);
      now = now.add(const Duration(minutes: 16));
      expect(cache.get(_key('b')), isNull);
      await cache.flush();
      expect(store.writes.length, writes);
      expect(store.removes, removes);
    });

    test('cold cache restores only the same session and revision', () async {
      final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await first.restoreSession('session-1');
      first.put(_key('a'), _diff('a'));
      await first.flush();
      final cold = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await cold.restoreSession('session-1');
      expect(cold.get(_key('a'))?.patch, '+x');
      expect(cold.get(_key('a', revision: 'revision-2')), isNull);
      cold.put(_key('b'), _diff('b'));
      await cold.flush();
      await cold.restoreSession('session-2');
      expect(cold.get(_key('b')), isNull);
      await cold.flush();
      final oldSession = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await oldSession.restoreSession('session-1');
      expect(oldSession.get(_key('b')), isNull);
    });

    test('missing revision cannot survive a cold start', () async {
      final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await first.restoreSession('session-1');
      first.put(_key('a', revision: null), _diff('a'));
      await first.flush();
      final cold = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await cold.restoreSession('session-1');
      expect(cold.get(_key('a', revision: null)), isNull);
    });

    test('cold restore removes expired entries from storage', () async {
      var now = DateTime.utc(2026, 9, 22);
      final first = RemoteFileDiffCache(
        maxEntries: 4,
        persist: true,
        clock: () => now,
      );
      await first.restoreSession('session-1');
      first.put(_key('a'), _diff('a'));
      await first.flush();

      now = now.add(const Duration(minutes: 16));
      final cold = RemoteFileDiffCache(
        maxEntries: 4,
        persist: true,
        clock: () => now,
      );
      await cold.restoreSession('session-1');
      await cold.flush();

      final preferences = await SharedPreferences.getInstance();
      expect(preferences.getKeys(), isEmpty);
    });

    test(
      'restoring no session erases a persisted cache on cold start',
      () async {
        final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await first.restoreSession('session-1');
        first.put(_key('a'), _diff('a'));
        await first.flush();

        final disconnected = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await disconnected.restoreSession(null);
        await disconnected.flush();

        final oldSession = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await oldSession.restoreSession('session-1');
        expect(oldSession.get(_key('a')), isNull);
      },
    );

    test('expiry, byte budget, and clear bound persisted diffs', () async {
      var now = DateTime.utc(2026, 9, 22);
      final cache = RemoteFileDiffCache(
        maxEntries: 4,
        persist: true,
        maxBytes: 1000,
        clock: () => now,
      );
      await cache.restoreSession('session-1');
      cache.put(_key('a'), _diff('a'));
      cache.put(
        _key('large'),
        RemoteFileDiff(filePath: 'large', patch: 'x' * 1001),
      );
      expect(cache.get(_key('large')), isNull);
      expect(cache.get(_key('a')), isNotNull);
      now = now.add(const Duration(minutes: 16));
      expect(cache.get(_key('a')), isNull);
      cache.put(_key('b'), _diff('b'));
      cache.clear();
      await cache.flush();
      final cold = RemoteFileDiffCache(maxEntries: 4, persist: true);
      await cold.restoreSession('session-1');
      expect(cold.length, 0);
    });

    test('an older in-flight result cannot replace a newer completion', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      final old = cache.beginRead(_key('a'));
      final newer = cache.beginRead(_key('a'));
      cache.put(
        _key('a'),
        const RemoteFileDiff(filePath: 'a', patch: '+new'),
        readId: newer,
      );
      cache.put(
        _key('a'),
        const RemoteFileDiff(filePath: 'a', patch: '+old'),
        readId: old,
      );
      expect(cache.get(_key('a'))?.patch, '+new');
      final pending = cache.beginRead(_key('b'));
      cache.clear();
      cache.put(_key('b'), _diff('b'), readId: pending);
      expect(cache.length, 0);
    });

    test(
      'late disk restoration cannot overwrite a fresh network result',
      () async {
        final first = RemoteFileDiffCache(maxEntries: 4, persist: true);
        await first.restoreSession('session-1');
        first.put(_key('a'), _diff('a'));
        await first.flush();
        final cold = RemoteFileDiffCache(maxEntries: 4, persist: true);
        final restoring = cold.restoreSession('session-1');
        cold.put(
          _key('a'),
          const RemoteFileDiff(filePath: 'a', patch: '+fresh'),
        );
        await restoring;
        expect(cold.get(_key('a'))?.patch, '+fresh');
        await cold.flush();
      },
    );

    test('repo, source, path, and workspace identities stay isolated', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      cache.put(_key('a'), _diff('a'));
      for (final key in [
        RemoteFileDiffCacheKey(
          workspaceLocalId: 'other',
          worktreeLocalId: 'wt-1',
          repoId: null,
          path: 'a',
          source: RemoteDiffSource.uncommitted,
          status: 'modified',
          insertions: 1,
          deletions: 0,
          revision: 'revision-1',
        ),
        RemoteFileDiffCacheKey(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoId: 'other',
          path: 'a',
          source: RemoteDiffSource.uncommitted,
          status: 'modified',
          insertions: 1,
          deletions: 0,
          revision: 'revision-1',
        ),
        RemoteFileDiffCacheKey(
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          repoId: null,
          path: 'a',
          source: RemoteDiffSource.committed,
          status: 'modified',
          insertions: 1,
          deletions: 0,
          revision: 'revision-1',
        ),
        _key('b'),
      ]) {
        expect(cache.get(key), isNull);
      }
      expect(cache.get(_key('a')), isNotNull);
    });

    test('returns a stored diff for an equal key', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      cache.put(_key('a'), _diff('a'));
      expect(cache.get(_key('a'))?.filePath, 'a');
      expect(cache.get(_key('b')), isNull);
    });

    test('a changed row signature misses the cache', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      cache.put(_key('a'), _diff('a'));
      final grown = RemoteFileDiffCacheKey(
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
        repoId: null,
        path: 'a',
        source: RemoteDiffSource.uncommitted,
        status: 'modified',
        revision: 'revision-1',
        insertions: 2,
        deletions: 0,
      );
      expect(cache.get(grown), isNull);
      expect(cache.get(_key('a')), isNull);
    });

    test('evicts the least recently used entry past maxEntries', () {
      final cache = RemoteFileDiffCache(maxEntries: 2);
      cache.put(_key('a'), _diff('a'));
      cache.put(_key('b'), _diff('b'));
      // Touch `a` so `b` becomes the oldest.
      expect(cache.get(_key('a')), isNotNull);
      cache.put(_key('c'), _diff('c'));
      expect(cache.get(_key('b')), isNull);
      expect(cache.get(_key('a')), isNotNull);
      expect(cache.get(_key('c')), isNotNull);
      expect(cache.length, 2);
    });

    test('clearWorktree drops only that worktree', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      cache.put(_key('a'), _diff('a'));
      cache.put(_key('b', worktree: 'wt-2'), _diff('b'));
      cache.clearWorktree(workspaceLocalId: 'ws-1', worktreeLocalId: 'wt-1');
      expect(cache.get(_key('a')), isNull);
      expect(cache.get(_key('b', worktree: 'wt-2')), isNotNull);
    });

    test('clear empties everything', () {
      final cache = RemoteFileDiffCache(maxEntries: 4);
      cache.put(_key('a'), _diff('a'));
      cache.clear();
      expect(cache.length, 0);
    });
  });
}
