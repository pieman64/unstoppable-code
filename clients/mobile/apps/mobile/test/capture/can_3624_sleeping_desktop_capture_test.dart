// Visual-evidence capture for CAN-3624 (Remote Control ends a sleeping
// desktop's pairing when another desktop's session is current).
//
// What changes:
//  * Desktop A is paired and asleep while Desktop B waits for its pairing
//    code. Returning to the app used to end A's session and show the pairing
//    form. A's cached shell now stays, behind the offline banner.
//  * While Desktop B is active, returning to the app used to switch the
//    paired desktop to B. A now stays paired.
//  * When the server reports A's own session gone, the pairing form and copy
//    are unchanged; only the server-side end request is gone, which the
//    durable tests assert.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop -- lib > /tmp/can-3624-lib.patch
//   git apply -R /tmp/can-3624-lib.patch
//   CAN3624_STAGE=before flutter test test/capture/can_3624_sleeping_desktop_capture_test.dart --update-goldens
//   git apply /tmp/can-3624-lib.patch
//   CAN3624_STAGE=after flutter test test/capture/can_3624_sleeping_desktop_capture_test.dart --update-goldens
//
// Captures are deterministic: the production repository talks to a synthetic
// Portal server with fixed rows, and no live desktop, agent, or network is
// involved. Output is written to the gitignored `<repo>/.playwright/can-3624/`
// directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:provider/provider.dart';

import '../support/remote_session_fake_server.dart';

final String? _requestedStage = Platform.environment['CAN3624_STAGE'];
final String _stage = switch (_requestedStage) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN3624_STAGE',
    'must be either "before" or "after"',
  ),
};

/// `<name>-<stage>-<light|dark>.png`, the naming the capture report builder
/// pairs into before/after scenarios.
String _capture(String name, String mode) =>
    '../../../../.playwright/can-3624/$name-$_stage-$mode.png';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
  // Only a golden-writing run needs real fonts; CI runs this assertion-only.
  if (_requestedStage == null) return;
  throw StateError(
    'No font found for "$family". Checked: ${candidates.where((p) => p.isNotEmpty).join(', ')}',
  );
}

/// Pairs the Remote tab with Desktop A, last seen three days ago, and lets it
/// sleep past the stale sweep.
Future<FakePortalSessionServer> _pumpPairedToSleepingA(
  WidgetTester tester,
  ThemeMode mode,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final server = FakePortalSessionServer()
    ..addSession(
      id: 'sess-a',
      clientName: 'Desktop A',
      eventCursor: 40,
      lastSeenAt: DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 3))
          .toIso8601String(),
    );
  await tester.pumpWidget(
    ChangeNotifierProvider<RemoteControlViewModel>(
      create: (_) => RemoteControlViewModel(
        repository: server.repository(),
        stateRefreshDebounce: Duration.zero,
      ),
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: mode,
        // The same Scaffold + NavigationBar chrome `HomeShell` gives this tab.
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
  await tester.pump();
  server.sleep('sess-a');
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
  expect(find.text('Desktop A workspace'), findsOneWidget);
  return server;
}

Future<void> _foreground(WidgetTester tester) async {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
  await tester.pump();
  await tester.pump(const Duration(seconds: 1));
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _writeCapture(String name, String mode) async {
  if (_requestedStage == null) return;
  Directory('../../.playwright/can-3624').createSync(recursive: true);
  await expectLater(
    find.byType(Scaffold).first,
    matchesGoldenFile(_capture(name, mode)),
  );
}

Future<void> _unmount(
  WidgetTester tester,
  FakePortalSessionServer server,
) async {
  server.close();
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(minutes: 1));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    // The theme's own families, bundled with the app (paths are relative to
    // `apps/mobile`, where this spec runs).
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
    await _loadFont('JetBrainsMono', const [
      'assets/fonts/jetbrains-mono/JetBrainsMonoVariable.ttf',
    ]);
    await _loadFont('Roboto', const [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Supplemental/Verdana.ttf',
      '/Library/Fonts/Arial.ttf',
    ]);
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

  for (final (label, mode) in const [
    ('light', ThemeMode.light),
    ('dark', ThemeMode.dark),
  ]) {
    testWidgets('paired desktop asleep ($label)', (tester) async {
      final server = await _pumpPairedToSleepingA(tester, mode);

      expect(find.text('Desktop A'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _writeCapture('paired-inactive', label);
      await _unmount(tester, server);
    });

    testWidgets('foreground while another desktop awaits its code ($label)', (
      tester,
    ) async {
      final server = await _pumpPairedToSleepingA(tester, mode);
      server.addSession(
        id: 'sess-b',
        clientName: 'Desktop B',
        status: 'pending_auth',
        connectionStatus: 'pending',
      );

      await _foreground(tester);

      if (_stage == 'after') {
        expect(find.text('Desktop A workspace'), findsOneWidget);
        expect(server.endRequests, isEmpty);
      } else {
        expect(find.byType(ConnectDesktopView), findsOneWidget);
        expect(server.endRequests, isNotEmpty);
      }
      expect(tester.takeException(), isNull);
      await _writeCapture('foreground-pending-other', label);
      await _unmount(tester, server);
    });

    testWidgets('foreground while another desktop is active ($label)', (
      tester,
    ) async {
      final server = await _pumpPairedToSleepingA(tester, mode);
      server.addSession(id: 'sess-b', clientName: 'Desktop B');

      await _foreground(tester);

      expect(
        find.text(_stage == 'after' ? 'Desktop A' : 'Desktop B'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await _writeCapture('foreground-active-other', label);
      await _unmount(tester, server);
    });

    testWidgets('foreground after the pairing ended ($label)', (tester) async {
      final server = await _pumpPairedToSleepingA(tester, mode);
      server.currentSessionOverride = () =>
          (status: 200, body: const {'session': null});

      await _foreground(tester);

      expect(
        find.text(
          'The desktop is no longer connected. Connect it again to continue.',
        ),
        findsOneWidget,
      );
      expect(server.endRequests, _stage == 'after' ? isEmpty : isNotEmpty);
      expect(tester.takeException(), isNull);
      await _writeCapture('own-session-ended', label);
      await _unmount(tester, server);
    });
  }
}
