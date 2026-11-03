// Visual-evidence capture for CAN-2579 (mobile: unclear where to find the
// 6-digit setup code).
//
// What changes: the Remote Control pairing form used to say only that the
// desktop app "shows" a 6-digit code, never where. It now names the exact
// path — open the desktop app, click Remote Control (in the account menu
// since CAN-3659), click Enable Remote Control — as a numbered step list above
// the code field.
//
// Run both stages from `apps/mobile`. The stage flag only names the output
// files — it does not check out the old code — so the `before` run must happen
// against a tree where `connect_desktop_view.dart` is still at `origin/develop`
// (copy this spec into a clean worktree, or revert just that file for the run):
//
//   CAN2579_STAGE=before flutter test test/capture/can_2579_pairing_code_help_capture_test.dart --update-goldens
//   # restore the change, then:
//   CAN2579_STAGE=after  flutter test test/capture/can_2579_pairing_code_help_capture_test.dart --update-goldens
//
// Captures are deterministic: the disconnected pairing form takes no input
// beyond the brand name, and the in-repo mock repository is never contacted
// because the screen never leaves the disconnected state. No live desktop,
// agent, or network is involved. Output is written to the gitignored
// `<repo>/.playwright/can-2579/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

final String? _requestedStage = Platform.environment['CAN2579_STAGE'];
final String _stage = switch (_requestedStage) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN2579_STAGE',
    'must be either "before" or "after"',
  ),
};

String _capture(String name) =>
    '../../../../.playwright/can-2579/$name-$_stage.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
  // Only a golden-writing run needs real fonts. Mobile CI runs `flutter test`
  // on Linux, where none of these macOS paths exist; throwing unconditionally
  // fails the whole job on a spec that is assertion-only there.
  if (_requestedStage == null) return;

  // But when goldens ARE being written, falling back to the glyph-less test
  // font would produce unreadable artifacts and still report pass, which
  // defeats the only job this spec has.
  throw StateError(
    'No font found for "$family". Checked: ${candidates.where((p) => p.isNotEmpty).join(', ')}',
  );
}

/// Pumps the Remote screen in its disconnected state, which is the pairing
/// form. The view model is never connected, so the mock repository supplies
/// nothing and the render is a pure function of the widget tree.
Future<void> _pumpPairingForm(WidgetTester tester, ThemeMode mode) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final viewModel = RemoteControlViewModel(
    repository: MockRemoteControlRepository(latency: Duration.zero),
    stateRefreshDebounce: Duration.zero,
  );
  addTearDown(viewModel.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: viewModel,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        // Captured inside the same Scaffold + NavigationBar chrome `HomeShell`
        // gives this tab. A bare RemoteScreen would show a reviewer ~80pt of
        // vertical room production does not have.
        home: Scaffold(
          body: const RemoteScreen(),
          bottomNavigationBar: NavigationBar(
            selectedIndex: 3,
            destinations: const [
              NavigationDestination(icon: Icon(Icons.forum), label: 'Activity'),
              NavigationDestination(icon: Icon(Icons.insights), label: 'Usage'),
              NavigationDestination(icon: Icon(Icons.group), label: 'Members'),
              NavigationDestination(icon: Icon(Icons.devices), label: 'Remote'),
              NavigationDestination(icon: Icon(Icons.person), label: 'Account'),
            ],
          ),
        ),
      ),
    ),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Roboto', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Verdana.ttf',
      '/Library/Fonts/Arial.ttf',
    ]);
    // Probe FLUTTER_ROOT first, then both Homebrew prefixes. Pinning only the
    // ARM Homebrew path would silently render the captures with missing glyphs
    // on Intel macOS, on Linux, and in CI.
    await _loadFont('MaterialIcons', <String>[
      if (Platform.environment['FLUTTER_ROOT'] case final root?)
        '$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
      for (final launcher in [
        '/opt/homebrew/bin/flutter',
        '/usr/local/bin/flutter',
      ])
        if (File(launcher).existsSync())
          '${File(launcher).resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    ]);
  });

  // The rejected-code state is captured too: this pass moved the error message
  // out of `InputDecoration` and onto the cell strip, so it is the state most
  // worth looking at.
  for (final (label, mode) in const [
    ('error-dark', ThemeMode.dark),
    ('error-light', ThemeMode.light),
  ]) {
    testWidgets('rejected code on an iPhone 13 ($label)', (tester) async {
      await _pumpPairingForm(tester, mode);
      await tester.enterText(find.byType(TextField), '000000');
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, 'Connect'));
      await tester.pumpAndSettle();

      expect(find.textContaining('was not recognized'), findsOneWidget);
      expect(tester.takeException(), isNull);

      if (_requestedStage != null) {
        Directory('../../.playwright/can-2579').createSync(recursive: true);
        await expectLater(
          find.byType(Scaffold).first,
          matchesGoldenFile(_capture('pairing-form-$label')),
        );
      }
    });
  }

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('pairing form on an iPhone 13 ($label)', (tester) async {
      await _pumpPairingForm(tester, mode);

      expect(find.text('Connect to your desktop'), findsOneWidget);
      if (_stage == 'after') {
        expect(
          find.textContaining('Remote Control in the account menu'),
          findsOneWidget,
        );
        expect(find.textContaining('Enable Remote Control'), findsOneWidget);
      }
      expect(tester.takeException(), isNull);

      // Only writes goldens when a stage was explicitly requested, matching the
      // sibling capture specs — a plain `flutter test` run stays an assertion-
      // only test and never touches the artifact directory.
      if (_requestedStage != null) {
        Directory('../../.playwright/can-2579').createSync(recursive: true);
        await expectLater(
          find.byType(Scaffold).first,
          matchesGoldenFile(_capture('pairing-form-$label')),
        );
      }
    });
  }
}
