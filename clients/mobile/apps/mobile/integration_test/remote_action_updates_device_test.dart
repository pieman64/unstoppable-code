// CAN-4875 — device verification of event-driven updates after Remote
// Control actions. Run from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/remote_action_updates_device_test.dart \
//     -d <device-id>
//
// The production repository, view model and Remote tab talk to the synthetic
// Portal server of the request budgets (`remote_request_budget_harness.dart`)
// on the device's real clock. Each action settles from the desktop's events:
// a read, a read whose summary is lost before a desktop unread, a return
// after the desktop marked a just-read chat unread, a read whose summary is
// lost after an older unread, a read another client made, the drawer, a hook
// pause, a new worktree, and a clone whose completion is lost. The fixture
// covers the phone's side, not a real desktop. The flow takes about a
// minute.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_screen.dart';
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

/// Pumps frames for [duration] of device time, so a drawer or tab finishes
/// sliding in before a tap lands on it.
Future<void> _settle(
  WidgetTester tester, [
  Duration duration = const Duration(milliseconds: 600),
]) async {
  final watch = Stopwatch()..start();
  while (watch.elapsed < duration) {
    await tester.pump(const Duration(milliseconds: 16));
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('actions settle from desktop events without follow-up reads', (
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

    // A reply is read on sight; its completion settles the read.
    final read = recorder.mark();
    desktop.reply('Settled by the completion event.');
    expect(
      await _waitFor(
        tester,
        () =>
            _present(find.text('Settled by the completion event.')) &&
            !desktop.chatUnread,
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 5));
    final readCounts = recorder.countsSince(read);
    expect(readCounts['POST commands portal.chat.mark_read scope=worktree'], 1);
    expect(readCounts['GET state scope=overview'], isNull);

    // The read's summary delta is lost; a desktop unread still shows after
    // one fresh chat projection confirms it.
    final unreadDot = find.byKey(const ValueKey('chat-tabs-unread'));
    desktop.loseReadSummary = true;
    final lostSummary = recorder.mark();
    desktop.reply('Read without its summary.');
    expect(
      await _waitFor(
        tester,
        () =>
            _present(find.text('Read without its summary.')) &&
            !desktop.chatUnread,
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 5));
    expect(_present(unreadDot), isFalse);
    desktop.markUnread();
    expect(await _waitFor(tester, () => _present(unreadDot)), isTrue);
    await tester.pump(const Duration(seconds: 5));
    expect(_present(unreadDot), isTrue);
    final lostCounts = recorder.countsSince(lostSummary);
    expect(lostCounts['POST commands portal.chat.mark_read scope=worktree'], 1);
    expect(lostCounts['POST commands portal.state.request scope=chat'], 1);
    expect(lostCounts['GET state scope=overview'], isNull);
    desktop.loseReadSummary = false;

    // The phone leaves before the read's completion reaches it, and the
    // desktop marks the chat unread. The return's state read covers both,
    // so one fresh chat projection shows the desktop's unread.
    final away = recorder.mark();
    desktop
      ..delayReadCompletion = true
      ..reply('Read just before leaving.');
    expect(
      await _waitFor(
        tester,
        () =>
            _present(find.text('Read just before leaving.')) &&
            !desktop.chatUnread,
      ),
      isTrue,
    );
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    // A paused app draws no frames, so wait on the real clock.
    await tester.binding.delayed(const Duration(seconds: 3));
    desktop
      ..delayReadCompletion = false
      ..markUnread()
      ..failStreams(1);
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    expect(await _waitFor(tester, () => _present(unreadDot)), isTrue);
    await tester.pump(const Duration(seconds: 5));
    expect(_present(unreadDot), isTrue);
    final awayCounts = recorder.countsSince(away);
    expect(awayCounts['POST commands portal.chat.mark_read scope=worktree'], 1);
    expect(awayCounts['POST commands portal.state.request scope=chat'], 1);
    desktop.loseReadSummary = true;

    // An older unread summary follows the read's completion, and the read's
    // own summary is lost: one fresh chat projection keeps the read.
    desktop.sendStaleSummaryAfterRead = true;
    final staleSummary = recorder.mark();
    desktop.reply('Read before an older summary.');
    expect(
      await _waitFor(
        tester,
        () =>
            _present(find.text('Read before an older summary.')) &&
            !desktop.chatUnread,
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 10));
    expect(_present(unreadDot), isFalse);
    final staleCounts = recorder.countsSince(staleSummary);
    expect(
      staleCounts['POST commands portal.chat.mark_read scope=worktree'],
      1,
    );
    expect(staleCounts['POST commands portal.state.request scope=chat'], 1);
    expect(staleCounts['GET state scope=overview'], isNull);
    desktop.sendStaleSummaryAfterRead = false;

    // Another client's read and an older unread arrive before the read's
    // completion, and its own summary is lost: one fresh chat projection
    // keeps the read.
    desktop.confirmElsewhereBeforeRead = true;
    final confirmedFirst = recorder.mark();
    desktop.reply('Read after another client.');
    expect(
      await _waitFor(
        tester,
        () =>
            _present(find.text('Read after another client.')) &&
            !desktop.chatUnread,
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 10));
    expect(_present(unreadDot), isFalse);
    final confirmedCounts = recorder.countsSince(confirmedFirst);
    expect(
      confirmedCounts['POST commands portal.chat.mark_read scope=worktree'],
      1,
    );
    expect(confirmedCounts['POST commands portal.state.request scope=chat'], 1);
    expect(confirmedCounts['GET state scope=overview'], isNull);
    desktop
      ..confirmElsewhereBeforeRead = false
      ..loseReadSummary = false;

    // Another client already read the reply, and the server's cache still
    // holds the unread: one fresh chat projection reconciles the declined
    // read, and it is not sent again.
    final elsewhere = recorder.mark();
    desktop.reply('Read on another client.');
    desktop.readElsewhere();
    expect(
      await _waitFor(
        tester,
        () => _present(find.text('Read on another client.')),
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 10));
    expect(_present(unreadDot), isFalse);
    final elsewhereCounts = recorder.countsSince(elsewhere);
    expect(
      elsewhereCounts['POST commands portal.chat.mark_read scope=worktree'],
      1,
    );
    expect(elsewhereCounts['POST commands portal.state.request scope=chat'], 1);
    expect(elsewhereCounts['GET state scope=overview'], isNull);

    // Activity & files: one projection request, one read after its snapshot.
    final drawer = recorder.mark();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    expect(
      await _waitFor(tester, () => _present(find.text('Pin each flow'))),
      isTrue,
    );
    await _settle(tester);
    await tester.tap(find.widgetWithText(Tab, 'Files'));
    expect(
      await _waitFor(
        tester,
        () => _present(
          find.byKey(const ValueKey('changed-file::lib/request_budget.dart')),
        ),
      ),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 2));
    expect(recorder.countsSince(drawer), {
      'requests': 2,
      'event streams': 0,
      'POST commands': 1,
      'POST commands portal.state.request scope=worktree': 1,
      'GET state': 1,
      'GET state scope=worktree': 1,
    });

    // A hook pause: the desktop's hook event flips the toggle.
    await tester.tap(find.widgetWithText(Tab, 'Activity'));
    expect(
      await _waitFor(tester, () => _present(find.byTooltip('Pause hook'))),
      isTrue,
    );
    await _settle(tester);
    final hook = recorder.mark();
    await tester.tap(find.byKey(const ValueKey('hook-toggle-$budgetHookKey')));
    expect(
      await _waitFor(tester, () => _present(find.byTooltip('Resume hook'))),
      isTrue,
    );
    await tester.pump(const Duration(seconds: 3));
    expect(recorder.countsSince(hook)['GET state'], isNull);
    Navigator.of(tester.element(find.byType(Drawer))).pop();
    await tester.pump(const Duration(milliseconds: 500));

    // A new worktree resolves from its completion and delta.
    final create = recorder.mark();
    final createWatch = Stopwatch()..start();
    final created = await viewModel.createWorktree(
      workspaceLocalId: budgetWorkspaceId,
    );
    createWatch.stop();
    expect(created.localId, budgetCreatedWorktreeId);
    expect(createWatch.elapsed, lessThan(const Duration(seconds: 10)));
    await tester.pump(const Duration(seconds: 3));
    final createCounts = recorder.countsSince(create);
    // The create submits without a baseline; no recovery round follows.
    expect(createCounts, {
      'requests': 1,
      'event streams': 0,
      'POST commands': 1,
      'POST commands portal.worktree.create': 1,
    });

    // A clone whose events are lost: one status read once overdue.
    final clone = recorder.mark();
    desktop.loseCloneCompletion = true;
    expect(
      await viewModel.addProject('https://example.test/cloned.git'),
      isNull,
    );
    await tester.pump(const Duration(seconds: 20));
    expect(viewModel.projectClones, hasLength(1));
    expect(recorder.countsSince(clone)['GET commands/:id'], isNull);
    expect(
      await _waitFor(
        tester,
        () => viewModel.projectClones.isEmpty,
        timeout: const Duration(seconds: 30),
      ),
      isTrue,
    );
    expect(recorder.countsSince(clone)['GET commands/:id'], 1);

    expect(desktop.unexpected, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    viewModel.dispose();
    desktop.close();
  });
}
