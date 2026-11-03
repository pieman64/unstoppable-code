// CAN-5130 device verification: the worktree file viewer opens a synthetic
// Markdown report with images in table cells, reads those images from the
// report's folder and nothing else, switches between Formatted and Source
// without reading again, zooms and pans an image, and returns to the same
// document position. A session change closes an open image and clears the
// file; a screen reader opens the same image view. Closing the viewer or a
// session change releases its decoded images. A desktop without image reads
// keeps text and alt text. Run from
// apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_5130_file_viewer_device_test.dart \
//     --dart-define=CAN5130_THEME=dark -d <device-id>
//
// Add --dart-define=CAN5130_REDUCED_MOTION=true to run with animations
// disabled. The production viewer, view models and theme run on synthetic
// fixtures (test/support/remote_file_viewer_fixture.dart) reached from a
// test-only launcher: no desktop, account or network.

import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_image_screen.dart';

import '../test/support/remote_file_viewer_fixture.dart';

const _theme = String.fromEnvironment('CAN5130_THEME', defaultValue: 'light');
const _reducedMotion = bool.fromEnvironment('CAN5130_REDUCED_MOTION');

const _sessionEnded = 'The remote session ended. Go back and reconnect.';
const _oldDesktop = 'Update your desktop app to show images.';

/// Makes the report taller than a phone screen, so position is observable.
final _moreNotes = [
  for (var i = 1; i <= 30; i++) '- Synthetic note $i.\n',
].join();

const _imageColors = [
  ui.Color(0xFFB0BEC5),
  ui.Color(0xFF26A69A),
  ui.Color(0xFF455A64),
  ui.Color(0xFF5C6BC0),
  ui.Color(0xFFFFB300),
];

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  if (!const {'light', 'dark'}.contains(_theme)) {
    throw ArgumentError.value(_theme, 'CAN5130_THEME');
  }
  if (_reducedMotion) {
    binding.platformDispatcher.accessibilityFeaturesTestValue =
        const FakeAccessibilityFeatures(disableAnimations: true);
  }

  // Real-time frames: image skeletons pulse while reads and decoding run.
  Future<void> hold(WidgetTester tester, [int milliseconds = 800]) async {
    final end = DateTime.now().add(Duration(milliseconds: milliseconds));
    while (DateTime.now().isBefore(end)) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  Future<(RemoteFileViewerRepository, RemoteControlViewModel)> open(
    WidgetTester tester, {
    bool connect = true,
    void Function(RemoteFileViewerRepository)? configure,
  }) async {
    final repository = RemoteFileViewerRepository();
    repository.files[remoteFileFixturePath] = RemoteFileContents(
      contents: '$remoteFileFixtureReport$_moreNotes',
      truncated: false,
      unsupported: false,
    );
    for (final (index, path) in remoteFileFixtureImagePaths.indexed) {
      repository.assets[path] = await remoteFileFixturePng(_imageColors[index]);
    }
    configure?.call(repository);
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    if (connect) await viewModel.connect('123456');
    await tester.pumpWidget(
      remoteFileViewerHost(
        viewModel,
        theme: _theme == 'dark' ? AppTheme.dark : AppTheme.light,
      ),
    );
    await hold(tester, 300);
    await tester.tap(find.text('Open file'));
    await hold(tester, 1500);
    return (repository, viewModel);
  }

  Future<void> finish(
    WidgetTester tester,
    RemoteControlViewModel viewModel,
  ) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await hold(tester, 200);
    viewModel.dispose();
  }

  void expectImagesReleased(RemoteFileViewerRepository repository) {
    for (final MapEntry(key: path, value: bytes) in repository.assets.entries) {
      expect(
        imageCache.statusForKey(MemoryImage(bytes)).tracked,
        isFalse,
        reason: path,
      );
    }
  }

  Finder image(String label) => find.byWidgetPredicate(
    (widget) => widget is Image && widget.semanticLabel == label,
  );

  testWidgets('opens the report with table images, switches modes, zooms '
      'and returns to the same position', (tester) async {
    final (repository, viewModel) = await open(tester);

    expect(find.text('report.md'), findsOneWidget);
    expect(find.text('reports / can-5130'), findsOneWidget);
    for (final label in [
      'Before light',
      'After light',
      'Before dark',
      'After dark',
    ]) {
      expect(image(label), findsOneWidget, reason: label);
      // Table cells fit their thumbnails.
      final size = tester.getSize(image(label));
      expect(size.width, lessThanOrEqualTo(96), reason: label);
      expect(size.height, lessThanOrEqualTo(96), reason: label);
    }
    expect(
      repository.assetReads.map((read) => read.relativePath).toSet(),
      remoteFileFixtureImagePaths.toSet(),
    );
    expect(repository.assetReads, hasLength(5));
    expect(
      find.text('Remote · Unsupported image', findRichText: true),
      findsOneWidget,
    );

    await tester.tap(find.text('Source'));
    await hold(tester);
    expect(find.text('| State | Before | After |'), findsOneWidget);
    await tester.tap(find.text('Formatted'));
    await hold(tester);
    expect(image('After dark'), findsOneWidget);
    expect(repository.fileReads, hasLength(1));
    expect(repository.assetReads, hasLength(5));

    final scrollable = tester.state<ScrollableState>(
      find
          .ancestor(
            of: find.byKey(const ValueKey('remote-file-formatted')),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    // Scroll a little, keeping the Overview image clear of the app bar.
    await tester.drag(
      find.text('Notes', findRichText: true),
      const Offset(0, -120),
    );
    await hold(tester);
    final offset = scrollable.position.pixels;
    expect(offset, greaterThan(0));

    await tester.tap(image('Overview'));
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    final zoomed = find.descendant(
      of: find.byType(InteractiveViewer),
      matching: find.byType(Image),
    );
    final before = tester.getRect(zoomed);
    final center = before.center;
    final first = await tester.startGesture(center - const Offset(20, 0));
    final second = await tester.startGesture(center + const Offset(20, 0));
    for (var step = 1; step <= 10; step++) {
      await first.moveTo(center - Offset(20.0 + step * 10, 0));
      await second.moveTo(center + Offset(20.0 + step * 10, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await first.up();
    await second.up();
    await hold(tester);
    final pinched = tester.getRect(zoomed);
    expect(pinched.width, greaterThan(before.width * 1.5));
    final pan = await tester.startGesture(center);
    for (var step = 0; step < 6; step++) {
      await pan.moveBy(const Offset(10, 0));
      await tester.pump(const Duration(milliseconds: 16));
    }
    await pan.up();
    await hold(tester);
    expect(tester.getRect(zoomed).left, isNot(pinched.left));

    await tester.tap(find.byTooltip('Close image'));
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(scrollable.position.pixels, offset);

    await tester.tap(image('Overview'));
    await hold(tester);
    await binding.handlePopRoute();
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(scrollable.position.pixels, offset);
    expect(repository.assetReads, hasLength(5));

    await binding.handlePopRoute();
    await hold(tester);
    expect(find.text('Open file'), findsOneWidget);
    expectImagesReleased(repository);
    await finish(tester, viewModel);
  });

  testWidgets('a session change closes an open image and clears the file', (
    tester,
  ) async {
    final (repository, viewModel) = await open(tester);
    await tester.tap(image('After light'));
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsOneWidget);

    await viewModel.disconnect();
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(find.text(_sessionEnded), findsOneWidget);
    expect(find.byType(Image), findsNothing);
    expect(repository.assetReads, hasLength(5));
    expectImagesReleased(repository);
    await finish(tester, viewModel);
  });

  testWidgets('a screen reader opens an image that back and a session change '
      'close', (tester) async {
    final semantics = tester.ensureSemantics();
    final (repository, viewModel) = await open(tester);
    final button = find.semantics.byLabel('Open After light');

    tester.semantics.tap(button);
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    await binding.handlePopRoute();
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(find.text('report.md'), findsOneWidget);

    tester.semantics.tap(button);
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsOneWidget);
    await viewModel.disconnect();
    await hold(tester);
    expect(find.byType(RemoteImageScreen), findsNothing);
    expect(find.text(_sessionEnded), findsOneWidget);
    expect(repository.assetReads, hasLength(5));
    semantics.dispose();
    await finish(tester, viewModel);
  });

  testWidgets('a desktop without image reads keeps text and alt text', (
    tester,
  ) async {
    final (repository, viewModel) = await open(
      tester,
      configure: (repository) {
        for (final path in remoteFileFixtureImagePaths) {
          repository.assetErrors[path] = remoteFileUnsupportedDesktop;
        }
      },
    );
    expect(find.text(_oldDesktop), findsOneWidget);
    expect(find.text('Mobile capture report', findRichText: true), findsOne);
    expect(find.textContaining('After dark', findRichText: true), findsOne);
    expect(find.byType(Image), findsNothing);
    await finish(tester, viewModel);
  });
}
