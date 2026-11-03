// CAN-3622 capture spec: visual evidence only, not regression coverage. The
// durable coverage is can_3622_search_field_device_test.dart plus the
// flutter test suites (canopy_search_field_test, remote_pipeline_dispatch_test,
// feed_screen_test, design_system_screen_test).
//
// CAN-3622 replaces the pipeline picker's and feed filter sheet's search
// fields with the shared CanopySearchField and turns the Pipeline Runs Run
// action into an accent CanopyButton. This walks the Pipeline Runs card, the
// picker (empty, focused, "staging", cleared), the feed filter sheet (empty,
// typed, cleared) and the Design system index in the light and then the dark
// theme. Run once per stage on the unchanged and changed trees from
// apps/mobile:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3622_search_field_capture_test.dart \
//     --dart-define=CAN3622_STAGE=before -d <device-id>
//
// Add --dart-define=CAN3622_TEXT_SCALE=<factor> to capture at a fixed text
// scale. The before stage has no field Clear, so its "cleared" captures empty
// the field programmatically, and it has no Search field preview.
//
// Deterministic: synthetic fixtures (test/support/search_field_fixture.dart),
// forced theme mode, no desktop, account or network. Captures land in
// build/promo_screenshots/can-3622-<surface>-<stage>-<theme>[-x<scale>].png.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/developer_options/views/design_system_screen.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';

import '../test/support/search_field_fixture.dart';

const _stage = String.fromEnvironment('CAN3622_STAGE', defaultValue: 'after');
const _textScale = String.fromEnvironment('CAN3622_TEXT_SCALE');

TransitionBuilder? get _builder {
  final scale = double.tryParse(_textScale);
  if (scale == null) return null;
  return (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
    child: child!,
  );
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> capture(
    WidgetTester tester,
    String surface,
    String theme,
  ) async {
    await tester.pumpAndSettle();
    // Let SVG glyphs and fonts finish their first frames.
    await tester.pump(const Duration(milliseconds: 300));
    final scale = _textScale.isEmpty ? '' : '-x$_textScale';
    await binding.takeScreenshot('can-3622-$surface-$_stage-$theme$scale');
  }

  Future<void> prepareSurface(WidgetTester tester) async {
    if (!Platform.isAndroid) return;
    // Per-test teardown reverts the conversion, so every test converts again.
    await binding.convertFlutterSurfaceToImage();
    await tester.pump(const Duration(milliseconds: 300));
  }

  for (final (theme, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('pipeline runs and picker ($theme)', (tester) async {
      final viewModel = RemoteControlViewModel(
        repository: searchFieldRemoteRepository(),
        stateRefreshDebounce: Duration.zero,
      );
      await viewModel.connect('123456');
      await tester.pumpWidget(
        searchFieldRemoteHost(viewModel, themeMode: mode, builder: _builder),
      );
      await prepareSurface(tester);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Pipeline Runs'),
        200,
        scrollable: find.byType(Scrollable).last,
      );
      await capture(tester, 'pipeline-runs', theme);

      await tester.tap(find.byKey(const ValueKey('pipeline-dispatch-open')));
      await tester.pumpAndSettle();
      final field = find.byKey(const ValueKey('pipeline-picker-search'));
      await capture(tester, 'picker-empty', theme);
      await tester.tap(field);
      await capture(tester, 'picker-focused', theme);
      await tester.enterText(field, 'staging');
      await capture(tester, 'picker-staging', theme);
      if (_stage == 'before') {
        await tester.enterText(field, '');
      } else {
        await tester.tap(
          find.descendant(of: field, matching: find.byTooltip('Clear')),
        );
      }
      await capture(tester, 'picker-cleared', theme);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
      viewModel.dispose();
    });

    testWidgets('feed filter sheet ($theme)', (tester) async {
      await tester.pumpWidget(
        searchFieldFeedHost(
          RecordingFeedRepository(),
          themeMode: mode,
          builder: _builder,
        ),
      );
      await prepareSurface(tester);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();
      final field = find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(TextField),
      );
      await capture(tester, 'feed-sheet-empty', theme);
      await tester.tap(field);
      await tester.enterText(field, 'deploy');
      await capture(tester, 'feed-sheet-typed', theme);
      if (_stage == 'before') {
        await tester.enterText(field, '');
      } else {
        await tester.tap(
          find.descendant(of: field, matching: find.byTooltip('Clear')),
        );
      }
      await capture(tester, 'feed-sheet-cleared', theme);
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    });

    testWidgets('design system ($theme)', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          themeMode: mode,
          builder: _builder,
          home: const DesignSystemScreen(),
        ),
      );
      await prepareSurface(tester);
      await capture(tester, 'design-system-index', theme);
      if (_stage == 'before') return;
      final entry = find.byKey(const ValueKey('search-field-button'));
      // Large text sizes push the row below the fold.
      await tester.scrollUntilVisible(entry, 200);
      await tester.pumpAndSettle();
      await tester.tap(entry);
      await capture(tester, 'search-field-preview', theme);
    });
  }
}
