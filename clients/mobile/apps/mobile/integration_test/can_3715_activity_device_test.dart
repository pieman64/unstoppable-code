// CAN-3715 — device verification of Activity's Personal context, sharing
// guidance, Remote Control prompt, refresh and pagination. Run from
// apps/mobile with:
//
//   flutter drive --driver=test_driver/integration_test.dart \
//     --target=integration_test/can_3715_activity_device_test.dart \
//     -d <device-id>
//
// The shell is composed from the production provider builders with synthetic
// feed and Remote Control repositories (`can_3715_activity_fixture.dart`). It
// covers the phone's side only: no login, Firebase, desktop or server data.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_card.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/remote/views/widgets/connect_desktop_view.dart';
import 'package:provider/provider.dart';

import '../test/support/can_3715_activity_fixture.dart';
import '../test/support/fake_remote_control_repository.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  const privateEvidence = FeedSharingStatus(
    metadata: FeedSharingState.private,
    plans: FeedSharingState.unknown,
    summaries: FeedSharingState.unknown,
  );

  Future<
    ({
      AuthViewModel auth,
      Can3715FeedRepository team,
      Can3715FeedRepository personal,
    })
  >
  pumpShell(WidgetTester tester) async {
    late AuthViewModel auth;
    await tester.runAsync(() async => auth = await can3715Auth());
    final team = Can3715FeedRepository(
      personal: false,
      sharing: privateEvidence,
    );
    final personal = Can3715FeedRepository(personal: true);
    await tester.pumpWidget(
      Can3715Shell(
        auth: auth,
        teamFeed: team,
        personalFeed: personal,
        remote: FakeRemoteControlRepository(),
      ),
    );
    await tester.pumpAndSettle();
    return (auth: auth, team: team, personal: personal);
  }

  HomeTabController tabsOf(WidgetTester tester) =>
      Provider.of<HomeTabController>(
        tester.element(find.byType(Scaffold).first),
        listen: false,
      );

  testWidgets('stale team Activity explains sharing and opens Personal', (
    tester,
  ) async {
    final shell = await pumpShell(tester);

    expect(find.text('Worktree updated · feature/org-work-0'), findsOneWidget);
    expect(find.textContaining('Share your work in the feed.'), findsOneWidget);

    await tester.tap(find.text('View Personal'));
    await tester.pumpAndSettle();

    expect(shell.auth.isPersonalActive, isTrue);
    expect(find.text('Worktree updated · personal/work-0'), findsOneWidget);
    expect(find.text('Worktree updated · feature/org-work-0'), findsNothing);
    expect(find.textContaining('Share your work'), findsNothing);
    expect(shell.personal.cursors, [null]);

    // Personal has no member filter.
    await tester.tap(find.byTooltip('Filter activity'));
    await tester.pumpAndSettle();
    expect(find.text('All members'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the Remote Control prompt opens the connection steps', (
    tester,
  ) async {
    await pumpShell(tester);

    expect(
      find.text('Connect Remote Control to open chats from notifications.'),
      findsOneWidget,
    );
    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(tabsOf(tester).value, HomeTab.remote);
    expect(find.byType(ConnectDesktopView), findsOneWidget);
  });

  testWidgets('Load more reaches older work and stops at the last page', (
    tester,
  ) async {
    final shell = await pumpShell(tester);

    await tester.scrollUntilVisible(
      find.text('Load more'),
      400,
      scrollable: find.byType(Scrollable).last,
    );
    // The last scroll jumps the list; lay it out before the tap.
    await tester.pump();
    await tester.tap(find.text('Load more'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-work-34'),
      400,
      scrollable: find.byType(Scrollable).last,
    );

    expect(shell.team.cursors, [null, 'team-29']);
    expect(find.text('Load more'), findsNothing);

    // New work lands while the reader is on the second page. Resume and the
    // push fallback reload Activity without moving the reader's rows.
    final list = find.byType(Scrollable).last;
    await tester.drag(list, const Offset(0, -4000));
    await tester.pumpAndSettle();
    final anchor = find
        .text('Worktree updated · feature/org-work-31')
        .hitTestable();
    expect(anchor, findsOneWidget);
    final place = tester.getTopLeft(anchor);
    shell.team.newer = 1;
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    tabsOf(tester).select(HomeTab.activity);
    await tester.pumpAndSettle();

    // Each refresh reads again down to the last read row, team-34.
    expect(shell.team.cursors, [
      null,
      'team-29',
      ...[null, 'team-28', 'team-33'],
      ...[null, 'team-28', 'team-33'],
    ]);
    expect(tester.getTopLeft(anchor), place);

    // More new work than a page lands: the refresh reads the new work and
    // the reader's rows.
    shell.team.newer = 40;
    tabsOf(tester).select(HomeTab.activity);
    await tester.pumpAndSettle();

    expect(shell.team.cursors.skip(8), [
      null,
      'team-new-10',
      'team-new-5',
      'team-new-0',
      for (var i = 4; i < 34; i += 5) 'team-$i',
    ]);
    expect(tester.getTopLeft(anchor), place);
    expect(find.text('Load more'), findsNothing);

    // The reader moves up from the end of the list. The updated row
    // leaves the end, which shortens the list without clamping the scroll.
    await tester.drag(list, const Offset(0, 250));
    await tester.pumpAndSettle();
    final held = tester.getTopLeft(anchor);

    // The oldest read row is updated and moves to the top under the same ID.
    // No unchanged row marks the read depth any more, so the refresh reads
    // to the end and keeps every read row.
    shell.team.updated.add('team-34');
    tabsOf(tester).select(HomeTab.activity);
    await tester.pumpAndSettle();

    expect(shell.team.cursors.skip(18), [
      null,
      'team-new-11',
      'team-new-6',
      'team-new-1',
      for (var i = 3; i < 33; i += 5) 'team-$i',
    ]);
    expect(tester.getTopLeft(anchor), held);
    expect(find.text('Load more'), findsNothing);

    // Rows sync late with event times just below the newest read row. A
    // resume and then a reselect show them without moving the reader.
    shell.team.lateBelow = 'team-0';
    shell.team.late = 3;
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(anchor), held);
    shell.team.late = 30;
    tabsOf(tester).select(HomeTab.activity);
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(anchor), held);
    expect(find.text('Load more'), findsNothing);
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-late-29'),
      -400,
      scrollable: list,
    );
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-late-0'),
      -400,
      scrollable: list,
    );
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-new-0'),
      -400,
      scrollable: list,
    );
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-new-39'),
      -400,
      scrollable: list,
    );
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-work-34'),
      -400,
      scrollable: list,
    );
    await tester.scrollUntilVisible(
      find.text('Worktree updated · feature/org-work-33'),
      400,
      scrollable: list,
    );
    expect(find.text('Load more'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Activity stops at its last row before and after Load more', (
    tester,
  ) async {
    final shell = await pumpShell(tester);
    final list = find.byType(Scrollable).last;
    final loadMore = find.byKey(const ValueKey('feed-load-more'));
    double cardBottom(String id) => tester
        .getBottomLeft(
          find.byWidgetPredicate(
            (w) => w is FeedCard && w.item.id == id,
            skipOffstage: false,
          ),
        )
        .dy;
    // Scroll offsets at a fractional device pixel ratio differ by about
    // 1e-13 logical pixels; the ends must match well below a device pixel.
    const endEpsilon = 1e-6;

    // One drag from the top reaches the Load more footer at the end. Each
    // scroll end moves the start of the scroll offsets to the reader's row;
    // later drags stop at the same place.
    await tester.drag(list, const Offset(0, -6000));
    await tester.pumpAndSettle();
    final footer = tester.getBottomLeft(loadMore).dy;
    expect(footer, lessThanOrEqualTo(tester.getRect(list).bottom));
    for (final dy in const [-300.0, -90.0, -40.0, -600.0]) {
      await tester.drag(list, Offset(0, dy));
      await tester.pumpAndSettle();
      expect(
        tester.getBottomLeft(loadMore).dy,
        moreOrLessEquals(footer, epsilon: endEpsilon),
        reason: 'drag $dy',
      );
    }

    await tester.tap(loadMore);
    await tester.pumpAndSettle();
    expect(shell.team.cursors, [null, 'team-29']);

    // The reader drags on to the new end in steps, then on past it.
    for (var step = 0; step < 3; step++) {
      await tester.drag(list, const Offset(0, -300));
      await tester.pumpAndSettle();
    }
    final ends = [cardBottom('team-34')];
    for (final dy in const [-90.0, -40.0, -600.0]) {
      await tester.drag(list, Offset(0, dy));
      await tester.pumpAndSettle();
      ends.add(cardBottom('team-34'));
    }
    // The reader moves up a little, then drags back to the end in steps.
    await tester.drag(list, const Offset(0, 250));
    await tester.pumpAndSettle();
    expect(cardBottom('team-34'), greaterThan(ends.first));
    for (var step = 0; step < 6; step++) {
      await tester.drag(list, const Offset(0, -100));
      await tester.pumpAndSettle();
    }
    ends.add(cardBottom('team-34'));

    // Back at the top, one drag reaches the same end.
    await tester.drag(list, const Offset(0, 8000));
    await tester.pumpAndSettle();
    expect(
      find.text('Worktree updated · feature/org-work-0').hitTestable(),
      findsOneWidget,
    );
    await tester.drag(list, const Offset(0, -8000));
    await tester.pumpAndSettle();
    expect(
      ends,
      everyElement(
        moreOrLessEquals(cardBottom('team-34'), epsilon: endEpsilon),
      ),
    );
    expect(loadMore, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a reader on rows that an earlier refresh added keeps its '
      'place', (tester) async {
    final shell = await pumpShell(tester);
    final list = find.byType(Scrollable).last;
    void resume() {
      for (final state in const [
        AppLifecycleState.inactive,
        AppLifecycleState.hidden,
        AppLifecycleState.paused,
        AppLifecycleState.hidden,
        AppLifecycleState.inactive,
        AppLifecycleState.resumed,
      ]) {
        tester.binding.handleAppLifecycleStateChanged(state);
      }
    }

    // Pumps frames until the screen settles; in each one, the reader's row
    // is still at its place.
    Future<void> settleHolding(Finder row, Offset place) async {
      for (var frame = 0; frame < 600; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        expect(tester.getTopLeft(row), place, reason: 'frame $frame');
        if (!tester.binding.hasScheduledFrame) return;
      }
      fail('the screen did not settle');
    }

    // Twenty rows land while the reader is at the top: they show first.
    shell.team.newer = 20;
    resume();
    await tester.pumpAndSettle();
    expect(
      find.text('Worktree updated · feature/org-new-19').hitTestable(),
      findsOneWidget,
    );

    // The reader moves into those rows, to about a third down the list.
    final reader = find.text('Worktree updated · feature/org-new-8');
    await tester.scrollUntilVisible(reader, 100, scrollable: list);
    await tester.pumpAndSettle();
    final view = tester.getRect(list);
    await tester.drag(
      list,
      Offset(0, view.top + view.height / 3 - tester.getTopLeft(reader).dy),
    );
    await tester.pumpAndSettle();
    expect(reader.hitTestable(), findsOneWidget);
    final place = tester.getTopLeft(reader);

    // Two more rows land above, then Activity is reselected.
    shell.team.newer = 22;
    tabsOf(tester).select(HomeTab.activity);
    await settleHolding(reader, place);
    expect(shell.team.cursors, [
      null,
      ...[null, 'team-9', 'team-14', 'team-19', 'team-24'],
      ...[null, 'team-7', 'team-12', 'team-17', 'team-22', 'team-27'],
    ]);

    // Above the reader, rows sync late, one row is updated and one is
    // removed, then the app resumes.
    shell.team.lateBelow = 'team-new-15';
    shell.team.late = 3;
    shell.team.updated.add('team-new-12');
    shell.team.removed.add('team-new-14');
    resume();
    await settleHolding(reader, place);

    // The reader can scroll back to every new row.
    for (final branch in const ['org-late-2', 'org-new-21', 'org-new-12']) {
      await tester.scrollUntilVisible(
        find.text('Worktree updated · feature/$branch'),
        -400,
        scrollable: list,
      );
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('returning to Activity and resuming reload it', (tester) async {
    final shell = await pumpShell(tester);
    final tabs = tabsOf(tester);
    expect(shell.team.cursors, hasLength(1));

    tabs.select(HomeTab.remote);
    await tester.pumpAndSettle();
    tabs.select(HomeTab.activity);
    await tester.pumpAndSettle();
    expect(shell.team.cursors, hasLength(2));

    // Background and foreground through the states the platform reports.
    for (final state in const [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(shell.team.cursors, hasLength(3));
    expect(find.text('Worktree updated · feature/org-work-0'), findsOneWidget);
  });
}
