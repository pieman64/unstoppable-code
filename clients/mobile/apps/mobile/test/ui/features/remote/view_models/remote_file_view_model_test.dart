// CAN-5130: file and image reads for the worktree file viewer. The repository
// fake records every request, so "never read" claims are checked directly.
import 'dart:async';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/ui/core/widgets/message_markdown_image.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_view_model.dart';

import '../../../../support/remote_file_viewer_fixture.dart';

const _text = RemoteFileContents(
  contents: '# Report',
  truncated: false,
  unsupported: false,
);

RemoteFileRequest _request(String path) => RemoteFileRequest(
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  fileRootLocalId: 'root-1',
  relativePath: path,
);

Matcher _imageFailure(MessageImageFailure failure) => throwsA(same(failure));

void main() {
  late RemoteFileViewerRepository repository;

  setUp(() => repository = RemoteFileViewerRepository());

  RemoteFileViewModel viewModel({
    String path = remoteFileFixturePath,
    bool desktopOnline = true,
    int imageCacheBytes = 1024,
  }) {
    final vm = RemoteFileViewModel(
      repository: repository,
      request: _request(path),
      desktopOnline: desktopOnline,
      imageCacheBytes: imageCacheBytes,
    );
    addTearDown(vm.dispose);
    return vm;
  }

  group('header and modes', () {
    test('names the file and its folders', () {
      final vm = viewModel(path: 'reports/can-5130/report.md');
      expect(vm.fileName, 'report.md');
      expect(vm.folders, ['reports', 'can-5130']);
      expect(viewModel(path: 'README.md').folders, isEmpty);
    });

    test(
      'opens Markdown formatted and switches to source without a read',
      () async {
        repository.files['docs/a.md'] = _text;
        final vm = viewModel(path: 'docs/a.md');
        await vm.load();
        expect(vm.isMarkdown, isTrue);
        expect(vm.mode, RemoteFileMode.formatted);
        vm.showMode(RemoteFileMode.source);
        expect(vm.mode, RemoteFileMode.source);
        expect(vm.contents, same(_text));
        expect(repository.fileReads, hasLength(1));
      },
    );

    test('recognizes Markdown extensions case-insensitively', () {
      for (final path in ['a.md', 'b.MARKDOWN', 'c.Mdx']) {
        expect(viewModel(path: path).isMarkdown, isTrue, reason: path);
      }
      for (final path in ['a.txt', 'b.dart', 'md', 'c.md.bak']) {
        expect(viewModel(path: path).isMarkdown, isFalse, reason: path);
      }
    });

    test('keeps other text in source mode', () {
      final vm = viewModel(path: 'lib/main.dart');
      expect(vm.mode, RemoteFileMode.source);
      vm.showMode(RemoteFileMode.formatted);
      expect(vm.mode, RemoteFileMode.source);
    });
  });

  group('file states', () {
    test('is loading until the read answers', () async {
      repository.holdFiles = true;
      final vm = viewModel();
      final load = vm.load();
      expect(vm.loading, isTrue);
      expect(vm.contents, isNull);
      repository.heldFiles[remoteFileFixturePath]!.single.complete(_text);
      await load;
      expect(vm.loading, isFalse);
      expect(vm.contents, same(_text));
      expect(vm.problem, isNull);
    });

    test('reads the normalized path in the selected root', () async {
      repository.files['docs/a.md'] = _text;
      await viewModel(path: './docs//b/../a.md').load();
      final read = repository.fileReads.single;
      expect(read.relativePath, 'docs/a.md');
      expect(read.projectId, 'ws-1');
      expect(read.worktreeId, 'wt-1');
      expect(read.fileRootLocalId, 'root-1');
    });

    test('loads empty and truncated text as content', () async {
      const empty = RemoteFileContents(
        contents: '',
        truncated: false,
        unsupported: false,
      );
      const partial = RemoteFileContents(
        contents: 'partial',
        truncated: true,
        unsupported: false,
      );
      repository.files['empty.txt'] = empty;
      repository.files['big.txt'] = partial;
      final emptyVm = viewModel(path: 'empty.txt');
      final bigVm = viewModel(path: 'big.txt');
      await emptyVm.load();
      await bigVm.load();
      expect(emptyVm.contents, same(empty));
      expect(emptyVm.problem, isNull);
      expect(bigVm.contents?.truncated, isTrue);
      expect(bigVm.problem, isNull);
    });

    test('reports unsupported content as a problem', () async {
      repository.files['a.pdf'] = const RemoteFileContents(
        contents: '',
        truncated: false,
        unsupported: true,
      );
      final vm = viewModel(path: 'a.pdf');
      await vm.load();
      expect(vm.problem, RemoteFileProblem.unsupported);
      expect(vm.contents, isNull);
    });

    test('maps read failures to safe problems', () async {
      final cases = <Object, RemoteFileProblem>{
        RemoteFileFailure.notFound: RemoteFileProblem.notFound,
        RemoteFileFailure.outsideRoot: RemoteFileProblem.invalidPath,
        RemoteFileFailure.binaryFile: RemoteFileProblem.unsupported,
        RemoteFileFailure.permissionDenied: RemoteFileProblem.permissionDenied,
        RemoteFileFailure.timeout: RemoteFileProblem.timedOut,
        RemoteFileFailure.unavailable: RemoteFileProblem.unavailable,
        RemoteFileFailure.changed: RemoteFileProblem.unavailable,
        RemoteFileFailure.integrity: RemoteFileProblem.unavailable,
        RemoteFileFailure.invalidResponse: RemoteFileProblem.unavailable,
      };
      for (final MapEntry(key: failure, value: problem) in cases.entries) {
        repository.fileErrors['a.md'] = RemoteFileException(
          failure as RemoteFileFailure,
          'raw transport text',
        );
        final vm = viewModel(path: 'a.md');
        await vm.load();
        expect(vm.problem, problem, reason: '$failure');
        expect(vm.loading, isFalse);
      }
      repository.fileErrors['a.md'] = remoteFileNotConnected;
      final vm = viewModel(path: 'a.md');
      await vm.load();
      expect(vm.problem, RemoteFileProblem.offline);
    });

    test('retries after a transient failure', () async {
      repository.fileErrors['a.md'] = const RemoteFileException(
        RemoteFileFailure.timeout,
        'timed out',
      );
      final vm = viewModel(path: 'a.md');
      await vm.load();
      expect(vm.problem, RemoteFileProblem.timedOut);
      repository.fileErrors.clear();
      repository.files['a.md'] = _text;
      await vm.load();
      expect(vm.problem, isNull);
      expect(vm.contents, same(_text));
      expect(repository.fileReads, hasLength(2));
    });

    test(
      'waits for the desktop instead of reading while it is offline',
      () async {
        repository.files[remoteFileFixturePath] = _text;
        final vm = viewModel(desktopOnline: false);
        await vm.load();
        expect(vm.problem, RemoteFileProblem.offline);
        expect(repository.fileReads, isEmpty);
        vm.setDesktopOnline(true);
        await pumpEventQueue();
        expect(vm.contents, same(_text));
        expect(repository.fileReads, hasLength(1));
        vm.setDesktopOnline(false);
        vm.setDesktopOnline(true);
        await pumpEventQueue();
        expect(repository.fileReads, hasLength(1));
      },
    );

    test('rejects an unsafe file path without any read', () async {
      for (final path in [
        '../a.md',
        '/etc/passwd',
        r'C:\a.md',
        'file:a.md',
        'docs/../C:/report.md',
        'docs/../file:report.md',
      ]) {
        final vm = viewModel(path: path);
        await vm.load();
        expect(vm.problem, RemoteFileProblem.invalidPath, reason: path);
        await expectLater(
          vm.readImage('a.png'),
          _imageFailure(MessageImageFailure.unsupported),
        );
      }
      expect(repository.fileReads, isEmpty);
      expect(repository.assetReads, isEmpty);
    });

    test('ignores a superseded read that answers late', () async {
      repository.holdFiles = true;
      final vm = viewModel();
      final first = vm.load();
      final second = vm.load();
      final [older, newer] = repository.heldFiles[remoteFileFixturePath]!;
      newer.complete(_text);
      await second;
      older.complete(
        const RemoteFileContents(
          contents: 'stale',
          truncated: false,
          unsupported: false,
        ),
      );
      await first;
      expect(vm.contents, same(_text));
    });
  });

  group('images', () {
    final png = Uint8List.fromList(List.filled(100, 1));

    test('reads a relative source from the report folder and root', () async {
      repository.assets['reports/can-5130/after-light.png'] = png;
      final vm = viewModel();
      expect(await vm.readImage('./after-light.png'), same(png));
      final read = repository.assetReads.single;
      expect(read.relativePath, 'reports/can-5130/after-light.png');
      expect(read.projectId, 'ws-1');
      expect(read.worktreeId, 'wt-1');
      expect(read.fileRootLocalId, 'root-1');
      expect(read.repoId, isNull);
    });

    test('keeps unsafe and remote sources inert', () async {
      final vm = viewModel();
      for (final source in [
        'https://example.com/a.png',
        'http://example.com/a.png',
        '//example.com/a.png',
        'file:///etc/passwd',
        '/etc/passwd',
        '../../../secret.png',
        'data:image/png;base64,AAAA',
      ]) {
        await expectLater(
          vm.readImage(source),
          _imageFailure(MessageImageFailure.unsupported),
          reason: source,
        );
      }
      expect(repository.assetReads, isEmpty);
    });

    test('keeps sources that normalize to a drive or scheme inert', () async {
      repository.assets['shared/a.png'] = png;
      final vm = viewModel(path: 'docs/report.md');
      for (final source in [
        '../C:/secret.png',
        '%2e%2e/C:/secret.png',
        '../file:secret.png',
      ]) {
        await expectLater(
          vm.readImage(source),
          _imageFailure(MessageImageFailure.unsupported),
          reason: source,
        );
      }
      expect(repository.assetReads, isEmpty);
      // A parent segment that stays inside the root still reads.
      expect(await vm.readImage('../shared/a.png'), same(png));
      expect(repository.assetReads.single.relativePath, 'shared/a.png');
    });

    test(
      'maps image failures to short reasons and does not cache them',
      () async {
        const path = 'reports/can-5130/a.png';
        final vm = viewModel();
        final cases = {
          RemoteFileFailure.notFound: MessageImageFailure.notFound,
          RemoteFileFailure.outsideRoot: MessageImageFailure.notFound,
          RemoteFileFailure.tooLarge: MessageImageFailure.unsupported,
          RemoteFileFailure.binaryFile: MessageImageFailure.unsupported,
          RemoteFileFailure.timeout: MessageImageFailure.unavailable,
          RemoteFileFailure.permissionDenied: MessageImageFailure.unavailable,
        };
        for (final MapEntry(key: failure, value: reason) in cases.entries) {
          repository.assetErrors[path] = RemoteFileException(failure, 'raw');
          await expectLater(
            vm.readImage('a.png'),
            _imageFailure(reason),
            reason: '$failure',
          );
        }
        repository.assetErrors.clear();
        repository.assets[path] = png;
        expect(await vm.readImage('a.png'), same(png));
        expect(repository.assetReads, hasLength(cases.length + 1));
      },
    );

    test('degrades to text once the desktop lacks image reads', () async {
      repository.assetErrors['reports/can-5130/a.png'] =
          remoteFileUnsupportedDesktop;
      final vm = viewModel();
      var notified = 0;
      vm.addListener(() => notified++);
      await expectLater(
        vm.readImage('a.png'),
        _imageFailure(MessageImageFailure.unsupported),
      );
      expect(vm.imagesUnavailable, isTrue);
      expect(notified, 1);
      await expectLater(
        vm.readImage('b.png'),
        _imageFailure(MessageImageFailure.unsupported),
      );
      expect(repository.assetReads, hasLength(1));
    });

    test('shares one pending read and reuses cached bytes', () async {
      repository.holdAssets = true;
      final vm = viewModel();
      final first = vm.readImage('a.png');
      final second = vm.readImage('./a.png');
      expect(repository.assetReads, hasLength(1));
      repository.releaseAsset('reports/can-5130/a.png', png);
      expect(await first, same(png));
      expect(await second, same(png));
      expect(await vm.readImage('a.png'), same(png));
      expect(repository.assetReads, hasLength(1));
      expect(vm.retainedImageBytes, 100);
    });

    test(
      'evicts the least recently used image within the byte budget',
      () async {
        Uint8List bytes(int length) => Uint8List(length);
        repository.assets
          ..['reports/can-5130/a.png'] = bytes(400)
          ..['reports/can-5130/b.png'] = bytes(400)
          ..['reports/can-5130/c.png'] = bytes(400)
          ..['reports/can-5130/huge.png'] = bytes(2000);
        final vm = viewModel(imageCacheBytes: 1000);
        await vm.readImage('a.png');
        await vm.readImage('b.png');
        await vm.readImage('a.png');
        await vm.readImage('c.png');
        expect(vm.retainedImageBytes, 800);
        expect(repository.assetReads, hasLength(3));
        await vm.readImage('a.png');
        expect(repository.assetReads, hasLength(3));
        await vm.readImage('b.png');
        expect(repository.assetReads, hasLength(4));
        await vm.readImage('huge.png');
        expect(vm.retainedImageBytes, 800);
      },
    );
  });

  group('session end and disposal', () {
    test('clears content and discards late reads', () async {
      repository.files[remoteFileFixturePath] = _text;
      repository.holdAssets = true;
      final vm = viewModel();
      await vm.load();
      final image = vm.readImage('a.png');
      vm.endSession();
      expect(vm.problem, RemoteFileProblem.sessionEnded);
      expect(vm.contents, isNull);
      repository.releaseAsset(
        'reports/can-5130/a.png',
        Uint8List.fromList([1, 2, 3]),
      );
      await expectLater(image, _imageFailure(MessageImageFailure.unavailable));
      expect(vm.retainedImageBytes, 0);
      await expectLater(
        vm.readImage('b.png'),
        _imageFailure(MessageImageFailure.unavailable),
      );
      await vm.load();
      expect(vm.problem, RemoteFileProblem.sessionEnded);
      expect(repository.fileReads, hasLength(1));
      expect(repository.assetReads, hasLength(1));
    });

    test('ignores a file read that answers after the session ended', () async {
      repository.holdFiles = true;
      final vm = viewModel();
      final load = vm.load();
      vm.endSession();
      repository.heldFiles[remoteFileFixturePath]!.single.complete(_text);
      await load;
      expect(vm.contents, isNull);
      expect(vm.problem, RemoteFileProblem.sessionEnded);
    });

    test('does not notify after disposal', () async {
      repository.holdFiles = true;
      repository.holdAssets = true;
      final vm = RemoteFileViewModel(
        repository: repository,
        request: remoteFileFixtureRequest,
        desktopOnline: true,
      );
      final load = vm.load();
      final image = vm.readImage('a.png');
      vm.dispose();
      repository.heldFiles[remoteFileFixturePath]!.single.complete(_text);
      repository.releaseAsset('reports/can-5130/a.png', Uint8List(4));
      await load;
      await expectLater(image, _imageFailure(MessageImageFailure.unavailable));
    });
  });

  // Seeded lifecycle pass: random reads, completions, failures and session
  // ends checked after every step against an independent LRU model.
  group('seeded image cache lifecycle', () {
    const budget = 700;
    const sizes = {'a': 100, 'b': 200, 'c': 300, 'd': 400, 'e': 800};

    for (final seed in [1, 7, 42, 5130, 90210]) {
      test('seed $seed keeps reads, bounds and staleness consistent', () async {
        final random = Random(seed);
        repository.holdAssets = true;
        var vm = viewModel(imageCacheBytes: budget);
        // Model: retained names, least recently used first, and pending reads.
        final retained = <String>[];
        final pending = <String>{};
        final staleResults = <Future<Uint8List>>[];
        var expectedReads = 0;
        String path(String name) => 'reports/can-5130/$name.png';

        for (var step = 0; step < 200; step++) {
          final name = sizes.keys.elementAt(random.nextInt(sizes.length));
          final op = random.nextInt(10);
          final trace = 'seed $seed step $step op $op $name';
          if (op < 5) {
            final result = vm.readImage('$name.png');
            if (retained.remove(name)) {
              retained.add(name);
              expect(await result, hasLength(sizes[name]), reason: trace);
            } else {
              if (pending.add(name)) expectedReads++;
              unawaited(result.then((_) {}, onError: (_) {}));
            }
          } else if (op < 8) {
            if (pending.remove(name)) {
              repository.releaseAsset(path(name), Uint8List(sizes[name]!));
              await pumpEventQueue();
              if (sizes[name]! <= budget) {
                retained.add(name);
                var total = retained.fold(0, (sum, n) => sum + sizes[n]!);
                while (total > budget) {
                  total -= sizes[retained.removeAt(0)]!;
                }
              }
            }
          } else if (op < 9) {
            if (pending.remove(name)) {
              repository.failAsset(
                path(name),
                const RemoteFileException(RemoteFileFailure.timeout, 'raw'),
              );
              await pumpEventQueue();
            }
          } else {
            // Reopen after a session change: the old screen's pending reads
            // must neither land in the new cache nor resolve with bytes.
            staleResults.addAll([
              for (final name in pending) vm.readImage('$name.png'),
            ]);
            vm.endSession();
            for (final name in pending) {
              repository.releaseAsset(path(name), Uint8List(sizes[name]!));
            }
            pending.clear();
            retained.clear();
            vm = viewModel(imageCacheBytes: budget);
            await pumpEventQueue();
          }
          expect(
            vm.retainedImageBytes,
            lessThanOrEqualTo(budget),
            reason: trace,
          );
          expect(
            vm.retainedImageBytes,
            retained.fold(0, (sum, n) => sum + sizes[n]!),
            reason: trace,
          );
          expect(
            repository.assetReads,
            hasLength(expectedReads),
            reason: trace,
          );
        }
        for (final stale in staleResults) {
          await expectLater(
            stale,
            _imageFailure(MessageImageFailure.unavailable),
          );
        }
      });
    }
  });
}
