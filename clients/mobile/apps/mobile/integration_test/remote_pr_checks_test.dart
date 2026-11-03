// CAN-3618 on-device flow: a Remote worktree chat's Activity & files drawer
// lists every CI check under its PR line, follows PR refreshes, keeps the
// user's collapse until the drawer closes, and reopens with the default.
//
//   flutter test integration_test/remote_pr_checks_test.dart -d <device-id>
//
// Deterministic: the repository is the local fake (no pairing, desktop,
// GitHub or network) and every check is fixed. A running check animates
// indefinitely, so the flow pumps for fixed times instead of settling.
// Opening a check in the external browser is verified separately; the
// launch-failure paths are covered by remote_pr_checks_sidebar_test.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/pr_checks_list.dart';
import 'package:provider/provider.dart';

import '../test/support/fake_remote_control_repository.dart';
import '../test/support/pr_checks_fixture.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  Future<void> pumpFor(WidgetTester tester, [int milliseconds = 600]) async {
    for (var elapsed = 0; elapsed < milliseconds; elapsed += 50) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  testWidgets('lists, refreshes and toggles PR checks in the drawer', (
    tester,
  ) async {
    var hostState = prChecksState([prChecksRepo(checks: nineStatePrChecks())]);
    Future<Map<String, dynamic>> runner(
      RemotePrAction action, {
      String? repoId,
      RemotePrActionIdentity? identity,
      bool confirmUnresolvedComments = false,
    }) async => action == RemotePrAction.refresh ? hostState : const {};

    const worktree = RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature/ci-checks',
    );
    final repository = FakeRemoteControlRepository()
      ..supportsPrActions = true
      ..prActionRunner = runner
      ..snapshotBuilder = () => const RemoteSessionSnapshot(
        workspaces: [],
        worktrees: [worktree],
        standaloneChats: [],
        chatSummaries: [
          RemoteChatSummary(
            chatId: 'chat-1',
            scope: RemoteChatScope.worktree,
            workspaceLocalId: 'ws-1',
            worktreeLocalId: 'wt-1',
            title: 'CI checks',
            active: true,
          ),
        ],
      );
    final viewModel = RemoteControlViewModel(
      repository: repository,
      stateRefreshDebounce: Duration.zero,
    );
    await viewModel.connect('123456');
    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<RemoteControlViewModel>(
            create: (_) => viewModel,
          ),
          ChangeNotifierProvider<TurnFeedbackController>(
            create: (_) => TurnFeedbackController(
              repository: MockTurnFeedbackRepository(),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          home: const RemoteChatScreen.worktree(worktree: worktree),
        ),
      ),
    );
    await pumpFor(tester, 1000);

    Future<void> openDrawer() async {
      await tester.tap(find.byKey(const ValueKey('open-activity')));
      await pumpFor(tester, 1000);
    }

    Future<void> showRow(String name) async {
      await tester.ensureVisible(find.text(name));
      await pumpFor(tester, 300);
    }

    final runningSpinner = find.descendant(
      of: find.byType(PrChecksList),
      matching: find.byType(DotSpinner),
    );

    // A failing PR opens its list with all nine states, in host order.
    await openDrawer();
    expect(find.text('Checks (1/9 passed)'), findsOneWidget);
    expect(find.textContaining('checks failing'), findsNothing);
    for (final label in const [
      'Action required',
      'Running',
      'Queued',
      'Skipped',
      'Timed out',
      'Neutral',
      'Succeeded',
      'Canceled',
      'Failed',
    ]) {
      await showRow(label);
      expect(find.text(label), findsOneWidget, reason: label);
    }
    expect(runningSpinner, findsOneWidget);

    // The user's collapse survives a refresh that changes the checks.
    await showRow('Checks (1/9 passed)');
    await tester.tap(find.text('Checks (1/9 passed)'));
    await pumpFor(tester);
    expect(find.text('unit-tests'), findsNothing);
    hostState = prChecksState([
      prChecksRepo(
        checkStatus: 'pending',
        checks: [
          prCheckDetail('lint', status: 'success', executionState: 'success'),
          prCheckDetail(
            'unit-tests',
            status: 'pending',
            executionState: 'running',
          ),
        ],
      ),
    ]);
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('Checks (1/2 passed)'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);

    // Closing and reopening applies the default again.
    Navigator.of(tester.element(find.text('Checks (1/2 passed)'))).pop();
    await pumpFor(tester, 1000);
    expect(find.text('Checks (1/2 passed)'), findsNothing);
    await openDrawer();
    expect(find.text('unit-tests'), findsOneWidget);
    expect(runningSpinner, findsOneWidget);

    // Once everything passed the list collapses, and the motion stops.
    hostState = prChecksState([
      prChecksRepo(
        checkStatus: 'passing',
        checks: [
          prCheckDetail('lint', status: 'success', executionState: 'success'),
          prCheckDetail(
            'unit-tests',
            status: 'success',
            executionState: 'success',
          ),
        ],
      ),
    ]);
    await tester.tap(find.byKey(const ValueKey('refresh-pr')));
    await pumpFor(tester);
    expect(find.text('Checks (2/2 passed)'), findsOneWidget);
    expect(find.text('unit-tests'), findsNothing);
    expect(runningSpinner, findsNothing);
    await tester.tap(find.text('Checks (2/2 passed)'));
    await pumpFor(tester);
    expect(find.text('Succeeded'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });
}
