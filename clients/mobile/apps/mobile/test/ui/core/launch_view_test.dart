import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart';
import 'package:mobile/ui/core/launch_view.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

void main() {
  group('LaunchView', () {
    testWidgets('draws the splash mark centered at the native splash size', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(theme: AppTheme.dark, home: const LaunchView()),
      );

      final mark = find.byKey(LaunchView.markKey);
      expect(mark, findsOneWidget);
      final image = tester.widget<Image>(mark);
      expect(image.image, const AssetImage(LaunchView.markAsset));
      expect(
        tester.getSize(mark),
        const Size(LaunchView.markSize, LaunchView.markSize),
      );
      final screen = tester.getSize(find.byType(LaunchView));
      expect(tester.getCenter(mark), screen.center(Offset.zero));
      expect(
        tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor ??
            AppTheme.dark.scaffoldBackgroundColor,
        Brand.dark.background,
      );
    });

    testWidgets('shows a spinner only once startup is slow', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: LaunchView()));
      expect(find.byType(LoadingSpinner), findsNothing);

      await tester.pump(
        LaunchView.spinnerDelay - const Duration(milliseconds: 1),
      );
      expect(find.byType(LoadingSpinner), findsNothing);

      await tester.pump(const Duration(milliseconds: 1));
      expect(find.byType(LoadingSpinner), findsOneWidget);
      // The spinner sits below the mark so the mark never moves.
      expect(
        tester.getCenter(find.byType(LoadingSpinner)).dy,
        greaterThan(tester.getBottomLeft(find.byKey(LaunchView.markKey)).dy),
      );
    });

    testWidgets('precache resolves the mark before the first frame', (
      tester,
    ) async {
      await tester.runAsync(LaunchView.precacheMark);
      await tester.pumpWidget(const MaterialApp(home: LaunchView()));
      final element = tester.element(find.byKey(LaunchView.markKey));
      final rawImage = find.descendant(
        of: find.byElementPredicate((e) => e == element),
        matching: find.byType(RawImage),
      );
      expect(tester.widget<RawImage>(rawImage).image, isNotNull);
    });
  });

  testWidgets('AuthGate shows the launch view while the session is unknown', (
    tester,
  ) async {
    final auth = AuthViewModel(repository: MockAuthRepository());
    addTearDown(auth.dispose);
    expect(auth.status, AuthStatus.unknown);

    await tester.pumpWidget(
      ChangeNotifierProvider.value(
        value: auth,
        child: const MaterialApp(home: AuthGate()),
      ),
    );

    expect(find.byType(LaunchView), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  group('native splash configuration', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final splash = pubspec.substring(
      pubspec.indexOf('\nflutter_native_splash:'),
    );

    String hex(Color color) =>
        '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}';

    test('backgrounds match the app background in both modes', () {
      final light = RegExp(
        r"^\s+color: '(#[0-9A-F]{6})'",
        multiLine: true,
      ).allMatches(splash).map((m) => m.group(1)).toSet();
      final dark = RegExp(
        r"^\s+color_dark: '(#[0-9A-F]{6})'",
        multiLine: true,
      ).allMatches(splash).map((m) => m.group(1)).toSet();
      expect(light, {hex(Brand.light.background)});
      expect(dark, {hex(Brand.dark.background)});
    });

    test('pre-Android 12 and iOS draw the same mark as LaunchView', () {
      final images = RegExp(
        r'^  image(?:_dark)?: (\S+)$',
        multiLine: true,
      ).allMatches(splash).map((m) => m.group(1)).toSet();
      expect(images, {LaunchView.markAsset});
      // flutter_native_splash treats its source as 4x density.
      final size = _pngSize(File(LaunchView.markAsset).readAsBytesSync());
      expect(
        size,
        const Size(LaunchView.markSize * 4, LaunchView.markSize * 4),
      );
    });

    test(
      'Android 12 icon keeps the whole mark inside the 192dp mask circle',
      () async {
        final path = RegExp(
          r'^    image: (\S+)$',
          multiLine: true,
        ).firstMatch(splash)?.group(1);
        expect(path, isNotNull);
        final codec = await ui.instantiateImageCodec(
          File(path ?? '').readAsBytesSync(),
        );
        final image = (await codec.getNextFrame()).image;
        // A 288dp icon canvas at the 4x density flutter_native_splash expects.
        expect(image.width, 288 * 4);
        expect(image.height, 288 * 4);
        final bytes = await image.toByteData();
        expect(bytes, isNotNull);
        final rgba = bytes ?? ByteData(0);
        final center = image.width / 2;
        var maxRadius = 0.0;
        var minX = image.width, maxX = 0;
        for (var y = 0; y < image.height; y++) {
          for (var x = 0; x < image.width; x++) {
            if (rgba.getUint8((y * image.width + x) * 4 + 3) == 0) continue;
            maxRadius = math.max(
              maxRadius,
              math.sqrt(
                math.pow(x + 0.5 - center, 2) + math.pow(y + 0.5 - center, 2),
              ),
            );
            minX = math.min(minX, x);
            maxX = math.max(maxX, x);
          }
        }
        expect(maxRadius, lessThanOrEqualTo(192 * 4 / 2));
        // Same on-screen tile width as the splash image used everywhere else.
        final markWidth = await _opaqueWidth(
          await _decode(File(LaunchView.markAsset).readAsBytesSync()),
        );
        expect(maxX - minX + 1, markWidth);
      },
    );
  });
}

Size _pngSize(List<int> bytes) {
  int be32(int offset) =>
      (bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3];
  return Size(be32(16).toDouble(), be32(20).toDouble());
}

Future<ui.Image> _decode(List<int> bytes) async {
  final codec = await ui.instantiateImageCodec(
    bytes is Uint8List ? bytes : Uint8List.fromList(bytes),
  );
  return (await codec.getNextFrame()).image;
}

Future<int> _opaqueWidth(ui.Image image) async {
  final rgba = await image.toByteData() ?? ByteData(0);
  var minX = image.width, maxX = 0;
  for (var y = 0; y < image.height; y++) {
    for (var x = 0; x < image.width; x++) {
      if (rgba.getUint8((y * image.width + x) * 4 + 3) == 0) continue;
      minX = math.min(minX, x);
      maxX = math.max(maxX, x);
    }
  }
  return maxX - minX + 1;
}
