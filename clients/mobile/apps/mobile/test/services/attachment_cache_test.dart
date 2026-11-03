import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/services/attachment_cache.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory root;
  late Directory cacheDir;
  late AttachmentCache cache;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    root = await Directory.systemTemp.createTemp('attachment-cache-test-');
    cacheDir = await Directory(p.join(root.path, 'cache')).create();
    cache = AttachmentCache(temporaryDirectories: () async => [cacheDir]);
  });
  tearDown(() async => root.delete(recursive: true));

  Future<File> file(String name, {bool original = false}) => File(
    p.join(original ? root.path : cacheDir.path, name),
  ).writeAsString(name);

  test(
    'archive clears only its cached copies and survives a new service instance',
    () async {
      final own = await file('own.png');
      final other = await file('other.png');
      final original = await file('original.png', original: true);
      await cache.record('ws', 'one', [own.path, original.path]);
      await cache.record('ws', 'two', [other.path]);
      await AttachmentCache(
        temporaryDirectories: () async => [cacheDir],
      ).clear('ws', 'one');
      expect(await own.exists(), isFalse);
      expect(await other.exists(), isTrue);
      expect(await original.exists(), isTrue);
    },
  );

  test(
    'shared cache file remains until the last worktree is archived',
    () async {
      final shared = await file('shared.png');
      await cache.record('ws', 'one', [shared.path]);
      await cache.record('ws', 'two', [shared.path]);
      await cache.clear('ws', 'one');
      expect(await shared.exists(), isTrue);
      await cache.clear('ws', 'two');
      expect(await shared.exists(), isFalse);
    },
  );

  test(
    'a reused path is shared only when its fingerprint still matches',
    () async {
      final shared = await file('shared.png');
      await cache.record('ws', 'old-owner', [shared.path]);
      await shared.writeAsString('replacement contents');
      await cache.record('ws', 'new-owner', [shared.path]);

      await cache.clear('ws', 'new-owner');

      expect(await shared.exists(), isFalse);
    },
  );

  test('does not follow a symlink to an original', () async {
    final original = await file('original.png', original: true);
    final link = await Link(
      p.join(cacheDir.path, 'linked.png'),
    ).create(original.path);
    await cache.record('ws', 'one', [link.path]);
    await cache.clear('ws', 'one');
    expect(await original.exists(), isTrue);
    expect(await link.exists(), isTrue);
  });

  test('does not delete a replacement at a recorded path', () async {
    final picked = await file('picked.png');
    await cache.record('ws', 'one', [picked.path]);
    await picked.writeAsString('a different file with different length');
    await cache.clear('ws', 'one');
    expect(await picked.exists(), isTrue);
  });

  test(
    'a picker finishing after archive immediately reclaims its copy',
    () async {
      final picked = await file('late.png');
      await cache.clear('ws', 'one');
      await cache.record('ws', 'one', [picked.path]);
      expect(await picked.exists(), isFalse);
    },
  );

  test(
    'retains an archive marker until failed cleanup can be retried',
    () async {
      var failDirectoryLookup = false;
      cache = AttachmentCache(
        temporaryDirectories: () async {
          if (failDirectoryLookup) {
            throw const FileSystemException('temporary directory unavailable');
          }
          return [cacheDir];
        },
      );
      final picked = await file('retry.png');
      await cache.record('ws', 'one', [picked.path]);
      await cache.trackArchiveCommand('archive-1', 'ws', 'one');

      failDirectoryLookup = true;
      await cache.finishArchiveCommand('archive-1', succeeded: true);

      final pending = await cache.pendingArchiveCommands();
      expect(pending, hasLength(1));
      expect(pending.single.commandId, 'archive-1');
      expect(pending.single.createdAt, isA<DateTime>());
      expect(pending.single.workspaceId, 'ws');
      expect(pending.single.worktreeId, 'one');
      expect(await picked.exists(), isTrue);

      failDirectoryLookup = false;
      await cache.finishArchiveCommand('archive-1', succeeded: true);

      expect(await cache.pendingArchiveCommands(), isEmpty);
      expect(await picked.exists(), isFalse);
    },
  );

  test(
    'keeps every archive command marker when the same owner is retried',
    () async {
      final picked = await file('overlapping-commands.png');
      await cache.record('ws', 'one', [picked.path]);

      await cache.trackArchiveCommand('archive-original', 'ws', 'one');
      await cache.trackArchiveCommand('archive-retry', 'ws', 'one');

      expect(
        (await cache.pendingArchiveCommands()).map(
          (archive) => archive.commandId,
        ),
        containsAll(['archive-original', 'archive-retry']),
      );

      await cache.finishArchiveCommand('archive-original', succeeded: true);
      expect(await picked.exists(), isFalse);
      expect(
        (await cache.pendingArchiveCommands()).single.commandId,
        'archive-retry',
      );

      await cache.finishArchiveCommand('archive-retry', succeeded: false);
      expect(await cache.pendingArchiveCommands(), isEmpty);
    },
  );
}
