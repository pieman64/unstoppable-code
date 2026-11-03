// Usage limits title geometry at the phone width, measured with the real Inter
// font. The default test font has different glyph widths, so truncation and
// clipping that users see only reproduce with the shipped font loaded.

import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/account/views/usage_limits_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/fake_provider_usage_source.dart';
import '../../../../support/provider_usage_fixture.dart';

const _title = 'Usage limits';
const _safeTop = 47.0;

/// Largest per-channel change, out of 255, that content scrolled under the
/// title and Back may cause there. The scrim's peak lets about 5% through.
const _maxBleed = 32;

Future<void> _loadInter() async {
  final bytes = ByteData.sublistView(
    await File('assets/fonts/inter/InterVariable.ttf').readAsBytes(),
  );
  await (FontLoader('Inter')..addFont(Future.value(bytes))).load();
}

void main() {
  setUpAll(_loadInter);

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    for (final scale in [1.0, 3.0]) {
      testWidgets('Usage limits title is whole and unclipped at 390 px, '
          'text scale $scale (${theme.brightness.name})', (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.view.padding = const FakeViewPadding(top: _safeTop, bottom: 34);
        tester.view.viewPadding = const FakeViewPadding(
          top: _safeTop,
          bottom: 34,
        );
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final source = FakeProviderUsageSource(
          isAvailable: true,
          projection: PortalProviderUsageProjection.fromJson(
            providerUsagePayload(),
          ),
        );
        final navigator = GlobalKey<NavigatorState>();
        await tester.pumpWidget(
          ListenableProvider<ProviderUsageSource>.value(
            value: source,
            child: MaterialApp(
              navigatorKey: navigator,
              theme: theme,
              home: const SizedBox.shrink(),
            ),
          ),
        );
        navigator.currentState!.push(
          MaterialPageRoute<void>(
            builder: (_) => UsageLimitsScreen(clock: () => usageFixtureNow),
          ),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);

        final bar = tester.getRect(find.byType(CanopyAppBar));
        final title = find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.text(_title),
        );
        final paragraph = tester.renderObject<RenderParagraph>(title);
        expect(
          paragraph.didExceedMaxLines,
          isFalse,
          reason: 'the title is ellipsized',
        );
        final origin = paragraph.localToGlobal(Offset.zero);
        final glyphs = paragraph.getBoxesForSelection(
          const TextSelection(baseOffset: 0, extentOffset: _title.length),
        );
        expect(glyphs, isNotEmpty);
        // The padded touch target, not the smaller visual button.
        final back = tester.getRect(
          find.ancestor(
            of: find.byTooltip('Back'),
            matching: find.byType(IconButton),
          ),
        );
        for (final box in glyphs) {
          final glyph = box.toRect().shift(origin);
          // The bar's Stack clips its children to the bar's bounds.
          expect(glyph.top, greaterThanOrEqualTo(_safeTop));
          expect(glyph.bottom, lessThanOrEqualTo(bar.bottom));
          expect(glyph.left, greaterThanOrEqualTo(back.right));
          expect(glyph.right, lessThanOrEqualTo(bar.width - back.left));
        }

        expect(back.width, greaterThanOrEqualTo(44));
        expect(back.height, greaterThanOrEqualTo(44));
        expect(back.top, greaterThanOrEqualTo(_safeTop));
        expect(back.bottom, lessThanOrEqualTo(bar.bottom));

        final firstSection = tester.getRect(
          find.byKey(const ValueKey('usage-limits-section-claude')),
        );
        expect(firstSection.top, greaterThanOrEqualTo(bar.bottom));

        await tester.tap(find.byTooltip('Back'));
        await tester.pumpAndSettle();
        expect(find.byType(UsageLimitsScreen), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }

  for (final theme in [AppTheme.light, AppTheme.dark]) {
    testWidgets('text scrolled under the wrapped title stays behind the scrim '
        'at 390 px, text scale 3 (${theme.brightness.name})', (tester) async {
      tester.view.physicalSize = const Size(390, 844);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(top: _safeTop, bottom: 34);
      tester.view.viewPadding = const FakeViewPadding(
        top: _safeTop,
        bottom: 34,
      );
      tester.platformDispatcher.textScaleFactorTestValue = 3;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final source = FakeProviderUsageSource(
        isAvailable: true,
        projection: PortalProviderUsageProjection.fromJson(
          providerUsagePayload(),
        ),
      );
      final boundary = GlobalKey();
      final navigator = GlobalKey<NavigatorState>();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: ListenableProvider<ProviderUsageSource>.value(
            value: source,
            child: MaterialApp(
              navigatorKey: navigator,
              theme: theme,
              home: const SizedBox.shrink(),
            ),
          ),
        ),
      );
      navigator.currentState!.push(
        MaterialPageRoute<void>(
          builder: (_) => UsageLimitsScreen(clock: () => usageFixtureNow),
        ),
      );
      await tester.pumpAndSettle();

      Future<ByteData> capture() async {
        final render =
            boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = (await tester.runAsync(render.toImage))!;
        addTearDown(image.dispose);
        return (await tester.runAsync(
          () => image.toByteData(format: ui.ImageByteFormat.rawRgba),
        ))!;
      }

      // The complete title and action area: both title lines and the Back
      // touch target.
      final title = tester.renderObject<RenderParagraph>(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.text(_title),
        ),
      );
      final lineTops = title
          .getBoxesForSelection(
            const TextSelection(baseOffset: 0, extentOffset: _title.length),
          )
          .map((box) => box.top)
          .toSet();
      expect(lineTops, hasLength(2), reason: 'the title wraps');
      final titleRect = title.localToGlobal(Offset.zero) & title.size;
      final back = tester.getRect(
        find.ancestor(
          of: find.byTooltip('Back'),
          matching: find.byType(IconButton),
        ),
      );
      final chrome = Rect.fromLTRB(
        0,
        math.min(titleRect.top, back.top),
        390,
        math.max(titleRect.bottom, back.bottom),
      );

      // Nothing is under the bar before scrolling.
      final clear = await capture();
      final position = tester
          .state<ScrollableState>(find.byType(Scrollable))
          .position;
      var covered = 0;
      for (var offset = 0.0; offset <= position.maxScrollExtent; offset += 40) {
        position.jumpTo(offset);
        await tester.pump();
        final under = tester
            .renderObjectList<RenderParagraph>(
              find.descendant(
                of: find.byType(ListView),
                matching: find.byType(RichText),
              ),
            )
            .where(
              (text) => (text.localToGlobal(Offset.zero) & text.size).overlaps(
                chrome,
              ),
            );
        if (under.isEmpty) continue;
        covered++;
        final scrolled = await capture();
        var bleed = 0;
        var at = Offset.zero;
        for (var y = chrome.top.ceil(); y < chrome.bottom.floor(); y++) {
          for (var x = 0; x < 390; x++) {
            final i = (y * 390 + x) * 4;
            for (var c = 0; c < 3; c++) {
              final d = (clear.getUint8(i + c) - scrolled.getUint8(i + c))
                  .abs();
              if (d > bleed) {
                bleed = d;
                at = Offset(x.toDouble(), y.toDouble());
              }
            }
          }
        }
        expect(
          bleed,
          lessThanOrEqualTo(_maxBleed),
          reason:
              'scrolled text shows through the title area at $at, '
              'scroll offset $offset',
        );
      }
      expect(covered, greaterThan(0), reason: 'no text scrolled under');
    });
  }
}
