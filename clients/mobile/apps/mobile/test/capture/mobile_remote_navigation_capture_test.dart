// Visual-evidence capture for the mobile Remote navigation redesign.
//
// What changes: the desktop-style, always-expanded tree becomes a compact
// phone-first Remote home with pinned, deduplicated attention items, collapsed
// workspaces, one connection control, and consistent task-creation entry
// points.
//
// Run both stages from `apps/mobile`:
//
//   REMOTE_UX_CAPTURE=1 REMOTE_UX_STAGE=before flutter test test/capture/mobile_remote_navigation_capture_test.dart --update-goldens
//   REMOTE_UX_CAPTURE=1 REMOTE_UX_STAGE=after  flutter test test/capture/mobile_remote_navigation_capture_test.dart --update-goldens
//
// Captures are deterministic: the in-repo mock repository supplies fixed
// workspaces and tasks with zero latency; no live desktop, agent, or network
// is involved. Output is written to the gitignored
// `<repo>/.playwright/mobile-remote-ux/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

final String _stage = switch (Platform.environment['REMOTE_UX_STAGE']) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'REMOTE_UX_STAGE',
    'must be either "before" or "after"',
  ),
};

final bool _captureEnabled = Platform.environment['REMOTE_UX_CAPTURE'] == '1';

String _capture(String name) =>
    '../../../../.playwright/mobile-remote-ux/$name-$_stage.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
}

Future<void> _pumpConnectedRemoteScreen(WidgetTester tester) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final viewModel = RemoteControlViewModel(
    repository: MockRemoteControlRepository(latency: Duration.zero),
    stateRefreshDebounce: Duration.zero,
  );
  await tester.runAsync(() => viewModel.connect('123456'));
  addTearDown(viewModel.dispose);

  await tester.pumpWidget(
    ChangeNotifierProvider<RemoteControlViewModel>.value(
      value: viewModel,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: ThemeMode.dark,
        home: const RemoteScreen(),
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
    ]);
    final flutter = File('/opt/homebrew/bin/flutter');
    final materialPath = flutter.existsSync()
        ? '${flutter.resolveSymbolicLinksSync().replaceFirst(RegExp(r'/flutter$'), '')}/cache/artifacts/material_fonts/MaterialIcons-Regular.otf'
        : '';
    await _loadFont('MaterialIcons', [materialPath]);
  });

  testWidgets('Remote home on an iPhone 13', (tester) async {
    await _pumpConnectedRemoteScreen(tester);

    if (_stage == 'after') {
      expect(find.text('Attention'), findsNothing);
      expect(find.text('Browse'), findsNothing);
      expect(find.byKey(const ValueKey('attention-sections')), findsOneWidget);
      expect(find.text('Projects'), findsOneWidget);
    }
    expect(tester.takeException(), isNull);

    if (_captureEnabled) {
      Directory(
        '../../.playwright/mobile-remote-ux',
      ).createSync(recursive: true);
      await expectLater(
        find.byType(RemoteScreen),
        matchesGoldenFile(_capture('remote-home')),
      );
    }
    await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
  });

  testWidgets('pinned attention queue on an iPhone 13', (tester) async {
    if (_stage == 'before') return;
    await _pumpConnectedRemoteScreen(tester);

    expect(find.text('NEEDS ATTENTION'), findsOneWidget);
    // Attention rows are label-first; the metadata line names the workspace.
    expect(find.text('krill'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('attention-row-ws-app-wt-bugfix')),
        matching: find.text('acme-web'),
      ),
      findsOneWidget,
    );
    expect(find.text('Projects'), findsOneWidget);

    if (_captureEnabled) {
      Directory(
        '../../.playwright/mobile-remote-ux',
      ).createSync(recursive: true);
      await expectLater(
        find.byType(RemoteScreen),
        matchesGoldenFile(_capture('attention')),
      );
    }
    await tester.pump(kRemoteHydrationTimeout + const Duration(seconds: 1));
  });
}
