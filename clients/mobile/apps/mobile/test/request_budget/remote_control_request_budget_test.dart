// Request budgets for Remote Control flows (CAN-4872). Each flow runs
// the real repository, view model and screens against a synthetic Portal
// server, counts the HTTP requests and event-stream connections the client
// sends, and fails when a count rises above its budget. Budgets equal the
// counts measured when the suite was added; lower one when a change removes
// a request. Local only: `flutter test --tags request-budget`. See the
// README.
@Tags(['request-budget'])
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/views/widgets/remote_degraded_banner.dart';

import '../support/remote_request_budget_harness.dart';

void main() {
  testWidgets('F01 cold connect to the first overview', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    fixture.measure('F01 cold connect', fixture.start, const {
      'requests': 3,
      'event streams': 1,
      'GET events/stream': 1,
      'GET session': 1,
      'GET state': 1,
      'GET state scope=overview': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets(
    'F01a cold connect gives foreground work priority over speculation',
    (tester) async {
      final fixture = await RequestBudgetFixture.connect(
        tester,
        prepare: (desktop) {
          desktop.supportsSpeculativeWork = true;
          desktop.overviewRefreshing = true;
          desktop.chatCacheStale = true;
          desktop.holdChatSnapshot();
        },
      );
      final mark = fixture.recorder.mark();
      await fixture.openChat(tester);
      expect(
        fixture.desktop.commands.where(
          (command) =>
              command['type'] == 'portal.app_advisor.settings.get' ||
              (command['type'] == 'portal.state.request' &&
                  (command['payload'] as Map<String, dynamic>)['scope'] !=
                      'chat'),
        ),
        isEmpty,
      );
      expect(fixture.desktop.releaseChatSnapshot(), 1);
      await fixture.settle(tester);
      fixture.measure('F01a deferred speculation', mark, const {
        'requests': 6,
        'event streams': 0,
        'GET state': 1,
        'GET state scope=chat': 1,
        'POST commands': 5,
        'POST commands portal.pr.action action=get_actions': 1,
        'POST commands portal.state.request scope=chat': 1,
        'POST commands portal.state.request scope=app_advisor': 1,
        'POST commands portal.state.request scope=worktree_chat_summaries': 1,
        'POST commands portal.app_advisor.settings.get': 1,
      });
      expect(fixture.overBudget, isEmpty);
      expect(
        fixture.desktop.commands.where(
          (command) => command['type'] == 'portal.app_advisor.settings.get',
        ),
        hasLength(1),
      );
      await fixture.dispose(tester);
    },
  );

  testWidgets('F02a current server tail opens without a desktop snapshot', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    final mark = fixture.recorder.mark();
    await fixture.openChat(tester);
    fixture.measure('F02a current cached tail', mark, const {
      'requests': 2,
      'event streams': 0,
      'GET state': 1,
      'POST commands': 1,
      'POST commands portal.pr.action action=get_actions': 1,
      'POST commands portal.state.request scope=chat': 0,
      'GET state scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    fixture.desktop.reply('Live output after the cached tail.');
    await fixture.settle(tester);
    expect(find.text('Live output after the cached tail.'), findsOneWidget);
    await fixture.dispose(tester);
  });

  testWidgets('F02c a revised earlier row keeps the completed snapshot order', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(
      tester,
      prepare: (desktop) {
        desktop.messages
          ..clear()
          ..addAll([
            {
              'messageId': 'early',
              'chatId': budgetChatId,
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'text': 'Earlier block revised',
              'createdAtMs': 1000,
            },
            {
              'messageId': 'last',
              'chatId': budgetChatId,
              'scope': 'worktree',
              'role': 'assistant',
              'status': 'complete',
              'text': 'Final answer',
              'createdAtMs': 2000,
            },
          ]);
        desktop.cachedChatRows = [
          {
            'localMessageId': 'last',
            'localChatId': budgetChatId,
            'scope': 'worktree',
            'role': 'assistant',
            'status': 'complete',
            'content': 'Final answer',
            'occurredAt': '2026-01-01T00:00:02Z',
          },
          {
            'localMessageId': 'early',
            'localChatId': budgetChatId,
            'scope': 'worktree',
            'role': 'assistant',
            'status': 'complete',
            'content': 'Earlier block revised',
            'occurredAt': '2026-01-01T00:00:03Z',
          },
        ];
      },
    );
    await tester.tap(find.text(budgetWorkspaceName));
    await tester.pump();
    await tester.tap(find.text('koala'));
    await fixture.settle(tester);
    expect(
      fixture.viewModel
          .messagesFor(
            const RemoteWorktreeChatTarget(
              workspaceLocalId: budgetWorkspaceId,
              worktreeLocalId: 'wt-1',
              chatId: budgetChatId,
            ),
          )
          .map((row) => row.messageId),
      ['early', 'last'],
    );
    await fixture.dispose(tester);
  });

  testWidgets('F02b a missing server tail requests the desktop snapshot', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(
      tester,
      prepare: (desktop) {
        desktop.chatCacheMissing = true;
      },
    );
    await fixture.openChat(tester);
    expect(
      fixture.desktop.commands.where(
        (command) =>
            command['type'] == 'portal.state.request' &&
            (command['payload'] as Map<String, dynamic>)['scope'] == 'chat',
      ),
      hasLength(1),
    );
    await fixture.dispose(tester);
  });

  testWidgets('F02 open a worktree chat cold, then warm', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    final cold = fixture.recorder.mark();
    // The desktop answers after the server's cached chat state, so the
    // transcript openChat waits for comes from that cache.
    fixture.desktop.chatCacheStale = true;
    fixture.desktop.holdChatSnapshot();
    await fixture.openChat(tester);
    expect(fixture.desktop.releaseChatSnapshot(), 1);
    await fixture.settle(tester);
    fixture.measure('F02 cold chat open', cold, const {
      'requests': 3,
      'event streams': 0,
      'GET state': 1,
      'GET state scope=chat': 1,
      'POST commands': 2,
      'POST commands portal.pr.action action=get_actions': 1,
      'POST commands portal.state.request scope=chat': 1,
    });
    final back = fixture.recorder.mark();
    await fixture.closeChat(tester);
    fixture.measure('F02 back to the overview', back, const {
      'requests': 0,
      'event streams': 0,
    });
    final warm = fixture.recorder.mark();
    await fixture.openChat(tester);
    fixture.measure('F02 warm chat open', warm, const {
      'requests': 1,
      'event streams': 0,
      'POST commands': 1,
      'POST commands portal.pr.action action=get_actions': 1,
    });
    fixture.measure('F02 total', cold, const {
      'requests': 4,
      'event streams': 0,
      'GET state': 1,
      'GET state scope=chat': 1,
      'POST commands': 3,
      'POST commands portal.pr.action action=get_actions': 2,
      'POST commands portal.state.request scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F03 open the Activity & files drawer', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await fixture.settle(tester);
    expect(find.text('Pin each flow'), findsOneWidget);
    await tester.tap(find.text('Files'));
    await fixture.settle(tester);
    expect(
      find.byKey(const ValueKey('changed-file::lib/request_budget.dart')),
      findsOneWidget,
    );
    // CAN-4875: one projection request, then one read after its snapshot.
    fixture.measure('F03 activity drawer', mark, const {
      'requests': 2,
      'event streams': 0,
      'GET state': 1,
      'GET state scope=worktree': 1,
      'POST commands': 1,
      'POST commands portal.state.request scope=worktree': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F03a roster revision hit revalidates same-size edits', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await fixture.settle(tester);
    await tester.tap(find.text('Files'));
    await fixture.settle(tester);
    final file = find.byKey(
      const ValueKey('changed-file::lib/request_budget.dart'),
    );
    final first = fixture.recorder.mark();
    await tester.tap(file);
    await fixture.settle(tester);
    expect(find.text('+new'), findsOneWidget);
    fixture.measure('F03a first diff', first, const {
      'requests': 1,
      'event streams': 0,
      'POST diff/read': 1,
    });
    await tester.pageBack();
    await fixture.settle(tester);
    final reopen = fixture.recorder.mark();
    fixture.desktop.diffPatch = '@@ -1 +1 @@\n-old\n+now\n';
    await tester.tap(file);
    await fixture.settle(tester);
    expect(find.text('+now'), findsOneWidget);
    fixture.measure('F03a revision cache hit', reopen, const {
      'requests': 1,
      'event streams': 0,
      'POST diff/read': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F04 background, then foreground after one minute', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    final mark = fixture.recorder.mark();
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await fixture.advance(tester, const Duration(minutes: 1));
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await fixture.settle(tester);
    expect(find.text(budgetWorkspaceName), findsOneWidget);
    expect(find.byType(RemoteDegradedBanner), findsNothing);
    fixture.measure('F04 background one minute', mark, const {
      'requests': 3,
      'event streams': 1,
      'GET events/stream': 1,
      'GET session': 1,
      'GET state': 1,
      'GET state scope=overview': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F05 desktop inactive for two minutes on the Remote tab', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    final mark = fixture.recorder.mark();
    fixture.desktop.sleep();
    await fixture.advance(tester, const Duration(minutes: 2));
    expect(find.text(budgetWorkspaceName), findsOneWidget);
    expect(find.byType(RemoteDegradedBanner), findsOneWidget);
    fixture.measure('F05 desktop inactive', mark, const {
      'requests': 6,
      'event streams': 5,
      'GET events/stream': 5,
      'GET session': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F06 legacy desktop retains PR compatibility polling', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    await fixture.advance(
      tester,
      const Duration(minutes: 5),
      step: const Duration(seconds: 1),
    );
    expect(find.text(fixture.desktop.lastMessageText), findsOneWidget);
    fixture.measure('F06 idle chat', mark, const {
      'requests': 5,
      'event streams': 0,
      'POST commands': 5,
      'POST commands portal.pr.action action=get_actions': 5,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F06 push-capable desktop needs no idle PR reads', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(
      tester,
      prepare: (desktop) => desktop.pushesPrStatus = true,
    );
    final openMark = fixture.recorder.mark();
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    await fixture.advance(tester, const Duration(minutes: 5));
    fixture.measure('F06 pushed PR state', mark, const {
      'requests': 0,
      'event streams': 0,
    });
    expect(
      fixture.recorder.countsSince(
        openMark,
      )['POST commands portal.pr.action action=get_actions'],
      1,
    );
    expect(fixture.overBudget, isEmpty);
    fixture.desktop.sleep();
    final inactiveMark = fixture.recorder.mark();
    await fixture.advance(tester, const Duration(minutes: 2));
    expect(
      fixture.recorder.countsSince(
        inactiveMark,
      )['POST commands portal.pr.action action=get_actions'],
      isNull,
    );
    expect(tester.takeException(), isNull);
    await fixture.dispose(tester);
  });

  testWidgets('F07 send a message and mark the chat read', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    await tester.enterText(
      find.byKey(const ValueKey('composer-draft')),
      'Lower the overview reads.',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('composer-send')));
    await fixture.settle(tester);
    fixture.desktop.reply('The overview now reads once.');
    await fixture.settle(tester);
    expect(find.text('Lower the overview reads.'), findsOneWidget);
    expect(find.text('The overview now reads once.'), findsOneWidget);
    final markRead = fixture.desktop.commands.lastWhere(
      (command) => command['type'] == 'portal.chat.mark_read',
    );
    expect(markRead['payload'], containsPair('chatId', budgetChatId));
    expect(
      markRead['payload'],
      containsPair('lastMessageId', fixture.desktop.messages.last['messageId']),
    );
    expect(fixture.desktop.chatUnread, isFalse);
    // CAN-4875: the read settles on its completion, with no overview read.
    fixture.measure('F07 send and read', mark, const {
      'requests': 2,
      'event streams': 0,
      'POST commands': 2,
      'POST commands portal.chat.mark_read scope=worktree': 1,
      'POST commands portal.chat.send': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F07b mark a chat read that another client read', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    fixture.desktop.reply('Another client read this.');
    fixture.desktop.readElsewhere();
    await fixture.settle(tester);
    // Spans several retry intervals, before the periodic PR refresh.
    await fixture.advance(tester, const Duration(seconds: 40));
    expect(find.text('Another client read this.'), findsOneWidget);
    expect(fixture.desktop.chatUnread, isFalse);
    // CAN-4875: the desktop declines the read without a summary delta, and
    // the server's state cache still holds the unread. One fresh chat
    // projection reconciles it; the read is not sent again.
    fixture.measure('F07b read elsewhere', mark, const {
      'requests': 2,
      'event streams': 0,
      'POST commands': 2,
      'POST commands portal.chat.mark_read scope=worktree': 1,
      'POST commands portal.state.request scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F07c mark a chat read whose summary is late and lost', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    fixture.desktop
      ..loseReadSummary = true
      ..sendStaleSummaryAfterRead = true;
    final mark = fixture.recorder.mark();
    fixture.desktop.reply('Read before an older summary.');
    await fixture.settle(tester);
    await fixture.advance(tester, const Duration(seconds: 40));
    expect(find.text('Read before an older summary.'), findsOneWidget);
    expect(fixture.desktop.chatUnread, isFalse);
    expect(find.byKey(const ValueKey('chat-tabs-unread')), findsNothing);
    // CAN-4875: an older unread follows the completion in its own batch, and
    // the read's summary is lost. One fresh chat projection settles the read.
    fixture.measure('F07c late and lost summary', mark, const {
      'requests': 2,
      'event streams': 0,
      'POST commands': 2,
      'POST commands portal.chat.mark_read scope=worktree': 1,
      'POST commands portal.state.request scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    // The settled read yields to a later desktop unread of the same output.
    fixture.desktop.markUnread();
    await fixture.settle(tester);
    expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);
    await fixture.dispose(tester);
  });

  testWidgets('F07d mark a chat read that another client confirmed first', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    fixture.desktop
      ..loseReadSummary = true
      ..confirmElsewhereBeforeRead = true;
    final mark = fixture.recorder.mark();
    fixture.desktop.reply('Read after another client.');
    await fixture.settle(tester);
    await fixture.advance(tester, const Duration(seconds: 40));
    expect(find.text('Read after another client.'), findsOneWidget);
    expect(fixture.desktop.chatUnread, isFalse);
    expect(find.byKey(const ValueKey('chat-tabs-unread')), findsNothing);
    // CAN-4875: another client's read and an older unread arrive before the
    // read's completion, and its summary is lost. One fresh chat projection
    // settles the read.
    fixture.measure('F07d confirmed elsewhere first', mark, const {
      'requests': 2,
      'event streams': 0,
      'POST commands': 2,
      'POST commands portal.chat.mark_read scope=worktree': 1,
      'POST commands portal.state.request scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    // The settled read yields to a later desktop unread of the same output.
    fixture.desktop
      ..confirmElsewhereBeforeRead = false
      ..markUnread();
    await fixture.settle(tester);
    expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);
    await fixture.dispose(tester);
  });

  testWidgets('F07e return after the desktop marks a just-read chat unread', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    final mark = fixture.recorder.mark();
    fixture.desktop
      ..delayReadCompletion = true
      ..reply('Read just before leaving.');
    // The phone leaves once the desktop accepts the read, before the read's
    // completion and summary reach it.
    await fixture.advance(tester, const Duration(milliseconds: 500));
    expect(fixture.desktop.chatUnread, isFalse);
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await fixture.advance(tester, const Duration(seconds: 3));
    fixture.desktop
      ..delayReadCompletion = false
      ..markUnread();
    await fixture.advance(tester, const Duration(seconds: 40));
    // The first stream after the return fails, as on a network change, so
    // the return's state read lands before the replayed events.
    fixture.desktop.failStreams(1);
    for (final state in const [
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await fixture.settle(tester);
    await fixture.advance(tester, const Duration(seconds: 40));
    expect(find.text('Read just before leaving.'), findsOneWidget);
    expect(fixture.desktop.chatUnread, isTrue);
    expect(find.byKey(const ValueKey('chat-tabs-unread')), findsOneWidget);
    // CAN-4875: the return's state read covers the read's completion, its
    // summary and the desktop's unread, so only the completion reaches the
    // receipt. One fresh chat projection shows the desktop's unread.
    fixture.measure('F07e unread while away', mark, const {
      'requests': 7,
      'event streams': 2,
      'GET events/stream': 2,
      'GET session': 1,
      'GET state': 1,
      'GET state scope=overview': 1,
      'POST commands': 3,
      'POST commands portal.chat.mark_read scope=worktree': 1,
      'POST commands portal.pr.action action=get_actions': 1,
      'POST commands portal.state.request scope=chat': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F08 desktop wakes after two minutes inactive', (tester) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    fixture.desktop.sleep();
    await fixture.advance(tester, const Duration(minutes: 2));
    final mark = fixture.recorder.mark();
    fixture.desktop.wake();
    var waited = Duration.zero;
    while (find.byType(RemoteDegradedBanner).evaluate().isNotEmpty &&
        waited < const Duration(minutes: 2)) {
      await fixture.advance(tester, const Duration(seconds: 1));
      waited += const Duration(seconds: 1);
    }
    // ignore: avoid_print
    print('RECONNECT_AFTER_WAKE ${waited.inSeconds}s');
    // The next attempt comes within one capped backoff step.
    expect(waited, lessThanOrEqualTo(const Duration(seconds: 60)));
    fixture.measure('F08 desktop wakes', mark, const {
      'requests': 1,
      'event streams': 1,
      'GET events/stream': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  testWidgets('F09 two failed reconnects during a network blip', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    // The stream has been healthy for a while when the network changes.
    await fixture.advance(tester, const Duration(seconds: 10));
    final mark = fixture.recorder.mark();
    fixture.desktop.failStreams(2);
    // The network change drops the open stream.
    fixture.desktop.close();
    await fixture.advance(tester, const Duration(seconds: 15));
    fixture.desktop.reply('Back on the live stream.');
    await fixture.settle(tester);
    final streams = [
      for (final request in fixture.recorder.requestsSince(mark))
        if (request.opensEventStream) request.key,
    ];
    // Back on SSE after two failures, with no long-poll.
    expect(streams, List.filled(3, 'GET events/stream'));
    expect(find.byType(RemoteDegradedBanner), findsNothing);
    fixture.measure('F09 network blip', mark, const {
      'requests': 3,
      'event streams': 3,
      'GET events/stream': 3,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  // CAN-4874: a working standalone chat sends its row every five seconds.
  // The client applies each row itself instead of re-reading the overview.
  testWidgets('F10 idle five minutes with an active standalone chat', (
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
      const Duration(minutes: 5),
      step: const Duration(seconds: 1),
    );
    fixture.desktop.stopStandaloneActivity();
    // ignore: avoid_print
    print('STANDALONE_DELTAS ${fixture.desktop.standaloneDeltas}');
    fixture.measure('F10 idle active standalone chat', mark, const {
      'requests': 0,
      'event streams': 0,
    });
    expect(fixture.desktop.standaloneDeltas, 60);
    expect(
      fixture.viewModel
          .standaloneChatById(budgetStandaloneChatId)
          ?.lastMessageAt,
      fixture.desktop.standaloneLastMessageAt,
    );
    expect(find.text(budgetStandaloneTitle), findsOneWidget);
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  // CAN-4875: the desktop's hook event updates the toggle, so the pause
  // needs no overview read.
  testWidgets('F11 pause a hook in the Activity & files drawer', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    await fixture.openChat(tester);
    await tester.tap(find.byKey(const ValueKey('open-activity')));
    await fixture.settle(tester);
    expect(find.byTooltip('Pause hook'), findsOneWidget);
    final mark = fixture.recorder.mark();
    await tester.tap(find.byKey(const ValueKey('hook-toggle-$budgetHookKey')));
    await fixture.settle(tester);
    expect(fixture.desktop.hookPaused, isTrue);
    expect(find.byTooltip('Resume hook'), findsOneWidget);
    fixture.measure('F11 hook pause', mark, const {
      'requests': 1,
      'event streams': 0,
      'POST commands': 1,
      'POST commands portal.hook.pause': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  // CAN-4875: the completion and the worktree delta settle the create, so
  // no projection round follows the submit. The create sends no baseline.
  testWidgets('F12 create a worktree whose completion arrives on time', (
    tester,
  ) async {
    final fixture = await RequestBudgetFixture.connect(tester);
    final mark = fixture.recorder.mark();
    String? created;
    unawaited(
      fixture.viewModel
          .createWorktree(workspaceLocalId: budgetWorkspaceId)
          .then((worktree) => created = worktree.localId),
    );
    await fixture.settle(tester);
    expect(created, budgetCreatedWorktreeId);
    expect(fixture.viewModel.isCreatingWorktree, isFalse);
    fixture.measure('F12 worktree create', mark, const {
      'requests': 1,
      'event streams': 0,
      'POST commands': 1,
      'POST commands portal.worktree.create': 1,
    });
    expect(fixture.overBudget, isEmpty);
    await fixture.dispose(tester);
  });

  // CAN-4875: a clone settles on its completion event. Status reads start
  // only once that event is overdue.
  for (final lost in [false, true]) {
    testWidgets(
      'F13 clone a project${lost ? ' whose completion is lost' : ''}',
      (tester) async {
        final fixture = await RequestBudgetFixture.connect(tester);
        fixture.desktop.loseCloneCompletion = lost;
        final mark = fixture.recorder.mark();
        expect(
          await fixture.viewModel.addProject('https://example.test/cloned.git'),
          isNull,
        );
        await fixture.settle(tester);
        if (lost) {
          // Still cloning as far as the phone knows, with no status read yet.
          expect(fixture.viewModel.projectClones, hasLength(1));
          expect(
            fixture.recorder.countsSince(mark)['GET commands/:id'],
            isNull,
          );
          // The read 30 seconds after the submit finds the clone completed.
          await fixture.advance(tester, const Duration(seconds: 30));
        }
        fixture.measure(
          lost ? 'F13 clone, lost completion' : 'F13 clone',
          mark,
          lost
              ? const {
                  'requests': 4,
                  'event streams': 0,
                  'GET commands/:id': 1,
                  'GET state': 1,
                  'GET state scope=overview': 1,
                  'POST commands': 2,
                  'POST commands portal.state.request scope=overview': 1,
                  'POST commands portal.workspace.create': 1,
                }
              : const {
                  'requests': 1,
                  'event streams': 0,
                  'POST commands': 1,
                  'POST commands portal.workspace.create': 1,
                },
        );
        expect(fixture.viewModel.projectClones, isEmpty);
        expect(find.text(budgetClonedWorkspaceName), findsOneWidget);
        expect(fixture.overBudget, isEmpty);
        await fixture.dispose(tester);
      },
    );
  }
}
