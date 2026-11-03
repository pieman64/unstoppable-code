// CAN-4874 — device flow for shell deltas the client applies locally. Run
// from apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_4874_shell_deltas_device_test.dart \
//     -d <device-id>
//
// The production Remote Control repository talks to synthetic Portal
// servers. The long-poll flow mounts the authenticated shell over
// `shell_delta_shell.dart`: cursored standalone chat, worktree and chat tab
// deltas must reach the sidebar, Recents and Needs attention without an
// overview read, and the rows must survive a reconnect. The SSE flow keeps a
// standalone chat working on the request-budget desktop and checks that its
// rows bring no overview read. No real account, desktop or network is
// involved.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/support/portal_request_recorder.dart';
import '../test/support/remote_request_budget_harness.dart';
import '../test/support/shell_delta_shell.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async => (await SharedPreferences.getInstance()).clear());

  Future<void> settle(WidgetTester tester, [int frames = 6]) async {
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  Finder inWorkspace(String id, String text) => find.descendant(
    of: find.byKey(ValueKey('workspace-$id')),
    matching: find.text(text),
  );

  testWidgets('CAN-4874 long-poll deltas update the shell without a read', (
    tester,
  ) async {
    final desktop = ShellDeltaDesktop();
    final remote = await pumpShellDeltaShell(
      tester,
      desktop: desktop,
      themeMode: ThemeMode.light,
    );
    await tester.tap(inWorkspace('ws-cowork', shellDeltaCoworkName));
    await settle(tester);
    await tester.tap(inWorkspace('ws-1', 'Repository'));
    await settle(tester);
    expect(find.text('Plan launch'), findsOneWidget);
    expect(find.text('Write notes'), findsOneWidget);
    expect(find.text('lynx'), findsOneWidget);
    expect(
      find.byKey(const ValueKey('attention-row-ws-1-wt-1')),
      findsOneWidget,
    );
    final reads = desktop.stateReads;

    desktop.pushShellDeltas([
      {
        'scope': 'standalone_chat',
        'entities': [
          shellDeltaChat(
            'sc-1',
            title: 'Plan launch, revised',
            active: true,
            lastMessageAt: '2026-10-25T10:05:00.000Z',
          ),
          shellDeltaChat(
            'sc-3',
            title: 'Draft brief',
            lastMessageAt: '2026-10-25T09:30:00.000Z',
          ),
        ],
      },
      {
        'scope': 'standalone_chat',
        'removed': [
          {
            'entityType': 'standalone_chat',
            'localId': 'sc-2',
            'parentLocalId': 'ws-cowork',
          },
        ],
      },
      {
        'scope': 'worktree',
        'removed': [
          {
            'entityType': 'worktree',
            'localId': 'wt-2',
            'parentLocalId': 'ws-1',
          },
        ],
      },
    ]);
    await settle(tester, 10);
    expect(find.text('Plan launch, revised'), findsOneWidget);
    expect(find.text('Draft brief'), findsOneWidget);
    expect(find.text('Write notes'), findsNothing);
    expect(find.text('lynx'), findsNothing);
    // Needs attention keeps its row.
    expect(
      find.byKey(const ValueKey('attention-row-ws-1-wt-1')),
      findsOneWidget,
    );
    // Past the 30-second delta refresh interval: no overview read follows.
    for (var i = 0; i < 32; i++) {
      await tester.pump(const Duration(seconds: 1));
    }
    expect(desktop.stateReads, reads);

    // Recents lists the standalone chats newest first, without the removed
    // one, and the unread worktree tab after them.
    await tester.tap(find.byTooltip('Open navigation menu').first);
    await settle(tester);
    final recents = [
      'home-recent-remote-standalone-sc-1',
      'home-recent-remote-standalone-sc-3',
    ];
    final tops = [
      for (final key in recents)
        tester.getTopLeft(find.byKey(ValueKey(key))).dy,
    ];
    expect(tops.first, lessThan(tops.last));
    expect(
      find.byKey(const ValueKey('home-recent-remote-standalone-sc-2')),
      findsNothing,
    );
    await tester.tap(find.byKey(const ValueKey('home-nav-remote')));
    await settle(tester);

    // The phone loses the server; the reconnect recovers the same rows, and
    // the next delta applies on the recovered stream.
    desktop.server.dropDelivery();
    await settle(tester, 4);
    desktop.server.restoreDelivery();
    await settle(tester, 20);
    desktop.server.answerIdle(shellDeltaSessionId);
    await settle(tester, 10);
    expect(find.text('Plan launch, revised'), findsOneWidget);
    expect(find.text('Write notes'), findsNothing);
    final afterReconnect = desktop.stateReads;
    desktop.pushShellDeltas([
      {
        'scope': 'standalone_chat',
        'entities': [
          shellDeltaChat(
            'sc-3',
            title: 'Draft brief, final',
            lastMessageAt: '2026-10-25T10:10:00.000Z',
          ),
        ],
      },
    ]);
    await settle(tester, 10);
    expect(find.text('Draft brief, final'), findsOneWidget);
    expect(desktop.stateReads, afterReconnect);
    expect(remote.isConnected, isTrue);
    expect(tester.takeException(), isNull);
    await unmountShellDeltaShell(tester, desktop, remote);
  });

  testWidgets('CAN-4874 SSE standalone activity brings no overview read', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(
      tester,
      prepare: (desktop) => desktop.addStandaloneChat(),
    );
    expect(find.text(budgetStandaloneTitle), findsOneWidget);
    final mark = fixture.recorder.mark();
    fixture.desktop.startStandaloneActivity();
    await fixture.advance(
      tester,
      const Duration(seconds: 21),
      step: const Duration(seconds: 1),
    );
    fixture.desktop.stopStandaloneActivity();
    final counts = fixture.recorder.countsSince(mark);
    expect(fixture.desktop.standaloneDeltas, greaterThanOrEqualTo(4));
    expect(counts[kRequestsKey], 0, reason: '$counts');
    expect(
      fixture.viewModel
          .standaloneChatById(budgetStandaloneChatId)
          ?.lastMessageAt,
      fixture.desktop.standaloneLastMessageAt,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    fixture.viewModel.dispose();
    fixture.desktop.close();
    await settle(tester, 2);
  });
}
