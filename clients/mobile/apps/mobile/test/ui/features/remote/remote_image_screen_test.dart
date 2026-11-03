// CAN-5130: the full-screen image route shows bytes the viewer already
// loaded. Zoom, pan and return to the document are covered with the file
// screen in remote_file_screen_test.dart.
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/views/remote_image_screen.dart';

import '../../../support/remote_file_viewer_fixture.dart';

void main() {
  late Uint8List png;

  setUpAll(() async => png = await remoteFileFixturePng(Colors.orange));

  Future<void> pump(
    WidgetTester tester,
    Uint8List bytes,
    ThemeData theme,
  ) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: RemoteImageScreen(bytes: bytes, label: 'after-dark.png'),
      ),
    );
    await tester.runAsync(
      () => precacheImage(
        MemoryImage(bytes),
        tester.element(find.byType(RemoteImageScreen)),
      ),
    );
    await tester.pumpAndSettle();
  }

  for (final (name, theme) in [
    ('light', AppTheme.light),
    ('dark', AppTheme.dark),
  ]) {
    testWidgets('fits the image at phone width in $name theme', (tester) async {
      await pump(tester, png, theme);
      expect(find.text('after-dark.png'), findsOneWidget);
      expect(
        tester.widget<Image>(find.byType(Image)).semanticLabel,
        'after-dark.png',
      );
      final viewer = tester.getRect(find.byType(InteractiveViewer));
      expect(viewer.width, 390);
      final image = tester.getRect(find.byType(Image));
      expect(viewer.contains(image.center), isTrue);
      final close = find.ancestor(
        of: find.byTooltip('Close image'),
        matching: find.byType(IconButton),
      );
      expect(tester.getSize(close.first).height, greaterThanOrEqualTo(44));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('undecodable bytes show a reason instead of an image', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: RemoteImageScreen(
          bytes: Uint8List.fromList([1, 2, 3]),
          label: 'broken.png',
        ),
      ),
    );
    await tester.runAsync(() async => tester.pump());
    await tester.pumpAndSettle();
    expect(find.text("Couldn't show this image."), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
