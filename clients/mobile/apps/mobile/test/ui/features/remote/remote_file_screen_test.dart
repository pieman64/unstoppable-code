// CAN-5130: the worktree file viewer at phone width. The repository fake
// records every read, so inert sources and cache reuse are asserted directly.
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/services/portal_file_client.dart'
    show remoteImageMaxBytes;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_file_screen.dart';
import 'package:mobile/ui/features/remote/views/remote_image_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../support/reduced_motion.dart';
import '../../../support/remote_file_viewer_fixture.dart';

RemoteFileContents _text(String contents, {bool truncated = false}) =>
    RemoteFileContents(
      contents: contents,
      truncated: truncated,
      unsupported: false,
    );

RemoteFileRequest _request(String path) => RemoteFileRequest(
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  fileRootLocalId: 'root-1',
  relativePath: path,
);

void main() {
  late Uint8List png;
  late RemoteFileViewerRepository repository;

  setUpAll(() async => png = await remoteFileFixturePng(Colors.teal));

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    repository = RemoteFileViewerRepository();
    repository.files[remoteFileFixturePath] = _text(remoteFileFixtureReport);
    for (final path in remoteFileFixtureImagePaths) {
      repository.assets[path] = png;
    }
  });

  Future<RemoteControlViewModel> open(
    WidgetTester tester, {
    RemoteFileRequest request = remoteFileFixtureRequest,
    bool connect = true,
    ThemeData? theme,
    bool settle = true,
    int imageCacheBytes = remoteImageMaxBytes,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    final vm = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    if (connect) await tester.runAsync(() => vm.connect('123456'));
    await tester.pumpWidget(
      remoteFileViewerHost(
        vm,
        theme: theme ?? AppTheme.light,
        request: request,
        imageCacheBytes: imageCacheBytes,
      ),
    );
    await tester.tap(find.text('Open file'));
    if (settle) await settleImages(tester);
    return vm;
  }

  testWidgets('opens Markdown formatted with a breadcrumb and table images', (
    tester,
  ) async {
    await open(tester);

    expect(find.text('report.md'), findsOneWidget);
    expect(find.text('reports / can-5130'), findsOneWidget);
    final mode = tester.widget<SegmentedButton<Object?>>(
      find.byKey(const ValueKey('remote-file-mode')),
    );
    expect(mode.selected.single.toString(), 'RemoteFileMode.formatted');
    expect(find.byKey(const ValueKey('remote-file-formatted')), findsOneWidget);
    for (final label in [
      'Before light',
      'After light',
      'Before dark',
      'After dark',
      'Overview',
    ]) {
      expect(
        find.byWidgetPredicate(
          (widget) => widget is Image && widget.semanticLabel == label,
        ),
        findsOneWidget,
        reason: label,
      );
    }
    expect(find.bySemanticsLabel('Open Before light'), findsOneWidget);
    expect(
      repository.assetReads.map((read) => read.relativePath).toSet(),
      remoteFileFixtureImagePaths.toSet(),
    );
    expect(repository.assetReads, hasLength(5));
    expect(
      repository.assetReads.every(
        (read) =>
            read.projectId == 'ws-1' &&
            read.worktreeId == 'wt-1' &&
            read.fileRootLocalId == 'root-1',
      ),
      isTrue,
    );
    expect(
      find.text('Remote · Unsupported image', findRichText: true),
      findsOneWidget,
    );
    expect(
      find.text('Escape · Unsupported image', findRichText: true),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('Source shows the literal text without another read', (
    tester,
  ) async {
    await open(tester);
    await tester.tap(find.text('Source'));
    await tester.pumpAndSettle();

    expect(find.text('| State | Before | After |'), findsOneWidget);
    expect(find.text('![Overview](../overview.png)'), findsOneWidget);
    expect(find.byKey(const ValueKey('remote-file-formatted')), findsNothing);
    expect(repository.fileReads, hasLength(1));

    await tester.tap(find.text('Formatted'));
    await settleImages(tester);
    expect(find.bySemanticsLabel('Open After light'), findsOneWidget);
    // Cached bytes serve the remounted images.
    expect(repository.fileReads, hasLength(1));
    expect(repository.assetReads, hasLength(5));

    // Remounted images still open.
    await tester.tap(
      find.byWidgetPredicate(
        (widget) => widget is Image && widget.semanticLabel == 'After light',
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('returning to Formatted keeps images on the first frame', (
    tester,
  ) async {
    await open(tester);
    Finder image(String label) => find.byWidgetPredicate(
      (widget) => widget is Image && widget.semanticLabel == label,
    );
    final overview = tester.getRect(image('Overview'));
    await tester.tap(find.text('Source'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Formatted'));
    // Device video showed empty image cells for a frame here (CAN-5130).
    await tester.pump();
    for (final label in ['Before light', 'After light', 'Overview']) {
      expect(image(label), findsOneWidget, reason: label);
    }
    expect(tester.getRect(image('Overview')), overview);
    expect(tester.takeException(), isNull);
  });

  testWidgets('other text opens as source only', (tester) async {
    repository.files['lib/main.dart'] = _text('void main() {}\n// done');
    await open(tester, request: _request('lib/main.dart'));

    expect(find.text('main.dart'), findsOneWidget);
    expect(find.text('lib'), findsOneWidget);
    expect(find.byKey(const ValueKey('remote-file-mode')), findsNothing);
    expect(find.text('void main() {}'), findsOneWidget);
    expect(find.text('// done'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('an image opens full screen, zooms, and closes to the same '
      'position without another read', (tester) async {
    final filler = List.generate(40, (i) => 'Paragraph $i.').join('\n\n');
    repository.files['docs/long.md'] = _text(
      '$filler\n\n![Diagram](./diagram.png)\n\nEnd.',
    );
    repository.assets['docs/diagram.png'] = png;
    await open(tester, request: _request('docs/long.md'));

    final list = find.byKey(const ValueKey('remote-file-formatted'));
    final diagram = find.descendant(of: list, matching: find.byType(Image));
    await tester.scrollUntilVisible(
      diagram,
      300,
      scrollable: find
          .ancestor(of: list, matching: find.byType(Scrollable))
          .first,
    );
    await settleImages(tester);
    final scrollable = tester.state<ScrollableState>(
      find.ancestor(of: list, matching: find.byType(Scrollable)).first,
    );
    final offset = scrollable.position.pixels;
    expect(offset, greaterThan(0));

    await tester.tap(diagram);
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);
    expect(find.text('diagram.png'), findsOneWidget);

    final image = find.descendant(
      of: find.byType(InteractiveViewer),
      matching: find.byType(Image),
    );
    final before = tester.getRect(image);
    final center = tester.getCenter(image);
    final first = await tester.startGesture(center - const Offset(20, 0));
    final second = await tester.startGesture(center + const Offset(20, 0));
    await first.moveTo(center - const Offset(120, 0));
    await second.moveTo(center + const Offset(120, 0));
    await first.up();
    await second.up();
    await tester.pumpAndSettle();
    expect(tester.getRect(image).width, greaterThan(before.width * 1.5));

    final zoomed = tester.getRect(image);
    final pan = await tester.startGesture(center);
    await pan.moveBy(const Offset(60, 0));
    await pan.up();
    await tester.pumpAndSettle();
    expect(tester.getRect(image).left, isNot(zoomed.left));

    await tester.tap(find.byTooltip('Close image'));
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(scrollable.position.pixels, offset);

    await tester.tap(diagram);
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(find.text('long.md'), findsOneWidget);
    expect(scrollable.position.pixels, offset);

    await tester.tap(diagram);
    await tester.pumpAndSettle();
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    expect(repository.assetReads, hasLength(1));
    expect(tester.takeException(), isNull);
  });

  group('states', () {
    testWidgets('reserves space, then shows a skeleton while loading', (
      tester,
    ) async {
      repository.holdFiles = true;
      await open(tester, settle: false);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('remote-file-loading')), findsOneWidget);
      expect(find.text('report.md'), findsOneWidget);

      repository.heldFiles[remoteFileFixturePath]!.single.complete(
        _text('Ready.'),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('remote-file-loading')), findsNothing);
      expect(find.text('Ready.', findRichText: true), findsOneWidget);
    });

    testWidgets('shows nothing for the first 200ms of a load', (tester) async {
      repository.holdFiles = true;
      await open(tester, settle: false);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      expect(find.byKey(const ValueKey('remote-file-loading')), findsNothing);
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byKey(const ValueKey('remote-file-loading')), findsOneWidget);
      repository.heldFiles[remoteFileFixturePath]!.single.complete(_text('x'));
      await tester.pumpAndSettle();
    });

    testWidgets('notes empty text', (tester) async {
      repository.files['empty.txt'] = _text('');
      await open(tester, request: _request('empty.txt'));
      expect(find.text('This file is empty.'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('notes truncated text', (tester) async {
      repository.files['big.md'] = _text('# Big', truncated: true);
      await open(tester, request: _request('big.md'));
      expect(
        find.text(
          'Showing the first 256 KiB. Open the file on your desktop to see '
          'the rest.',
        ),
        findsOneWidget,
      );
      expect(find.text('Big', findRichText: true), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    final problems = <String, (Object, String)>{
      'binary': (
        const RemoteFileException(RemoteFileFailure.binaryFile, 'raw'),
        "This file can't be shown as text.",
      ),
      'missing': (
        const RemoteFileException(RemoteFileFailure.notFound, 'raw'),
        "Couldn't find this file. It may have been moved or deleted.",
      ),
      'no permission': (
        const RemoteFileException(RemoteFileFailure.permissionDenied, 'raw'),
        "You don't have permission to open this file.",
      ),
      'outside the root': (
        const RemoteFileException(RemoteFileFailure.outsideRoot, 'raw'),
        "Couldn't open this file. Its path is outside this workspace.",
      ),
      'not connected': (
        remoteFileNotConnected,
        'Your desktop is offline. This file opens when it reconnects.',
      ),
    };
    for (final MapEntry(key: name, value: (error, message))
        in problems.entries) {
      testWidgets('explains a $name file without raw errors', (tester) async {
        repository.fileErrors[remoteFileFixturePath] = error;
        await open(tester);
        expect(find.text(message), findsOneWidget);
        expect(find.textContaining('raw'), findsNothing);
        expect(find.text('Try again'), findsNothing);
        expect(find.text('report.md'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('shows unsupported content as a problem', (tester) async {
      repository.files[remoteFileFixturePath] = const RemoteFileContents(
        contents: '',
        truncated: false,
        unsupported: true,
      );
      await open(tester);
      expect(find.text("This file can't be shown as text."), findsOneWidget);
    });

    testWidgets('rejects an unsafe path without reading', (tester) async {
      await open(tester, request: _request('../secret.md'));
      expect(
        find.text(
          "Couldn't open this file. Its path is outside this workspace.",
        ),
        findsOneWidget,
      );
      expect(repository.fileReads, isEmpty);
    });

    testWidgets('waits for an offline desktop without reading', (tester) async {
      await open(tester, connect: false);
      expect(
        find.text(
          'Your desktop is offline. This file opens when it reconnects.',
        ),
        findsOneWidget,
      );
      expect(repository.fileReads, isEmpty);
      expect(tester.takeException(), isNull);
    });

    for (final (failure, message) in [
      (
        RemoteFileFailure.timeout,
        'Opening this file took too long. Try again.',
      ),
      (RemoteFileFailure.unavailable, "Couldn't open this file. Try again."),
    ]) {
      testWidgets('retries after $failure', (tester) async {
        repository.fileErrors[remoteFileFixturePath] = RemoteFileException(
          failure,
          'raw',
        );
        await open(tester);
        expect(find.text(message), findsOneWidget);

        repository.fileErrors.clear();
        repository.holdFiles = true;
        await tester.tap(find.text('Try again'));
        await tester.pump();
        // The failure stays while the retry runs.
        expect(find.text(message), findsOneWidget);
        expect(find.text('Trying again…'), findsOneWidget);

        repository.heldFiles[remoteFileFixturePath]!.single.complete(
          _text('Recovered.'),
        );
        await settleImages(tester);
        expect(find.text(message), findsNothing);
        expect(find.text('Recovered.', findRichText: true), findsOneWidget);
        expect(repository.fileReads, hasLength(2));
      });
    }

    testWidgets('an old desktop keeps text and alt text with one notice', (
      tester,
    ) async {
      for (final path in remoteFileFixtureImagePaths) {
        repository.assetErrors[path] = remoteFileUnsupportedDesktop;
      }
      await open(tester);

      expect(
        find.text('Update your desktop app to show images.'),
        findsOneWidget,
      );
      expect(find.text('Mobile capture report', findRichText: true), findsOne);
      expect(find.textContaining('Before light', findRichText: true), findsOne);
      expect(find.byType(Image), findsNothing);
      final reads = repository.assetReads.length;

      await tester.tap(find.text('Source'));
      await tester.pumpAndSettle();
      expect(
        find.text('Update your desktop app to show images.'),
        findsNothing,
      );
      await tester.tap(find.text('Formatted'));
      await tester.pumpAndSettle();
      expect(repository.assetReads, hasLength(reads));
      expect(tester.takeException(), isNull);
    });
  });

  group('session changes', () {
    testWidgets('a disconnect clears the file and closes an open image', (
      tester,
    ) async {
      final vm = await open(tester);
      await tester.tap(find.bySemanticsLabel('Open After light'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget);

      await tester.runAsync(vm.disconnect);
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
      expect(find.byType(Image), findsNothing);
      expect(find.textContaining('Mobile capture'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a screen reader opens an image that back and a session '
        'change close', (tester) async {
      final semantics = tester.ensureSemantics();
      final vm = await open(tester);
      final button = find.semantics.byLabel('Open After light');

      tester.semantics.tap(button);
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget);
      expect(find.text('after-light.png'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsNothing);
      expect(find.text('report.md'), findsOneWidget);

      tester.semantics.tap(button);
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget);
      await tester.runAsync(vm.disconnect);
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen, skipOffstage: false), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
      expect(repository.assetReads, hasLength(5));
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });

    testWidgets('a repeated image tap opens one image that a session change '
        'closes', (tester) async {
      final vm = await open(tester);
      // Pointer input is blocked until the pushed route builds, so call the
      // tap callback directly to deliver both taps before that frame.
      final markdown = tester.widget<MessageMarkdown>(
        find.byType(MessageMarkdown),
      );
      markdown.onImageTap!('./after-light.png', png);
      markdown.onImageTap!('./after-light.png', png);
      await tester.pumpAndSettle();
      final zoom = find.byType(RemoteImageScreen, skipOffstage: false);
      expect(zoom, findsOneWidget);

      await tester.runAsync(vm.disconnect);
      await tester.pumpAndSettle();
      expect(zoom, findsNothing);
      expect(find.byType(Image, skipOffstage: false), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a late image read never appears after a session change', (
      tester,
    ) async {
      repository.holdAssets = true;
      final vm = await open(tester, settle: false);
      // Image skeletons pulse while their reads are held.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(repository.assetReads, hasLength(5));

      await tester.runAsync(vm.disconnect);
      for (final path in remoteFileFixtureImagePaths) {
        repository.releaseAsset(path, png);
      }
      await settleImages(tester);
      expect(find.byType(Image), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
    });
  });

  group('image cache ownership', () {
    // Flutter's image cache keys each Image.memory by its byte buffer, so
    // distinct buffers make every viewer image a distinct cache entry.
    late Map<String, Uint8List> images;
    late Uint8List unrelated;

    setUpAll(() async {
      images = {
        for (final (index, path) in remoteFileFixtureImagePaths.indexed)
          path: await remoteFileFixturePng(
            Colors.primaries[index * 3],
            width: 200 + index,
          ),
      };
      unrelated = await remoteFileFixturePng(Colors.black, width: 50);
    });

    setUp(() => repository.assets.addAll(images));

    bool cached(Uint8List bytes) =>
        imageCache.statusForKey(MemoryImage(bytes)).tracked;

    /// Caches an image this viewer never read, which must survive it.
    Future<void> cacheUnrelated(WidgetTester tester) async {
      await tester.runAsync(
        () => precacheImage(
          MemoryImage(unrelated),
          tester.element(find.byType(RemoteFileScreen)),
        ),
      );
      expect(cached(unrelated), isTrue);
    }

    void expectReleased() {
      for (final MapEntry(key: path, value: bytes) in images.entries) {
        expect(cached(bytes), isFalse, reason: path);
      }
      expect(cached(unrelated), isTrue);
    }

    testWidgets('closing the screen releases its images', (tester) async {
      await open(tester);
      await cacheUnrelated(tester);
      for (final MapEntry(key: path, value: bytes) in images.entries) {
        expect(cached(bytes), isTrue, reason: path);
      }
      await tester.tap(find.bySemanticsLabel('Open After light'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(RemoteFileScreen), findsNothing);
      expectReleased();
      expect(tester.takeException(), isNull);
    });

    testWidgets('a session change releases its images and the open zoom', (
      tester,
    ) async {
      final vm = await open(tester);
      await cacheUnrelated(tester);
      await tester.tap(find.bySemanticsLabel('Open Before dark'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget);

      await tester.runAsync(vm.disconnect);
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen, skipOffstage: false), findsNothing);
      expect(
        find.text('The remote session ended. Go back and reconnect.'),
        findsOneWidget,
      );
      expectReleased();
      expect(tester.takeException(), isNull);
    });

    // The table images, which fit the phone viewport without scrolling.
    const labels = ['Before light', 'After light', 'Before dark', 'After dark'];
    const sources = [
      './before-light.png',
      './after-light.png',
      './before-dark.png',
      'images/after-dark.png',
      '../overview.png',
    ];

    /// A budget for one image, so the view model keeps only the last read.
    int oneImage() => images.values.map((bytes) => bytes.length).reduce(max);

    /// Reads [source] through the screen's resolver, as a remount would.
    Future<void> readAgain(WidgetTester tester, String source) async {
      final markdown = tester.widget<MessageMarkdown>(
        find.byType(MessageMarkdown),
      );
      await tester.runAsync(() => markdown.imageResolver!(source));
    }

    Future<void> zoom(WidgetTester tester, String label) async {
      await tester.tap(find.bySemanticsLabel('Open $label'));
      await tester.pumpAndSettle();
      expect(find.byType(RemoteImageScreen), findsOneWidget, reason: label);
    }

    testWidgets('images the view model already evicted are released too', (
      tester,
    ) async {
      await open(tester, imageCacheBytes: oneImage());
      await cacheUnrelated(tester);
      // Only the last image fit, so the first one reads again.
      await readAgain(tester, './before-light.png');
      expect(repository.assetReads, hasLength(6));
      final afterDark = images['reports/can-5130/images/after-dark.png']!;
      expect(cached(afterDark), isTrue);

      await zoom(tester, 'After dark');
      await tester.tap(find.byTooltip('Close image'));
      await tester.pumpAndSettle();
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(RemoteFileScreen), findsNothing);
      expectReleased();
      expect(tester.takeException(), isNull);
    });

    for (final seed in [1, 2, 3, 4, 5, 6]) {
      testWidgets('seed $seed releases every image however the viewer ends', (
        tester,
      ) async {
        final random = Random(seed);
        final vm = await open(
          tester,
          imageCacheBytes: oneImage() * (random.nextBool() ? 1 : images.length),
        );
        await cacheUnrelated(tester);
        for (var step = 2 + random.nextInt(4); step > 0; step--) {
          switch (random.nextInt(3)) {
            case 0:
              await tester.tap(find.text('Source'));
              await tester.pumpAndSettle();
              await tester.tap(find.text('Formatted'));
              await settleImages(tester);
            case 1:
              await zoom(tester, labels[random.nextInt(labels.length)]);
              if (random.nextBool()) {
                await tester.tap(find.byTooltip('Close image'));
              } else {
                await tester.binding.handlePopRoute();
              }
              await tester.pumpAndSettle();
            default:
              await readAgain(tester, sources[random.nextInt(sources.length)]);
          }
        }
        final zoomed = random.nextBool();
        if (zoomed) await zoom(tester, labels[random.nextInt(labels.length)]);
        if (random.nextBool()) {
          await tester.runAsync(vm.disconnect);
          await tester.pumpAndSettle();
          expect(
            find.byType(RemoteImageScreen, skipOffstage: false),
            findsNothing,
          );
        } else {
          if (zoomed) await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();
          await tester.binding.handlePopRoute();
          await tester.pumpAndSettle();
          expect(find.byType(RemoteFileScreen), findsNothing);
        }
        expectReleased();
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('appearance', () {
    useReducedMotion();

    testWidgets('dark theme at phone width under reduced motion', (
      tester,
    ) async {
      repository.holdFiles = true;
      await open(tester, theme: AppTheme.dark, settle: false);
      // The skeleton holds still, so settling finishes while loading.
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('remote-file-loading')), findsOneWidget);

      repository.heldFiles[remoteFileFixturePath]!.single.complete(
        _text(remoteFileFixtureReport),
      );
      await settleImages(tester);
      expect(find.bySemanticsLabel('Open After dark'), findsOneWidget);
      expect(tester.getSize(find.byType(RemoteFileScreen)).width, 390);
      for (final control in [
        find.ancestor(
          of: find.byTooltip('Back'),
          matching: find.byType(IconButton),
        ),
        find.byKey(const ValueKey('remote-file-mode')),
      ]) {
        expect(tester.getSize(control.first).height, greaterThanOrEqualTo(44));
      }
      final semantics = tester.ensureSemantics();
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      semantics.dispose();
      expect(tester.takeException(), isNull);
    });
  });
}

/// Lets real image decoding finish, then settles the frames it triggers.
/// Image reads start a frame after the file loads, so decode in rounds.
Future<void> settleImages(WidgetTester tester) async {
  // Image skeletons pulse until decoding finishes, so settle only after it.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 500));
  for (var round = 0; round < 3; round++) {
    await tester.pump();
    await tester.runAsync(() async {
      for (final element in find.byType(Image).evaluate()) {
        final image = element.widget as Image;
        await precacheImage(image.image, element);
      }
    });
  }
  await tester.pumpAndSettle();
}
