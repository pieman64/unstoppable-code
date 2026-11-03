// CAN-4873 — device verification of Remote Control reconnect cost. Run from
// apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/remote_reconnect_cost_test.dart \
//     -d <device-id>
//
// The production repository, view model and Remote tab talk to the synthetic
// Portal server of the request budgets
// (`remote_request_budget_harness.dart`) on the device's real clock. The
// fixture covers the phone's side, not a real desktop sleep or network
// change. The flow takes about two minutes.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';
import 'package:provider/provider.dart';

import '../test/support/remote_request_budget_harness.dart';

/// Pumps frames until [done] holds; returns whether it did within [timeout].
Future<bool> _waitFor(
  WidgetTester tester,
  bool Function() done, {
  Duration timeout = const Duration(seconds: 20),
}) async {
  final watch = Stopwatch()..start();
  while (!done()) {
    if (watch.elapsed > timeout) return false;
    await tester.pump(const Duration(milliseconds: 100));
  }
  return true;
}

bool _present(Finder finder) => finder.evaluate().isNotEmpty;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('reconnects cheaply through sleep, wake and a network blip', (
    tester,
  ) async {
    final desktop = BudgetDesktop(now: DateTime.now);
    final viewModel = RemoteControlViewModel(
      repository: desktop.repository(),
      clock: DateTime.now,
    );
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>.value(
            value: viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          navigatorObservers: [appRouteObserver],
          home: const RemoteScreen(),
        ),
      ),
    );
    final recorder = desktop.recorder;
    expect(
      await _waitFor(tester, () => _present(find.text(budgetWorkspaceName))),
      isTrue,
    );

    // The desktop sleeps for 20 seconds: the 4- and 8-second steps allow at
    // most two reconnects, where a flat 2-second retry made about ten.
    final inactive = recorder.mark();
    desktop.sleep();
    expect(
      await _waitFor(tester, () => _present(find.byType(RemoteDegradedBanner))),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 20));
    final sleeping = recorder.countsSince(inactive);
    expect(sleeping['GET events/stream'], inInclusiveRange(1, 2));
    expect(sleeping['GET events'], isNull);

    // The desktop wakes: the next step reaches it, well within the cap.
    desktop.wake();
    expect(
      await _waitFor(
        tester,
        () => !_present(find.byType(RemoteDegradedBanner)),
        timeout: const Duration(seconds: 60),
      ),
      isTrue,
    );
    // The phone list may show the workspace collapsed.
    if (!_present(find.text('koala'))) {
      await tester.tap(find.text(budgetWorkspaceName));
      await tester.pump(const Duration(milliseconds: 300));
    }
    await tester.tap(find.text('koala'));
    expect(
      await _waitFor(
        tester,
        () => _present(find.text(desktop.lastMessageText)),
      ),
      isTrue,
    );

    // A network change after a healthy stream: the open stream drops and the
    // next two connections fail. The client stays on SSE.
    await tester.pump(const Duration(seconds: 11));
    final blip = recorder.mark();
    desktop.failStreams(2);
    desktop.close();
    await tester.pump(const Duration(seconds: 15));
    desktop.reply('Delivered after the network blip.');
    expect(
      await _waitFor(
        tester,
        () => _present(find.text('Delivered after the network blip.')),
      ),
      isTrue,
    );
    final recovered = recorder.countsSince(blip);
    expect(recovered['GET events/stream'], 3);
    expect(recovered['GET events'], isNull);

    expect(find.byType(ConnectDesktopView), findsNothing);
    expect(desktop.unexpected, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
    desktop.close();
  });
}
