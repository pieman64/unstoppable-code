import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';

/// The floating app bar blurs the content scrolling underneath it. Every
/// [BackdropFilter] is a full framebuffer readback plus several blur passes
/// on the raster thread, so the chrome must pay for at most ONE of them per
/// frame. (Eight stacked bands halved scroll frame rate on device.)
void main() {
  Future<void> pumpBar(WidgetTester tester) => tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light,
      home: CanopyScaffold(
        appBar: const CanopyAppBar(content: Text('Title')),
        body: Builder(
          builder: (context) => ListView(
            padding: CanopyScaffold.contentPaddingOf(context),
            children: [
              for (var i = 0; i < 30; i++)
                SizedBox(height: 80, child: Text('Row $i')),
            ],
          ),
        ),
      ),
    ),
  );

  testWidgets('uses a single backdrop filter for the blurred chrome', (
    tester,
  ) async {
    await pumpBar(tester);
    expect(find.byType(BackdropFilter), findsOneWidget);
  });

  testWidgets(
    'the one backdrop filter is a plain blur at the configured sigma',
    (tester) async {
      await pumpBar(tester);
      final filter = tester.widget<BackdropFilter>(find.byType(BackdropFilter));
      // A plain ImageFilter.blur on every backend, never a fragment shader: a
      // shader had to reconstruct the backdrop's orientation itself, and getting
      // that wrong per-backend painted a mirrored copy of the bottom of the
      // screen into the bar (the `#ifdef IMPELLER_TARGET_OPENGLES` y-flip).
      expect(filter.filter, ImageFilter.blur(sigmaX: 1.5, sigmaY: 1.5));
    },
  );

  testWidgets('scrim holds 95 percent through half the bar then fades', (
    tester,
  ) async {
    await pumpBar(tester);
    final decoratedBox = tester.widget<DecoratedBox>(
      find
          .byWidgetPredicate(
            (widget) =>
                widget is DecoratedBox &&
                widget.decoration is BoxDecoration &&
                (widget.decoration as BoxDecoration).gradient != null,
          )
          .first,
    );
    final gradient =
        (decoratedBox.decoration as BoxDecoration).gradient! as LinearGradient;
    expect(gradient.colors, hasLength(3));
    expect(gradient.colors.first.a, closeTo(0.95, 0.001));
    expect(gradient.colors[1].a, closeTo(0.95, 0.001));
    expect(gradient.colors.last.a, 0);
    expect(gradient.stops, [0, 0.5, 1]);
    expect(gradient.begin, Alignment.topCenter);
    expect(gradient.end, Alignment.bottomCenter);
  });

  testWidgets('a grown toolbar holds the scrim through it and fades in a '
      'band below, leaving default bars unchanged', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(top: 47);
    addTearDown(tester.view.reset);
    Future<LinearGradient> pump(CanopyAppBar bar) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light,
          home: CanopyScaffold(appBar: bar, body: const SizedBox.expand()),
        ),
      );
      final box = tester.widget<DecoratedBox>(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is DecoratedBox &&
                widget.decoration is BoxDecoration &&
                (widget.decoration as BoxDecoration).gradient != null,
          ),
        ),
      );
      return (box.decoration as BoxDecoration).gradient! as LinearGradient;
    }

    final standard = await pump(const CanopyAppBar(content: Text('Title')));
    expect(tester.getSize(find.byType(CanopyAppBar)).height, 47 + 56);
    expect(standard.stops, [0, 0.5, 1]);

    final grown = await pump(
      const CanopyAppBar(content: Text('Title'), toolbarHeight: 120),
    );
    const height = 47 + 120 + CanopyAppBar.grownFadeExtent;
    expect(tester.getSize(find.byType(CanopyAppBar)).height, height);
    expect(grown.stops, [0, (47 + 120) / height, 1]);
    expect(grown.colors[1].a, closeTo(CanopyAppBar.maxScrimAlpha, 0.001));
    expect(grown.colors.last.a, 0);
  });

  testWidgets('blurSigma 0 renders no backdrop filter at all', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light,
        home: const CanopyScaffold(
          appBar: CanopyAppBar(content: Text('Title'), blurSigma: 0),
          body: SizedBox.expand(),
        ),
      ),
    );
    expect(find.byType(BackdropFilter), findsNothing);
  });
}
