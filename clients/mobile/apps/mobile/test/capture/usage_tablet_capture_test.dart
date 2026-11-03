// Visual-evidence capture for the tablet Usage-page spacing fix.
//
// What changed: the Overview headline grid derived tile height from tile width
// (`childAspectRatio: 1.5`), so on an iPad each card grew to ~325px tall with
// its label/value/trend stranded top/middle/bottom, and every tab stretched
// phone-sized type across the full ~1024px viewport.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop...HEAD -- lib | git apply -R
//   USAGE_STAGE=before flutter test test/capture/usage_tablet_capture_test.dart --update-goldens
//   git diff origin/develop...HEAD -- lib | git apply
//   USAGE_STAGE=after  flutter test test/capture/usage_tablet_capture_test.dart --update-goldens
//
// Captures are deterministic: no network, no live agents. Every repository is
// the in-repo mock seeded with fixed data, latency is zeroed, and a system TTF
// is registered as the default family so the PNGs render real glyphs instead of
// the test font's placeholder boxes.
//
// Output: <repo>/.playwright/usage-ipad-spacing/*-<stage>.png (gitignored).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/stats/views/stats_screen.dart';

/// Captures are written under gitignored `.playwright/`, so the goldens are
/// never committed and cannot be compared in CI. The suite defaults to the
/// `after` stage and always exercises the widget tree, but only compares PNGs
/// when a stage is requested explicitly. The durable layout assertions live in
/// `overview_tab_test.dart` and `stats_tab_list_test.dart`.
final String? _requestedStage = Platform.environment['USAGE_STAGE'];
final String _stage = switch (_requestedStage) {
  null => 'after',
  'before' => 'before',
  'after' => 'after',
  final value => throw ArgumentError.value(
    value,
    'USAGE_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name) =>
    '../../../../.playwright/usage-ipad-spacing/$name-$_stage.png';

Future<void> _expectUsageCapture(String name) async {
  final usageSurface = find.byType(StatsScreen);
  expect(usageSurface, findsOneWidget);
  if (_requestedStage == null) return;
  await expectLater(usageSurface, matchesGoldenFile(_capture(name)));
}

/// Registers a real system typeface as the default family. `flutter test`
/// otherwise draws every glyph as a filled box, which hides the very thing
/// these captures are meant to show.
Future<void> _loadRealFont() async {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Verdana.ttf',
    '/Library/Fonts/Arial.ttf',
  ];
  for (final path in candidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    for (final family in ['Roboto', '.SF UI Text', '.SF UI Display']) {
      final loader = FontLoader(family)..addFont(Future.value(bytes));
      await loader.load();
    }
    return;
  }
}

Widget _usageApp({double textScaleFactor = 1}) => MultiProvider(
  providers: [
    ChangeNotifierProvider<AuthViewModel>(
      create: (_) =>
          AuthViewModel(repository: MockAuthRepository(latency: Duration.zero)),
    ),
    ChangeNotifierProvider<StatsViewModel>(
      create: (_) => StatsViewModel(
        repository: MockStatsRepository(latency: Duration.zero),
      )..loadUsage(),
    ),
    ChangeNotifierProvider<MembersViewModel>(
      create: (_) => MembersViewModel(
        repository: MockMembersRepository(latency: Duration.zero),
      )..load(),
    ),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    themeMode: ThemeMode.dark,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(textScaler: TextScaler.linear(textScaleFactor)),
      child: child!,
    ),
    home: const StatsScreen(),
  ),
);

Future<void> _pumpAt(
  WidgetTester tester,
  Size logical, {
  double textScaleFactor = 1,
}) async {
  final previousOnError = FlutterError.onError;
  if (_requestedStage == 'before') {
    // The baseline intentionally includes the overflow fixed by this change.
    // Keep its debug stripes in the PNG without failing the capture run.
    FlutterError.onError = (details) {
      if (details.exceptionAsString().contains('A RenderFlex overflowed')) {
        return;
      }
      previousOnError?.call(details);
    };
    addTearDown(() => FlutterError.onError = previousOnError);
  }
  tester.view.physicalSize = logical;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_usageApp(textScaleFactor: textScaleFactor));
  await tester.pumpAndSettle();
}

void main() {
  group('usage tablet captures', () {
    setUpAll(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      await _loadRealFont();
    });

    testWidgets('usage overview on an iPad Pro 12.9" (1024x1366)', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(1024, 1366));
      await _expectUsageCapture('usage-overview-ipad-12-9');
    });

    testWidgets('usage overview on an iPad 11" landscape (1194x834)', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(1194, 834));
      await _expectUsageCapture('usage-overview-ipad-11-landscape');
    });

    testWidgets('usage overview on an iPhone 13 (390x844)', (tester) async {
      await _pumpAt(tester, const Size(390, 844));
      await _expectUsageCapture('usage-overview-iphone-13');
    });

    testWidgets('usage overview on a narrow phone (320x568)', (tester) async {
      await _pumpAt(tester, const Size(320, 568));
      await _expectUsageCapture('usage-overview-phone-320');
    });

    testWidgets('usage overview at 3x accessibility text scale', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(390, 844), textScaleFactor: 3);
      await _expectUsageCapture('usage-overview-text-scale-3');
    });

    testWidgets('usage tokens tab on an iPad Pro 12.9" (1024x1366)', (
      tester,
    ) async {
      await _pumpAt(tester, const Size(1024, 1366));
      await tester.tap(find.text('Tokens'));
      await tester.pumpAndSettle();
      await _expectUsageCapture('usage-tokens-ipad-12-9');
    });
  });
}
