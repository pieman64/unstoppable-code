// Visual-evidence capture for CAN-3557 (Remote Control connection issues after
// closing or backgrounding the mobile app).
//
// What changes:
//  * A cold start that cannot reach the server used to show a silent pairing
//    form. The title now says the app is retrying, and the retries restore a
//    live pairing on their own.
//  * When the app returns and this phone's own connection has not come back,
//    the workspace list used to keep saying `Connected`. It now reports cached
//    data, with a reconnecting banner that becomes a verdict after 30s.
//
// Run both stages from `apps/mobile` (the tree must be rebuilt between them):
//
//   git diff origin/develop -- lib > /tmp/can-3557-lib.patch
//   git apply -R /tmp/can-3557-lib.patch
//   CAN3557_STAGE=before flutter test test/capture/can_3557_remote_reconnect_capture_test.dart --update-goldens
//   git apply /tmp/can-3557-lib.patch
//   CAN3557_STAGE=after flutter test test/capture/can_3557_remote_reconnect_capture_test.dart --update-goldens
//
// Captures are deterministic: the in-repo mock supplies fixed workspace data
// behind a fake whose probe and event delivery the spec controls, and no live
// desktop, agent, or network is involved. Output is written to the gitignored
// `<repo>/.playwright/can-3557/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:provider/provider.dart';

import '../support/fake_remote_control_repository.dart';

final String? _requestedStage = Platform.environment['CAN3557_STAGE'];
final String _stage = switch (_requestedStage) {
  null || 'after' => 'after',
  'before' => 'before',
  final value => throw ArgumentError.value(
    value,
    'CAN3557_STAGE',
    'must be either "before" or "after"',
  ),
};

/// `<name>-<stage>-<light|dark>.png`, the naming the capture report builder
/// pairs into before/after scenarios.
String _capture(String name, String mode) =>
    '../../../../.playwright/can-3557/$name-$_stage-$mode.png';

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

/// Serves the mock's sample workspaces behind a probe the spec can make
/// unreachable, and never reports event delivery live on its own.
final class _CaptureRepository extends FakeRemoteControlRepository {
  _CaptureRepository({required this.reachable}) {
    autoLive = false;
  }

  final bool reachable;
  final MockRemoteControlRepository _sample = MockRemoteControlRepository(
    latency: Duration.zero,
    restorableConnection: RemoteConnection(
      deviceLabel: 'MacBook-Pro.local',
      pairedAt: DateTime(2026),
      connectionStatus: RemotePortalConnectionStatus.active,
    ),
  );

  @override
  Future<RemoteSessionProbe> probeSession() async {
    if (!reachable) {
      return (outcome: RemoteSessionProbeOutcome.unknown, connection: null);
    }
    final connection = await _sample.restoreSession();
    return (
      outcome: RemoteSessionProbeOutcome.renderable,
      connection: connection,
    );
  }

  @override
  Future<RemoteSessionSnapshot> fetchSnapshot() => _sample.fetchSnapshot();
}

Future<RemoteControlViewModel> _pumpRemote(
  WidgetTester tester,
  ThemeMode mode,
  _CaptureRepository repository,
) async {
  tester.view.physicalSize = const Size(390, 844);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);

  final viewModel = RemoteControlViewModel(
    repository: repository,
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
  await tester.pump(const Duration(milliseconds: 50));
  return viewModel;
}

Future<void> _writeCapture(String name, String mode) async {
  if (_requestedStage == null) return;
  Directory('../../.playwright/can-3557').createSync(recursive: true);
  await expectLater(
    find.byType(Scaffold).first,
    matchesGoldenFile(_capture(name, mode)),
  );
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
    testWidgets('cold start that cannot reach the server ($label)', (
      tester,
    ) async {
      final viewModel = await _pumpRemote(
        tester,
        mode,
        _CaptureRepository(reachable: false),
      );

      expect(find.text('Connect to your desktop'), findsOneWidget);
      if (_stage == 'after') {
        expect(find.text("Can't reach the server · Retrying…"), findsOneWidget);
      }
      expect(tester.takeException(), isNull);
      await _writeCapture('cold-start-unreachable', label);

      // Stops the pending restore retry.
      viewModel.onAppBackgrounded();
      await tester.pumpWidget(const SizedBox());
    });

    for (final (state, wait) in const [
      ('reconnecting', Duration(seconds: 3)),
      ('unreachable', Duration(seconds: 33)),
    ]) {
      testWidgets('resume without event delivery, $state ($label)', (
        tester,
      ) async {
        final repository = _CaptureRepository(reachable: true);
        await _pumpRemote(tester, mode, repository);
        repository.eventsLiveController.add(true);
        await tester.pumpAndSettle();
        expect(find.text('Connected'), findsOneWidget);

        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump(wait);
        await tester.pump(const Duration(milliseconds: 50));

        if (_stage == 'after') {
          expect(find.text('Cached data'), findsOneWidget);
          expect(
            find.text(
              state == 'reconnecting'
                  ? 'Reconnecting…'
                  : "Can't reach the server. Showing cached data.",
            ),
            findsOneWidget,
          );
        }
        expect(tester.takeException(), isNull);
        await _writeCapture('resume-$state', label);

        // Delivery comes back, which settles the link timers.
        repository.eventsLiveController.add(true);
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
