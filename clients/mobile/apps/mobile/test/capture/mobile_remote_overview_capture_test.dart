// Visual-evidence capture for the mobile Remote Control attention sections.
//
// What changed: the Workspaces tab now pins cross-workspace attention rows
// above the existing workspace list.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop -- lib | git apply -R
//   REMOTE_OVERVIEW_STAGE=before flutter test test/capture/mobile_remote_overview_capture_test.dart --update-goldens
//   git diff origin/develop -- lib | git apply
//   REMOTE_OVERVIEW_STAGE=after flutter test test/capture/mobile_remote_overview_capture_test.dart --update-goldens
//
// Captures are deterministic: the in-repo mock supplies fixed workspace data,
// network latency is disabled, and a system font renders real glyphs.
//
// Output: <repo>/.playwright/mobile-remote-overview/*-<stage>.png
// (gitignored).

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/workspaces_list_view.dart';
import 'package:provider/provider.dart';

import '../support/reduced_motion.dart';

final String? _requestedStage = Platform.environment['REMOTE_OVERVIEW_STAGE'];
final String _stage = switch (_requestedStage) {
  null => 'after',
  'before' => 'before',
  'after' => 'after',
  final value => throw ArgumentError.value(
    value,
    'REMOTE_OVERVIEW_STAGE',
    'must be either "before" or "after"',
  ),
};
final String _captureRoot =
    Platform.environment['REMOTE_OVERVIEW_CAPTURE_DIR'] ??
    '../../../../.playwright/mobile-remote-overview';

String _capture(String name) => '$_captureRoot/$name-$_stage.png';

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

Future<void> _pumpWorkspaces(WidgetTester tester, Size logicalSize) async {
  tester.view.physicalSize = logicalSize;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final viewModel = RemoteControlViewModel(
    repository: MockRemoteControlRepository(latency: Duration.zero),
  );
  addTearDown(viewModel.dispose);
  await tester.runAsync(() => viewModel.connect('123456'));

  await tester.pumpWidget(
    ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: viewModel,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: ThemeMode.dark,
        home: const Scaffold(body: WorkspacesListView()),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _expectCapture(String name) async {
  final surface = find.byType(WorkspacesListView);
  expect(surface, findsOneWidget);
  if (_requestedStage != null) {
    await expectLater(surface, matchesGoldenFile(_capture(name)));
  }
}

void main() {
  group('mobile Remote Control overview captures', () {
    // Fixture worktrees include busy/running rows whose always-on spinners
    // would keep pumpAndSettle from settling; reduce-motion also keeps the
    // captured frames deterministic.
    useReducedMotion();

    setUpAll(() async {
      TestWidgetsFlutterBinding.ensureInitialized();
      await _loadRealFont();
    });

    testWidgets('Workspaces tab on an iPhone 13 (390x844)', (tester) async {
      await _pumpWorkspaces(tester, const Size(390, 844));
      if (_stage == 'after') {
        expect(
          find.byKey(const ValueKey('attention-sections')),
          findsOneWidget,
        );
      }
      expect(tester.takeException(), isNull);
      await _expectCapture('workspaces-iphone-13');
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    });

    testWidgets('Workspaces tab on a narrow phone (320x568)', (tester) async {
      await _pumpWorkspaces(tester, const Size(320, 568));
      if (_stage == 'after') {
        expect(
          find.byKey(const ValueKey('attention-sections')),
          findsOneWidget,
        );
      }
      expect(tester.takeException(), isNull);
      await _expectCapture('workspaces-phone-320');
      await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
    });
  });
}
