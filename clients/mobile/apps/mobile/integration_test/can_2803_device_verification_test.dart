// CAN-2803 — deterministic physical-device verification for an orphaned
// inactive Remote Control session. Run from apps/mobile with:
//
//   flutter drive --profile --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_2803_device_verification_test.dart \
//     -d <device-id>
//
// The repository is local and fixed: the first frame is an inactive session
// last seen three days earlier; foregrounding returns the server's
// "Active remote control session not found" failure, and the authoritative
// session re-read that follows reports the pairing is gone. Captures land in
// build/promo_screenshots via the shared integration-test driver.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';

final class _OrphanedInactiveRepository extends FakeRemoteControlRepository {
  int restoreSessionCalls = 0;

  /// The first read seeds the cached inactive session the user sees on the
  /// first frame. The second is the authoritative re-read the view model runs
  /// after the command rejection: the server no longer has this pairing, which
  /// is what separates a real orphan from an `inactive` row that would revive.
  @override
  Future<RemoteConnection?> restoreSession() async {
    final call = restoreSessionCalls++;
    if (call > 0) return null;
    return RemoteConnection(
      deviceLabel: 'Office MacBook Pro',
      pairedAt: DateTime(2026, 9, 1),
      connectionStatus: RemotePortalConnectionStatus.inactive,
      lastSeenAt: DateTime(2026, 9, 1, 10),
    );
  }

  @override
  Future<bool> requestOverviewState() async {
    requestOverviewStateCalls += 1;
    throw const RemoteControlException(
      'Active remote control session not found',
    );
  }
}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('CAN-2803 inactive orphan returns to pairing on foreground', (
    tester,
  ) async {
    final repository = _OrphanedInactiveRepository();
    final viewModel = RemoteControlViewModel(repository: repository);

    await tester.pumpWidget(
      ChangeNotifierProvider<RemoteControlViewModel>.value(
        value: viewModel,
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const RemoteScreen(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await binding.convertFlutterSurfaceToImage();
    await tester.pumpAndSettle();

    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    expect(find.text('Connected'), findsNothing);
    expect(find.textContaining('Cached data'), findsOneWidget);
    expect(
      find.text('Desktop is offline. Showing cached data.'),
      findsOneWidget,
    );
    await binding.takeScreenshot('can-2803-inactive-orphan');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(repository.requestOverviewStateCalls, 1);
    expect(find.byType(ConnectDesktopView), findsOneWidget);
    expect(find.byType(RemoteDegradedBanner), findsNothing);
    expect(
      find.textContaining('The desktop is no longer connected'),
      findsOneWidget,
    );
    await binding.takeScreenshot('can-2803-repair-required');
  });
}
