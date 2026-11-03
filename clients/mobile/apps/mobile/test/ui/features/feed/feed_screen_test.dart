import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:mobile/main.dart' show refreshActivityFeed;
import 'package:mobile/data/models/feed_sharing_status.dart';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/data/services/feed_api_service.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/search-field/canopy_search_field.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_card.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/home/views/activity_refresh_binding.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';

import '../../../support/search_field_fixture.dart';
import '../../../support/account_organizations_fixture.dart';

void main() {
  group('FeedScreen', () {
    Widget buildSubject({
      MembersRepository? membersRepository,
      FeedRepository? feedRepository,
      AuthViewModel? authViewModel,
    }) {
      return MultiProvider(
        providers: [
          if (authViewModel == null)
            ChangeNotifierProvider<AuthViewModel>(
              create: (_) => AuthViewModel(repository: MockAuthRepository()),
            )
          else
            ChangeNotifierProvider<AuthViewModel>.value(value: authViewModel),
          ChangeNotifierProvider<FeedViewModel>(
            create: (_) => FeedViewModel(
              repository: feedRepository ?? MockFeedRepository(),
            )..loadFeed(),
          ),
          ChangeNotifierProvider<MembersViewModel>(
            create: (_) => MembersViewModel(
              repository:
                  membersRepository ??
                  MockMembersRepository(latency: Duration.zero),
            )..load(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const FeedScreen(),
        ),
      );
    }

    /// An [AuthViewModel] whose active organization is [name] with the
    /// viewer holding [role] — what the lapse copy branches on.
    Future<AuthViewModel> seedAuth({
      String name = 'Acme',
      OrganizationRole role = OrganizationRole.owner,
    }) async {
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(
          () async => [
            OrganizationSummary(
              id: 'org-lapsed',
              name: name,
              role: role,
              memberCount: 3,
              subTeamCount: 0,
            ),
          ],
        ),
      );
      await auth.reloadOrganizations();
      // Organization context is an explicit choice (CAN-4429).
      auth.switchOrg('org-lapsed');
      return auth;
    }

    testWidgets('shows a loading indicator while fetching', (tester) async {
      await tester.pumpWidget(buildSubject());
      // First frame: loading state is active before the delay completes.
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      // Drain the mock's pending delay timer so the widget tree disposes clean.
      await tester.pumpAndSettle();
    });

    testWidgets('renders feed cards after data loads', (tester) async {
      await tester.pumpWidget(buildSubject());

      // Let the mock delay complete and the widget tree rebuild.
      await tester.pumpAndSettle();

      // At least one FeedCard should be present.
      expect(find.byType(FeedCard), findsWidgets);
      final refreshIndicator = tester.widget<RefreshIndicator>(
        find.byType(RefreshIndicator),
      );
      expect(
        refreshIndicator.edgeOffset,
        CanopyScaffold.contentPaddingOf(
          tester.element(find.byType(RefreshIndicator)),
        ).top,
      );
    });

    testWidgets('shows the agent session item', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // MockFeedRepository contains an AgentSessionFeedItem with status 'completed'.
      expect(find.textContaining('Agent session'), findsOneWidget);
    });

    testWidgets('shows the merged PR title', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // MockFeedRepository contains a PrMergedFeedItem titled 'Add activity feed screen'.
      expect(find.text('Add activity feed screen'), findsOneWidget);
    });

    testWidgets('filter sheet updates when members load after opening', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        buildSubject(membersRepository: MockMembersRepository()),
      );

      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Filter activity'), findsOneWidget);
      expect(find.text('All members'), findsNothing);

      await tester.pumpAndSettle();

      expect(find.text('All members'), findsOneWidget);
      expect(
        find.widgetWithText(RadioListTile<String?>, 'Sam Chen'),
        findsOneWidget,
      );
    });

    testWidgets('shows the pipeline run item', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // MockFeedRepository contains a PipelineRunFeedItem named 'CI / Tests'.
      expect(find.text('CI / Tests'), findsOneWidget);
    });

    testWidgets('shows the actor display name', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // At least one card from actor 'Alex Rivera'.
      expect(find.text('Alex Rivera'), findsWidgets);
    });

    testWidgets('timeline app bar title is visible', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Timeline'), findsOneWidget);
    });

    testWidgets('pull-to-refresh reloads feed', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Drag down to trigger RefreshIndicator.
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 300));
      await tester.pump();

      // Settling again lets the mock reload complete.
      await tester.pumpAndSettle();

      expect(find.byType(FeedCard), findsWidgets);
    });

    testWidgets('filtering by type narrows the feed', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();
      expect(find.text('CI / Tests'), findsOneWidget);

      // Open the filter sheet (outlined icon = no active filters).
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();

      // Keep only "PRs merged" and apply.
      await tester.tap(find.text('PRs merged'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();

      expect(find.text('Add activity feed screen'), findsOneWidget);
      expect(find.text('CI / Tests'), findsNothing);
      // The icon now shows the active (filled) state.
      expect(
        tester
            .widget<Badge>(
              find.byKey(const ValueKey('activity-filter-indicator')),
            )
            .isLabelVisible,
        isTrue,
      );
    });

    testWidgets('filtering by member narrows the feed to that actor', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Sam (user-002) authored "CI / Tests"; Alex (user-001) the merged PR.
      expect(find.text('CI / Tests'), findsOneWidget);
      expect(find.text('Add activity feed screen'), findsOneWidget);

      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();

      // The member picker lists both aligned members; pick Sam Chen. "Sam Chen"
      // also appears on feed cards, so scope the tap to the picker's radio tile.
      expect(find.text('All members'), findsOneWidget);
      await tester.tap(find.widgetWithText(RadioListTile<String?>, 'Sam Chen'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();

      // Only Sam's items remain.
      expect(find.text('CI / Tests'), findsOneWidget);
      expect(find.text('Add activity feed screen'), findsNothing);
      expect(
        tester
            .widget<Badge>(
              find.byKey(const ValueKey('activity-filter-indicator')),
            )
            .isLabelVisible,
        isTrue,
      );

      // No RenderFlex overflow at phone width anywhere in this flow.
      expect(tester.takeException(), isNull);
    });

    testWidgets('clearing filters restores the full feed', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Apply a member filter first.
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(RadioListTile<String?>, 'Sam Chen'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(find.text('Add activity feed screen'), findsNothing);

      // Now clear from the sheet (filter icon is in its active state).
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Clear'));
      await tester.pumpAndSettle();

      // Both actors' items are back and the filter is inactive again.
      expect(find.text('CI / Tests'), findsOneWidget);
      expect(find.text('Add activity feed screen'), findsOneWidget);
      expect(
        tester
            .widget<Badge>(
              find.byKey(const ValueKey('activity-filter-indicator')),
            )
            .isLabelVisible,
        isFalse,
      );
      expect(tester.takeException(), isNull);
    });

    Finder sheetSearch() => find.descendant(
      of: find.byType(BottomSheet),
      matching: find.byType(TextField),
    );

    for (final scale in [1.0, 2.0, 3.0, 3.2]) {
      testWidgets('the sheet search is the shared field at ${scale}x text', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Filter activity'));
        await tester.pumpAndSettle();

        final field = find.descendant(
          of: find.byType(BottomSheet),
          matching: find.byType(CanopySearchField),
        );
        expect(field, findsOneWidget);
        expect(tester.widget<CanopySearchField>(field).hintText, 'Search');
        await tester.enterText(sheetSearch(), 'deploy');
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: field, matching: find.byTooltip('Clear')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('keyboard search applies the typed query and closes', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final repository = RecordingFeedRepository();

      await tester.pumpWidget(buildSubject(feedRepository: repository));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();

      await tester.enterText(sheetSearch(), 'deploy');
      await tester.testTextInput.receiveAction(TextInputAction.search);
      await tester.pumpAndSettle();

      expect(find.byType(BottomSheet), findsNothing);
      expect(repository.queries.last, 'deploy');
      expect(tester.takeException(), isNull);
    });

    testWidgets('the field Clear empties the draft and waits for Apply', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final repository = RecordingFeedRepository();

      await tester.pumpWidget(buildSubject(feedRepository: repository));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();
      await tester.enterText(sheetSearch(), 'deploy');
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(repository.queries.last, 'deploy');

      // The reopened sheet starts from the applied query.
      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();
      final fieldClear = find.descendant(
        of: sheetSearch(),
        matching: find.byTooltip('Clear'),
      );
      expect(fieldClear, findsOneWidget);
      final fetches = repository.queries.length;

      await tester.tap(fieldClear);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<EditableText>(
              find.descendant(
                of: sheetSearch(),
                matching: find.byType(EditableText),
              ),
            )
            .controller
            .text,
        isEmpty,
      );
      expect(fieldClear, findsNothing);
      expect(find.byType(BottomSheet), findsOneWidget);
      expect(repository.queries, hasLength(fetches));
      expect(
        tester
            .widget<Badge>(
              find.byKey(const ValueKey('activity-filter-indicator')),
            )
            .isLabelVisible,
        isTrue,
      );

      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(repository.queries.last, isNull);
      expect(
        tester
            .widget<Badge>(
              find.byKey(const ValueKey('activity-filter-indicator')),
            )
            .isLabelVisible,
        isFalse,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a generic failure never renders the raw exception', (
      tester,
    ) async {
      // CAN-2638 regression: the screen used to interpolate the caught object
      // into a Text widget, and ApiException.toString() embeds the entire raw
      // response body.
      await tester.pumpWidget(
        buildSubject(feedRepository: _FailingFeedRepository()),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load activity'), findsOneWidget);
      expect(find.textContaining('ApiException'), findsNothing);
      expect(find.textContaining('{"error"'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a 5xx failure shows generic copy, not the server sentence', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          feedRepository: _FailingFeedRepository(
            status: 500,
            body: '{"error":"Database unavailable"}',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load activity'), findsOneWidget);
      expect(find.textContaining('Database unavailable'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a permission 403 shows the server sentence and Retry', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          feedRepository: _FailingFeedRepository(
            status: 403,
            body: '{"error":"You do not have permission to view this feed"}',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load activity'), findsOneWidget);
      expect(
        find.text('You do not have permission to view this feed'),
        findsOneWidget,
      );
      // A permission 403 is NOT a lapse: no billing CTA.
      expect(find.text('Subscribe'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a lapsed org shows an owner the on-hold state and CTA', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final auth = await seedAuth(role: OrganizationRole.owner);

      await tester.pumpWidget(
        buildSubject(
          feedRepository: _LapsedFeedRepository(),
          authViewModel: auth,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Acme is on hold'), findsOneWidget);
      expect(
        find.textContaining('Subscribe to Team to restore your team.'),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Subscribe'), findsOneWidget);
      // Retry can never clear a billing lapse, so it is withdrawn.
      expect(find.widgetWithText(FilledButton, 'Retry'), findsNothing);
      expect(find.textContaining('ApiException'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a lapsed org tells a member to ask an owner, with no CTA', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final auth = await seedAuth(role: OrganizationRole.member);

      await tester.pumpWidget(
        buildSubject(
          feedRepository: _LapsedFeedRepository(),
          authViewModel: auth,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Acme is on hold'), findsOneWidget);
      expect(find.textContaining('Ask an organization owner'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Subscribe'), findsNothing);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.textContaining('ApiException'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a past-due org points the owner at their payment method', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final auth = await seedAuth();

      await tester.pumpWidget(
        buildSubject(
          feedRepository: _LapsedFeedRepository(reason: 'payment_failed'),
          authViewModel: auth,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Your last payment failed.'), findsOneWidget);
      expect(
        find.widgetWithText(FilledButton, 'Update payment method'),
        findsOneWidget,
      );
      expect(find.text('Subscribe'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('CAN-3715 Activity state', () {
    Widget pumpable({
      required FeedRepository repository,
      HomeTabController? tabs,
      bool withMembers = true,
      String? organizationName,
      VoidCallback? onViewPersonal,
    }) {
      // Composed as the home shell composes Activity.
      Widget screen = ActivityRefreshBinding(
        refresh: refreshActivityFeed,
        child: FeedScreen(
          organizationName: organizationName,
          onViewPersonal: onViewPersonal,
        ),
      );
      if (tabs != null) {
        screen = ChangeNotifierProvider<HomeTabController>.value(
          value: tabs,
          child: screen,
        );
      }
      return MultiProvider(
        providers: [
          ChangeNotifierProvider<AuthViewModel>(
            create: (_) => AuthViewModel(repository: MockAuthRepository()),
          ),
          ChangeNotifierProvider<FeedViewModel>(
            create: (_) => FeedViewModel(repository: repository)..loadFeed(),
          ),
          if (withMembers)
            ChangeNotifierProvider<MembersViewModel>(
              create: (_) => MembersViewModel(
                repository: MockMembersRepository(latency: Duration.zero),
              )..load(),
            ),
        ],
        child: MaterialApp(theme: AppTheme.light, home: screen),
      );
    }

    testWidgets('Load more reaches the second page (AC-07)', (tester) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
      final repository = _PagedFeedRepository();
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();

      await tester.scrollUntilVisible(
        find.text('Load more'),
        400,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-34'),
        400,
        scrollable: find.byType(Scrollable).first,
      );

      expect(repository.cursors, [null, 'row-29']);
      expect(find.text('Load more'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('refreshing after Load more keeps the reader in place '
        '(AC-07)', (tester) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository();
      final tabs = HomeTabController(
        tabs: organizationHomeTabs,
        initialTab: HomeTab.activity,
      );
      addTearDown(tabs.dispose);
      await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;
      await tester.scrollUntilVisible(
        find.text('Load more'),
        400,
        scrollable: list,
      );
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      // The reader rests at the end of the second page.
      await tester.drag(list, const Offset(0, -4000));
      await tester.pumpAndSettle();
      final anchor = find.text('Worktree updated · branch-31').hitTestable();
      expect(anchor, findsOneWidget);
      final place = tester.getTopLeft(anchor);

      // New work lands above while the app is in the background, then the
      // push fallback reselects Activity.
      repository.newer = 1;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();

      // Each refresh reads again down to the last read row, row-34.
      expect(repository.cursors, [
        null,
        'row-29',
        ...[null, 'row-28', 'row-33'],
        ...[null, 'row-28', 'row-33'],
      ]);
      expect(tester.getTopLeft(anchor), place);

      // More new work than a page lands: the first page is all new rows.
      // The refresh reads the new work and the reader's rows.
      repository.newer = 40;
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();

      expect(repository.cursors.skip(8), [
        null,
        'row-new-10',
        'row-new-5',
        'row-new-0',
        for (var i = 4; i < 34; i += 5) 'row-$i',
      ]);
      expect(tester.getTopLeft(anchor), place);
      expect(find.text('Load more'), findsNothing);

      // The reader moves up from the end of the list. The updated row
      // leaves the end, which shortens the list without clamping the scroll.
      await tester.drag(list, const Offset(0, 250));
      await tester.pumpAndSettle();
      final held = tester.getTopLeft(anchor);

      // The oldest read row is updated: it moves to the top under the same
      // ID. No unchanged row marks the read depth any more, so the refresh
      // reads to the end and keeps every read row.
      repository.updated.add('row-34');
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();

      expect(repository.cursors.skip(18), [
        null,
        'row-new-11',
        'row-new-6',
        'row-new-1',
        for (var i = 3; i < 33; i += 5) 'row-$i',
      ]);
      expect(tester.getTopLeft(anchor), held);
      expect(find.text('Load more'), findsNothing);
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-new-0'),
        -400,
        scrollable: list,
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-new-39'),
        -400,
        scrollable: list,
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-34'),
        -400,
        scrollable: list,
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-33'),
        400,
        scrollable: list,
      );
      expect(find.text('Load more'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the list stops at its last row after a scroll ends there '
        '(AC-08)', (tester) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository(total: 20);
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;

      // One drag from the top reaches the end of the list.
      await tester.drag(list, const Offset(0, -4000));
      await tester.pumpAndSettle();
      final end = _cardBottom(tester, 'row-19');
      expect(end, lessThanOrEqualTo(tester.getRect(list).bottom));

      // Each scroll end moves the start of the scroll offsets to the
      // reader's row. Later drags at the end stop at the same place.
      for (final dy in const [-300.0, -90.0, -40.0, -600.0]) {
        await tester.drag(list, Offset(0, dy));
        await tester.pumpAndSettle();
        expect(_cardBottom(tester, 'row-19'), end, reason: 'drag $dy');
      }

      // The reader moves up a little, then drags back to the end in steps.
      await tester.drag(list, const Offset(0, 250));
      await tester.pumpAndSettle();
      expect(_cardBottom(tester, 'row-19'), greaterThan(end));
      for (var step = 0; step < 6; step++) {
        await tester.drag(list, const Offset(0, -100));
        await tester.pumpAndSettle();
        expect(
          _cardBottom(tester, 'row-19'),
          greaterThanOrEqualTo(end),
          reason: 'step $step',
        );
      }
      expect(_cardBottom(tester, 'row-19'), end);
      expect(tester.takeException(), isNull);
    });

    testWidgets('after Load more the list stops at its new last row '
        '(AC-07)', (tester) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository();
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;
      final loadMore = find.byKey(const ValueKey('feed-load-more'));

      // One drag from the top reaches the Load more footer at the end.
      await tester.drag(list, const Offset(0, -6000));
      await tester.pumpAndSettle();
      final footer = tester.getBottomLeft(loadMore).dy;
      for (final dy in const [-300.0, -40.0, -600.0]) {
        await tester.drag(list, Offset(0, dy));
        await tester.pumpAndSettle();
        expect(tester.getBottomLeft(loadMore).dy, footer, reason: 'drag $dy');
      }

      await tester.tap(loadMore);
      await tester.pumpAndSettle();
      expect(repository.cursors, [null, 'row-29']);

      // The reader drags on to the new end in steps.
      final ends = <double>[];
      for (var step = 0; step < 8; step++) {
        await tester.drag(list, const Offset(0, -300));
        await tester.pumpAndSettle();
        if (step >= 2) ends.add(_cardBottom(tester, 'row-34'));
      }

      // Back at the top, one drag reaches the same end.
      await tester.drag(list, const Offset(0, 8000));
      await tester.pumpAndSettle();
      await tester.drag(list, const Offset(0, -8000));
      await tester.pumpAndSettle();
      expect(ends, everyElement(_cardBottom(tester, 'row-34')));
      expect(loadMore, findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a refresh that reads the whole feed keeps a deep reader in '
        'place (AC-08)', (tester) async {
      usePhoneViewport(tester);
      // Twenty rows fit one page, so each refresh reads the whole feed.
      final repository = _PagedFeedRepository(total: 20);
      final tabs = HomeTabController(
        tabs: organizationHomeTabs,
        initialTab: HomeTab.activity,
      );
      addTearDown(tabs.dispose);
      await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;
      await tester.drag(list, const Offset(0, -4000));
      await tester.pumpAndSettle();
      final anchor = find.text('Worktree updated · branch-17').hitTestable();
      expect(anchor, findsOneWidget);
      final place = tester.getTopLeft(anchor);

      Future<void> resume() async {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
      }

      repository.newer = 1;
      await resume();
      expect(repository.cursors, [null, null]);
      expect(tester.getTopLeft(anchor), place);

      // The first read row is removed as more work lands. The rows below
      // it keep their places.
      repository.removed.add('row-0');
      repository.newer = 2;
      await resume();
      expect(repository.cursors, [null, null, null]);
      expect(tester.getTopLeft(anchor), place);

      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-new-1'),
        -400,
        scrollable: list,
      );
      expect(find.text('Worktree updated · branch-0'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('rows that sync late keep a deep reader in place and stay '
        'reachable (AC-08)', (tester) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository();
      final tabs = HomeTabController(
        tabs: organizationHomeTabs,
        initialTab: HomeTab.activity,
      );
      addTearDown(tabs.dispose);
      await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;
      await tester.scrollUntilVisible(
        find.text('Load more'),
        400,
        scrollable: list,
      );
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      // The reader rests at the end of the second page.
      await tester.drag(list, const Offset(0, -4000));
      await tester.pumpAndSettle();
      final anchor = find.text('Worktree updated · branch-31').hitTestable();
      expect(anchor, findsOneWidget);
      final place = tester.getTopLeft(anchor);

      // Rows sync late with event times just below the newest read row.
      repository.lateBelow = 'row-0';
      repository.late = 3;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(anchor), place);

      // More late rows than a page sync, then Activity is reselected.
      repository.late = 30;
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();
      expect(tester.getTopLeft(anchor), place);
      expect(find.text('Load more'), findsNothing);

      // Every late row is in the list, in order below the newest row.
      final vm = tester.element(find.byType(FeedScreen)).read<FeedViewModel>();
      expect(
        [for (final item in vm.items) item.id],
        [
          'row-0',
          for (var i = 0; i < 30; i++) 'row-late-$i',
          for (var i = 1; i < 35; i++) 'row-$i',
        ],
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-late-29'),
        -400,
        scrollable: list,
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-late-0'),
        -400,
        scrollable: list,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a reader on rows that an earlier refresh added stays in '
        'place through later refreshes (AC-08)', (tester) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository();
      final tabs = HomeTabController(
        tabs: organizationHomeTabs,
        initialTab: HomeTab.activity,
      );
      addTearDown(tabs.dispose);
      await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
      await tester.pumpAndSettle();
      final list = find.byType(Scrollable).first;
      void resume() {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
      }

      // Twenty rows land while the reader is at the top: they show first.
      repository.newer = 20;
      resume();
      await tester.pumpAndSettle();
      expect(
        find.text('Worktree updated · branch-new-19').hitTestable(),
        findsOneWidget,
      );

      // The reader moves into those rows. Two more rows land above, then
      // Activity is reselected.
      final reader = find.text('Worktree updated · branch-new-8');
      await _readAt(tester, list, reader);
      var place = tester.getTopLeft(reader);
      repository.newer = 22;
      tabs.select(HomeTab.activity);
      await _settleHolding(tester, {reader: place});

      // Above the reader, rows sync late, one row is updated and one is
      // removed.
      repository.lateBelow = 'row-new-15';
      repository.late = 3;
      repository.updated.add('row-new-12');
      repository.removed.add('row-new-14');
      resume();
      await _settleHolding(tester, {reader: place});

      // The reader moves on to the first page's rows, and more work lands
      // as a row above them goes.
      final older = find.text('Worktree updated · branch-3');
      await _readAt(tester, list, older);
      place = tester.getTopLeft(older);
      final next = find.text('Worktree updated · branch-4');
      repository.newer = 25;
      repository.removed.add('row-1');
      tabs.select(HomeTab.activity);
      await _settleHolding(tester, {
        older: place,
        next: tester.getTopLeft(next),
      });

      // Every row is in the list once, in the server's order, and the reader
      // can scroll back to the newest.
      final vm = tester.element(find.byType(FeedScreen)).read<FeedViewModel>();
      final ids = [for (final item in vm.items) item.id];
      expect(ids, [
        'row-new-12',
        for (var i = 24; i >= 15; i--) 'row-new-$i',
        for (var i = 0; i < 3; i++) 'row-late-$i',
        'row-new-13',
        for (var i = 11; i >= 0; i--) 'row-new-$i',
        'row-0',
        // The read goes down to the page that holds row-29.
        for (var i = 2; i < ids.length - 26; i++) 'row-$i',
      ]);
      expect(ids, contains('row-29'));
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-late-2'),
        -400,
        scrollable: list,
      );
      await tester.scrollUntilVisible(
        find.text('Worktree updated · branch-new-12'),
        -400,
        scrollable: list,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('seeded refreshes keep the rows a reader sees in place '
        '(AC-08)', (tester) async {
      usePhoneViewport(tester);
      // Steps that changed work and checked the reader's rows.
      var held = 0;
      for (var seed = 0; seed < 100; seed++) {
        final random = Random(seed);
        final repository = _PagedFeedRepository();
        final tabs = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.activity,
        );
        addTearDown(tabs.dispose);
        await tester.pumpWidget(
          KeyedSubtree(
            key: ValueKey(seed),
            child: pumpable(repository: repository, tabs: tabs),
          ),
        );
        await tester.pumpAndSettle();
        final list = find.byType(Scrollable).first;
        final vm = tester
            .element(find.byType(FeedScreen))
            .read<FeedViewModel>();
        final steps = <String>[];
        for (var step = 0; step < 6; step++) {
          await tester.drag(list, Offset(0, random.nextDouble() * 2400 - 1200));
          await tester.pumpAndSettle();
          final seen = _rowsInView(tester);
          final ids = [for (final item in vm.items) item.id];
          final first = ids.indexOf(seen.first);
          final last = ids.indexOf(seen.last);
          final above = ids.take(first).toList();
          final below = ids.skip(last + 1).toList();
          // Work changes only outside the rows the reader sees.
          final updatable = [
            for (final id in [...above, ...below])
              if (!repository.updated.contains(id) &&
                  id != repository.lateBelow &&
                  !id.startsWith('row-late-'))
                id,
          ];
          // New rows land below the updated rows, late rows below the
          // last of the earlier late rows or their row.
          final arrival = ids.indexWhere(
            (id) =>
                !repository.updated.contains(id) && !id.startsWith('row-late-'),
          );
          final lateAt =
              ids.lastIndexWhere(
                (id) =>
                    id == repository.lateBelow || id.startsWith('row-late-'),
              ) +
              1;
          switch (random.nextInt(5)) {
            case 0 when arrival >= 0 && arrival <= first:
              repository.newer += 1 + random.nextInt(8);
              steps.add('arrive ${repository.newer}');
            case 1 when updatable.isNotEmpty:
              final id = updatable[random.nextInt(updatable.length)];
              repository.updated.add(id);
              steps.add('update $id');
            case 2 when above.isNotEmpty:
              final id = above[random.nextInt(above.length)];
              if (id == repository.lateBelow) continue;
              repository.removed.add(id);
              steps.add('remove $id');
            case 3 when repository.lateBelow == null && above.isNotEmpty:
              repository.lateBelow = above[random.nextInt(above.length)];
              repository.late = 1 + random.nextInt(6);
              steps.add(
                'late ${repository.late} below ${repository.lateBelow}',
              );
            case 3 when repository.lateBelow != null && lateAt <= first:
              repository.late += 1 + random.nextInt(6);
              steps.add(
                'late ${repository.late} below ${repository.lateBelow}',
              );
            case 4 when below.length > 12:
              final id = below[random.nextInt(below.length)];
              if (id == repository.lateBelow) continue;
              repository.removed.add(id);
              steps.add('remove $id');
            default:
              steps.add('none');
          }
          final position = tester.state<ScrollableState>(list).position;
          final atTop = position.extentBefore == 0;
          if (random.nextBool()) {
            tester.binding.handleAppLifecycleStateChanged(
              AppLifecycleState.paused,
            );
            tester.binding.handleAppLifecycleStateChanged(
              AppLifecycleState.resumed,
            );
          } else {
            tabs.select(HomeTab.activity);
          }
          final reason = 'seed $seed: ${steps.join(', ')}';
          if (atTop) {
            await tester.pumpAndSettle();
          } else {
            if (steps.last != 'none') held++;
            final rows = [
              for (final id in seen)
                find.text('Worktree updated · ${_branch(id)}'),
            ];
            await _settleHolding(
              tester,
              {for (final row in rows) row: tester.getTopLeft(row)},
              reason: reason,
              position: position,
            );
          }
          // The refreshed rows are the feed's, once each.
          expect(
            {for (final item in vm.items) item.id},
            hasLength(vm.items.length),
            reason: reason,
          );
        }
      }
      // Most steps change work away from the top and check the hold.
      expect(held, greaterThan(300));
      expect(tester.takeException(), isNull);
    });

    for (final (viewport, useViewport) in const [
      ('phone', usePhoneViewport),
      ('Android', useAndroidViewport),
    ]) {
      for (final (total, readerRowRemoved) in const [
        (35, true),
        (35, false),
        (12, true),
      ]) {
        testWidgets('removing the rows above a reader near the top moves them '
            'to the top in one frame ($viewport, $total rows, reader row '
            '${readerRowRemoved ? 'removed' : 'kept'}) (AC-08)', (
          tester,
        ) async {
          useViewport(tester);
          final repository = _PagedFeedRepository(total: total);
          final tabs = HomeTabController(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.activity,
          );
          addTearDown(tabs.dispose);
          await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
          await tester.pumpAndSettle();
          final list = find.byType(Scrollable).first;
          final position = tester.state<ScrollableState>(list).position;
          final vm = tester
              .element(find.byType(FeedScreen))
              .read<FeedViewModel>();
          final listTop = tester
              .getTopLeft(find.text('Worktree updated · branch-0'))
              .dy;

          // The reader moves a few rows down. The scroll end starts the
          // offsets at the first row they see.
          await _slowDrag(tester, list, by: -300);
          await tester.pumpAndSettle();
          expect(position.minScrollExtent, lessThan(0));
          final seen = _rowsInView(tester);
          final ids = [for (final item in vm.items) item.id];
          final first = ids.indexOf(seen.first);
          expect(first, greaterThan(0));
          // The rows above the reader go, and the reader's first row too
          // when asked. Only the header stays above the next row.
          final gone = ids.take(first + (readerRowRemoved ? 1 : 0)).toSet();
          final row = find.text(
            'Worktree updated · ${_branch(seen[readerRowRemoved ? 1 : 0])}',
          );
          final before = tester.getTopLeft(row).dy;
          // The row moves up as far as the header allows, no further.
          final after = min(before, listTop);
          if (readerRowRemoved) expect(before, greaterThan(listTop));
          repository.removed.addAll(gone);
          tabs.select(HomeTab.activity);

          var committed = false;
          for (var frame = 0; frame < 600; frame++) {
            await tester.pump(const Duration(milliseconds: 16));
            final reason = 'frame $frame';
            // The content covers the screen: no offset past either end.
            expect(position.outOfRange, isFalse, reason: reason);
            committed =
                committed || vm.items.every((item) => !gone.contains(item.id));
            expect(
              tester.getTopLeft(row).dy,
              committed ? after : before,
              reason: reason,
            );
            if (!tester.binding.hasScheduledFrame) break;
          }
          expect(committed, isTrue);
          expect(tester.binding.hasScheduledFrame, isFalse);
          expect(tester.takeException(), isNull);
        });
      }

      for (final readerRowRemoved in const [false, true]) {
        testWidgets('removing the start row and the rows below it near the top '
            'moves them to the top in one frame while the first page stays '
            'full ($viewport, reader row '
            '${readerRowRemoved ? 'removed' : 'kept'}) (AC-08)', (
          tester,
        ) async {
          useViewport(tester);
          // After the removal the first page still holds thirty rows and
          // Load more stays, so no extent of the list changes.
          final repository = _PagedFeedRepository(total: 60);
          final tabs = HomeTabController(
            tabs: organizationHomeTabs,
            initialTab: HomeTab.activity,
          );
          addTearDown(tabs.dispose);
          await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
          await tester.pumpAndSettle();
          final list = find.byType(Scrollable).first;
          final position = tester.state<ScrollableState>(list).position;
          final vm = tester
              .element(find.byType(FeedScreen))
              .read<FeedViewModel>();
          // Where each row starts with the list at its top.
          final topPlace = {
            for (final item in vm.items.take(4))
              item.id: tester
                  .getTopLeft(
                    find.text('Worktree updated · ${_branch(item.id)}'),
                  )
                  .dy,
          };
          final pitch = topPlace['row-1']! - topPlace['row-0']!;

          // The reader moves down a row and a half. The scroll end starts the
          // offsets at the first row they see; the rows above it stay.
          await _slowDrag(tester, list, by: -1.5 * pitch);
          await tester.pumpAndSettle();
          expect(position.minScrollExtent, lessThan(0));
          final seen = _rowsInView(tester);
          // The start row and the rows below it down to the reader's row go:
          // all but the row above the reader's, or the reader's row too. The
          // first row left moves up to where the start row is at the top: the
          // rows above the start row and the header reach no further.
          const reader = 3;
          final gone = seen
              .take(readerRowRemoved ? reader + 1 : reader - 1)
              .toSet();
          final row = find.text(
            'Worktree updated · '
            '${_branch(seen[readerRowRemoved ? reader + 1 : reader - 1])}',
          );
          final before = tester.getTopLeft(row).dy;
          final after = topPlace[seen.first]!;
          expect(before, greaterThan(after));
          expect((vm.items.length, vm.hasMore), (30, true));
          final (minBefore, maxBefore) = (
            position.minScrollExtent,
            position.maxScrollExtent,
          );
          repository.removed.addAll(gone);
          tabs.select(HomeTab.activity);

          var committed = false;
          for (var frame = 0; frame < 600; frame++) {
            await tester.pump(const Duration(milliseconds: 16));
            final reason =
                'frame $frame: pixels ${position.pixels}, '
                'min ${position.minScrollExtent}';
            expect(position.minScrollExtent, minBefore, reason: reason);
            expect(position.maxScrollExtent, maxBefore, reason: reason);
            // No offset past the top: nothing shows above the header.
            expect(position.outOfRange, isFalse, reason: reason);
            committed =
                committed || vm.items.every((item) => !gone.contains(item.id));
            expect(
              tester.getTopLeft(row).dy,
              committed ? after : before,
              reason: reason,
            );
            if (!tester.binding.hasScheduledFrame) break;
          }
          expect(committed, isTrue);
          expect(tester.binding.hasScheduledFrame, isFalse);
          expect((vm.items.length, vm.hasMore), (30, true));
          expect(tester.takeException(), isNull);
        });
      }

      testWidgets('a drag back to the top rests exactly at the top, so new '
          'rows show first and a pull refreshes ($viewport) (AC-08)', (
        tester,
      ) async {
        useViewport(tester);
        final repository = _PagedFeedRepository();
        final tabs = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.activity,
        );
        addTearDown(tabs.dispose);
        await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
        await tester.pumpAndSettle();
        final list = find.byType(Scrollable).first;
        final position = tester.state<ScrollableState>(list).position;
        final firstRow = find.text('Worktree updated · branch-0');
        final listTop = tester.getTopLeft(firstRow).dy;

        // The reader goes down, then drags back up to the top: past the
        // top, or in moves that end at the top without passing it.
        for (final (down, steps, past) in const [
          (-613.7, 1, true),
          (-1234.5, 3, true),
          (-613.7, 3, false),
          (-1234.5, 7, false),
          (-2047.3, 11, false),
        ]) {
          final reason = 'down $down, steps $steps';
          await _slowDrag(tester, list, by: down);
          await tester.pumpAndSettle();
          // The offsets start at the reader's row, below the top.
          expect(position.minScrollExtent, lessThan(0), reason: reason);
          await _slowDrag(
            tester,
            list,
            by: past ? position.extentBefore + 400 : null,
            steps: steps,
          );
          await tester.pumpAndSettle();
          expect(position.pixels, position.minScrollExtent, reason: reason);
          expect(tester.getTopLeft(firstRow).dy, listTop, reason: reason);
        }

        // New rows show first at the top after a resume and a reselect.
        repository.newer = 2;
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();
        expect(
          tester.getTopLeft(find.text('Worktree updated · branch-new-1')).dy,
          listTop,
        );
        await _slowDrag(tester, list, by: -500.3);
        await tester.pumpAndSettle();
        await _slowDrag(tester, list, steps: 5);
        await tester.pumpAndSettle();
        repository.newer = 3;
        tabs.select(HomeTab.activity);
        await tester.pumpAndSettle();
        expect(
          tester.getTopLeft(find.text('Worktree updated · branch-new-2')).dy,
          listTop,
        );

        // A pull from a top that a drag reached starts a refresh.
        await _slowDrag(tester, list, by: -700.9);
        await tester.pumpAndSettle();
        await _slowDrag(tester, list, steps: 9);
        await tester.pumpAndSettle();
        final fetches = repository.cursors.length;
        await tester.drag(list, const Offset(0, 300));
        await tester.pump();
        expect(find.byType(RefreshProgressIndicator), findsOneWidget);
        await tester.pumpAndSettle();
        expect(repository.cursors.length, greaterThan(fetches));
        expect(repository.cursors[fetches], isNull);
        expect(tester.takeException(), isNull);
      });
    }

    for (final (place, down) in const [
      ('the top', 0.0),
      ('a deep row', -1500.0),
    ]) {
      testWidgets('a status bar tap scrolls Activity to its top from $place '
          '(AC-08)', (tester) async {
        usePhoneViewport(tester);
        // The status bar of an iPhone 13.
        tester.view.padding = const FakeViewPadding(top: 141);
        await tester.pumpWidget(pumpable(repository: _PagedFeedRepository()));
        await tester.pumpAndSettle();
        final list = find.byType(Scrollable).first;
        final position = tester.state<ScrollableState>(list).position;
        final firstRow = find.text('Worktree updated · branch-0');
        final listTop = tester.getTopLeft(firstRow).dy;
        if (down != 0) {
          await _slowDrag(tester, list, by: down);
          await tester.pumpAndSettle();
          // The offsets start at the reader's row, so the top is below 0.
          expect(position.minScrollExtent, lessThan(0));
        }

        tester.simulateStatusBarTap();
        await tester.pumpAndSettle();

        expect(position.pixels, position.minScrollExtent);
        expect(tester.getTopLeft(firstRow).dy, listTop);
        expect(tester.takeException(), isNull);
      }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

      testWidgets('Activity is the primary scroll view of its screen, counted '
          'from its top, from $place (AC-08)', (tester) async {
        usePhoneViewport(tester);
        await tester.pumpWidget(pumpable(repository: _PagedFeedRepository()));
        await tester.pumpAndSettle();
        final list = find.byType(Scrollable).first;
        final position = tester.state<ScrollableState>(list).position;
        final firstRow = find.text('Worktree updated · branch-0');
        final listTop = tester.getTopLeft(firstRow).dy;
        if (down != 0) {
          await _slowDrag(tester, list, by: down);
          await tester.pumpAndSettle();
          expect(position.minScrollExtent, lessThan(0));
        }
        // The controller that the screen's Scaffold scrolls to the top.
        final primary = PrimaryScrollController.maybeOf(
          tester.element(find.byType(Scaffold)),
        );
        expect(primary?.positions, [position]);
        expect(primary!.offset, position.pixels - position.minScrollExtent);
        // A jump to the offset it reports keeps the rows in place.
        final seen = _rowsInView(tester);
        primary.jumpTo(primary.offset);
        await tester.pumpAndSettle();
        expect(_rowsInView(tester), seen);

        unawaited(
          primary.animateTo(
            0,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          ),
        );
        await tester.pumpAndSettle();

        expect(position.pixels, position.minScrollExtent);
        expect(primary.offset, 0);
        expect(tester.getTopLeft(firstRow).dy, listTop);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('a failed refresh keeps the current rows (AC-08)', (
      tester,
    ) async {
      final repository = _PagedFeedRepository();
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();
      expect(find.text('Worktree updated · branch-0'), findsOneWidget);

      repository.failNext = Exception('offline');
      await tester.drag(find.byType(Scrollable).first, const Offset(0, 300));
      await tester.pumpAndSettle();

      expect(find.text('Worktree updated · branch-0'), findsOneWidget);
      expect(find.text('Could not refresh activity.'), findsOneWidget);
    });

    testWidgets('selecting Activity and resuming reload the feed (AC-06)', (
      tester,
    ) async {
      final repository = _PagedFeedRepository();
      final tabs = HomeTabController(
        tabs: organizationHomeTabs,
        initialTab: HomeTab.remote,
      );
      addTearDown(tabs.dispose);
      await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
      await tester.pumpAndSettle();
      expect(repository.cursors, hasLength(1));

      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();
      expect(repository.cursors, hasLength(2));

      // The push fallback reselects an already selected Activity.
      tabs.select(HomeTab.activity);
      await tester.pumpAndSettle();
      expect(repository.cursors, hasLength(3));

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(repository.cursors, hasLength(4));

      // A hidden Activity does not reload on resume.
      tabs.select(HomeTab.remote);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(repository.cursors, hasLength(4));
    });

    testWidgets('private sharing evidence explains the missing work (AC-04)', (
      tester,
    ) async {
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/data-sharing')) {
          return http.Response(
            jsonEncode({
              'viewerUserId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              'scopes': {
                'metadata': 'private',
                'plans': 'unknown',
                'summaries': 'unknown',
                'transcripts': 'unknown',
              },
            }),
            200,
          );
        }
        return http.Response(
          jsonEncode({'items': [], 'nextCursor': null}),
          200,
        );
      });
      final service = FeedApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );
      final repository = HttpFeedRepository(
        service: service,
        orgId: 'org-1',
        readSharingStatus: service.fetchSharingStatus,
      );
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Share your work in the feed.'),
        findsOneWidget,
      );
      expect(
        find.textContaining(
          'Turn this on in the ${Brand.productDisplayName} desktop app.',
        ),
        findsOneWidget,
      );
    });

    FeedRepository sharingRepository(Map<String, String> scopes) {
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/data-sharing')) {
          return http.Response(
            jsonEncode({
              'viewerUserId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              'scopes': scopes,
            }),
            200,
          );
        }
        return http.Response(jsonEncode({'items': []}), 200);
      });
      final service = FeedApiService(
        apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
      );
      return HttpFeedRepository(
        service: service,
        orgId: 'org-1',
        readSharingStatus: service.fetchSharingStatus,
      );
    }

    testWidgets('View Personal asks the shell for Personal (AC-04)', (
      tester,
    ) async {
      usePhoneViewport(tester);
      var viewPersonal = 0;
      await tester.pumpWidget(
        pumpable(
          repository: sharingRepository({
            'metadata': 'private',
            'plans': 'shared',
            'summaries': 'shared',
            'transcripts': 'unknown',
          }),
          onViewPersonal: () => viewPersonal++,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('View Personal'));
      await tester.pumpAndSettle();

      expect(viewPersonal, 1);
      expect(tester.takeException(), isNull);
    });

    testWidgets('without Personal the offer has no View Personal action', (
      tester,
    ) async {
      await tester.pumpWidget(
        pumpable(
          repository: sharingRepository({
            'metadata': 'private',
            'plans': 'shared',
            'summaries': 'shared',
            'transcripts': 'unknown',
          }),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('Share your work'), findsOneWidget);
      expect(find.text('View Personal'), findsNothing);
    });

    testWidgets('organization-managed sharing offers no enable action', (
      tester,
    ) async {
      await tester.pumpWidget(
        pumpable(
          repository: sharingRepository({
            'metadata': 'prohibited',
            'plans': 'unknown',
            'summaries': 'unknown',
            'transcripts': 'unknown',
          }),
          organizationName: 'Acme',
          onViewPersonal: () {},
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Acme manages this sharing.'), findsOneWidget);
      expect(find.textContaining('Share your work'), findsNothing);
      expect(find.text('View Personal'), findsNothing);
    });

    testWidgets('fully shared work shows no sharing notice', (tester) async {
      await tester.pumpWidget(
        pumpable(
          repository: sharingRepository({
            'metadata': 'shared',
            'plans': 'shared',
            'summaries': 'shared',
            'transcripts': 'private',
          }),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('feed-sharing-offer')), findsNothing);
      expect(find.byKey(const ValueKey('feed-sharing-managed')), findsNothing);
      expect(find.text('No activity yet'), findsOneWidget);
    });

    testWidgets('reloading an empty feed keeps the empty list in place', (
      tester,
    ) async {
      final page = Completer<FeedPageResponse>();
      var calls = 0;
      final repository = _CallbackFeedRepository((_) {
        calls++;
        return calls == 1
            ? Future.value(const FeedPageResponse(items: []))
            : page.future;
      });
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();
      expect(find.text('No activity yet'), findsOneWidget);

      unawaited(
        tester
            .element(find.byType(FeedScreen))
            .read<FeedViewModel>()
            .loadFeed(),
      );
      await tester.pump();

      expect(find.text('No activity yet'), findsOneWidget);
      expect(find.byType(RefreshIndicator), findsOneWidget);
      page.complete(const FeedPageResponse(items: []));
      await tester.pumpAndSettle();
    });

    testWidgets(
      'a refresh keeps the sharing notice and rows in place (AC-08)',
      (tester) async {
        usePhoneViewport(tester);
        final paged = _PagedFeedRepository();
        Completer<FeedPageResponse>? pending;
        final repository = _CallbackFeedRepository(
          (cursor) => pending?.future ?? paged.fetchFeed(cursor: cursor),
          sharing: const FeedSharingStatus(
            metadata: FeedSharingState.private,
            plans: FeedSharingState.unknown,
            summaries: FeedSharingState.unknown,
          ),
        );
        final tabs = HomeTabController(
          tabs: organizationHomeTabs,
          initialTab: HomeTab.activity,
        );
        addTearDown(tabs.dispose);
        await tester.pumpWidget(pumpable(repository: repository, tabs: tabs));
        await tester.pumpAndSettle();
        final notice = find.textContaining('Share your work in the feed.');
        final firstRow = find.text('Worktree updated · branch-0');
        expect(notice, findsOneWidget);
        final settledTop = tester.getTopLeft(firstRow).dy;

        // Reselecting Activity and resuming both refresh the same scope.
        pending = Completer();
        tabs.select(HomeTab.activity);
        await tester.pump();
        expect(notice, findsOneWidget);
        expect(tester.getTopLeft(firstRow).dy, settledTop);
        pending.complete(await paged.fetchFeed());
        await tester.pumpAndSettle();

        pending = Completer();
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        expect(notice, findsOneWidget);
        expect(tester.getTopLeft(firstRow).dy, settledTop);
        pending.complete(await paged.fetchFeed());
        await tester.pumpAndSettle();
        expect(notice, findsOneWidget);
        expect(tester.getTopLeft(firstRow).dy, settledTop);
      },
    );

    testWidgets('Personal Activity offers no member filter (AC-03)', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        pumpable(repository: _PagedFeedRepository(), withMembers: false),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Filter activity'));
      await tester.pumpAndSettle();

      expect(find.text('Filter activity'), findsOneWidget);
      expect(find.text('All members'), findsNothing);
      expect(find.text('Member'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failed append keeps the rows and retries (AC-07)', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _PagedFeedRepository();
      await tester.pumpWidget(pumpable(repository: repository));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.text('Load more'),
        400,
        scrollable: find.byType(Scrollable).first,
      );

      repository.failNext = Exception('offline');
      await tester.tap(find.text('Load more'));
      await tester.pumpAndSettle();
      expect(find.text('Could not load more activity.'), findsOneWidget);
      expect(find.text('Worktree updated · branch-29'), findsOneWidget);

      await tester.ensureVisible(find.text('Retry'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(repository.cursors, [null, 'row-29', 'row-29']);
      expect(find.text('Could not load more activity.'), findsNothing);
    });
  });
}

void usePhoneViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
}

/// The Android emulator's 1080x2400 screen at its fractional pixel ratio.
void useAndroidViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 2.625;
  addTearDown(tester.view.reset);
}

String _branch(String id) => id.replaceFirst('row', 'branch');

/// The screen bottom of the card that shows the row [id].
double _cardBottom(WidgetTester tester, String id) => tester
    .getBottomLeft(
      find.byWidgetPredicate(
        (w) => w is FeedCard && w.item.id == id,
        skipOffstage: false,
      ),
    )
    .dy;

/// Scrolls down to [row], then moves it to about a third down [list].
Future<void> _readAt(WidgetTester tester, Finder list, Finder row) async {
  await tester.scrollUntilVisible(row, 100, scrollable: list);
  await tester.pumpAndSettle();
  final view = tester.getRect(list);
  await tester.drag(
    list,
    Offset(0, view.top + view.height / 3 - tester.getTopLeft(row).dy),
  );
  await tester.pumpAndSettle();
  expect(row.hitTestable(), findsOneWidget);
}

/// Drags [list] in [steps] slow moves with a frame after each, as a finger
/// does, and lifts the finger at rest, so no fling follows. Without [by] the
/// moves end exactly at the top of the list, without passing it.
Future<void> _slowDrag(
  WidgetTester tester,
  Finder list, {
  double? by,
  int steps = 8,
}) async {
  final position = tester.state<ScrollableState>(list).position;
  var time = Duration.zero;
  final gesture = await tester.startGesture(tester.getCenter(list));
  // The scroll follows the finger once it passes the touch slop.
  final slop = (by ?? 1).sign * (kTouchSlop + 1);
  await gesture.moveBy(Offset(0, slop), timeStamp: time);
  await tester.pump();
  final distance = by == null ? position.extentBefore : by - slop;
  for (var step = 0; step < steps; step++) {
    time += const Duration(milliseconds: 16);
    await gesture.moveBy(Offset(0, distance / steps), timeStamp: time);
    await tester.pump();
  }
  time += const Duration(milliseconds: 200);
  await gesture.moveBy(Offset.zero, timeStamp: time);
  await gesture.up(timeStamp: time);
}

/// The IDs of the feed rows fully in view below the app bar, top first.
List<String> _rowsInView(WidgetTester tester) {
  final top = tester.getRect(find.byType(CanopyAppBar)).bottom;
  final bottom = tester.getRect(find.byType(Scrollable).first).bottom;
  final rows = <(double, String)>[];
  for (final element in find.byType(FeedCard).evaluate()) {
    final card = element.widget;
    final box = element.renderObject;
    if (card is! FeedCard || box is! RenderBox) continue;
    final rect = box.localToGlobal(Offset.zero) & box.size;
    if (rect.top >= top && rect.bottom <= bottom) {
      rows.add((rect.top, card.item.id));
    }
  }
  rows.sort((a, b) => a.$1.compareTo(b.$1));
  return [for (final (_, id) in rows) id];
}

/// Pumps frames until the screen settles. In every frame each row is still
/// at its place.
///
/// With the list's [position], the list also stays within its ends in every
/// frame. When too few rows stay above the rows to keep them in place, the
/// rows move up together where the list rests at its top, at once.
Future<void> _settleHolding(
  WidgetTester tester,
  Map<Finder, Offset> places, {
  String? reason,
  ScrollPosition? position,
}) async {
  double? shift;
  for (var frame = 0; frame < 600; frame++) {
    await tester.pump(const Duration(milliseconds: 16));
    final at = '${reason ?? ''} frame $frame';
    if (position != null) {
      expect(position.outOfRange, isFalse, reason: at);
      final MapEntry(key: row, value: place) = places.entries.first;
      final moved = tester.getTopLeft(row).dy - place.dy;
      if (moved != 0 || shift != null) {
        expect(moved, lessThan(0), reason: '$at: $row moved down');
        expect(position.extentBefore, 0, reason: '$at: $row moved');
        expect(moved, shift ?? moved, reason: '$at: $row moved again');
        shift = moved;
      }
    }
    for (final MapEntry(key: row, value: place) in places.entries) {
      expect(
        tester.getTopLeft(row),
        place.translate(0, shift ?? 0),
        reason: '$at: $row',
      );
    }
    if (!tester.binding.hasScheduledFrame) return;
  }
  fail('${reason ?? ''}: the screen did not settle');
}

/// Fails every fetch with an [ApiException], the shape a real API failure has.
final class _FailingFeedRepository implements FeedRepository {
  _FailingFeedRepository({
    this.status = 503,
    this.body = '{"error":"Service unavailable"}',
  });

  final int status;
  final String body;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async => throw ApiException(statusCode: status, body: body);

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

/// Thirty rows aged 47-50 days, then pages of five (CAN-3715). Rows are in
/// the server's order: occurredAt newest first, then ID descending. A cursor
/// holds its last row's time and ID, as the server's value cursor does.
final class _PagedFeedRepository implements FeedRepository {
  _PagedFeedRepository({this.total = 35});

  /// How many rows the feed holds before new work lands.
  final int total;

  /// The row each requested cursor names (null for a first page).
  final cursors = <String?>[];
  final _now = DateTime.now();
  Object? failNext;

  /// Rows that landed since the first load, newest first above the others.
  int newer = 0;

  /// Rows updated since the first load, latest last. The feed is ordered by
  /// occurredAt, so an update moves a row to the top under the same ID.
  final updated = <String>[];

  /// Rows removed since the first load.
  final removed = <String>{};

  /// Rows that synced late (row-late-N). Their event times sort just below
  /// the current time of the [lateBelow] row.
  String? lateBelow;
  int late = 0;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    cursors.add(cursor?.split('|').last);
    final failure = failNext;
    if (failure != null) {
      failNext = null;
      throw failure;
    }
    final times = {
      for (var i = 0; i < total; i++)
        'row-$i': _now.subtract(Duration(days: 47 + i ~/ 10, minutes: i)),
      for (var i = 0; i < newer; i++)
        'row-new-$i': _now
            .subtract(const Duration(minutes: 4))
            .add(Duration(seconds: i)),
      for (final (k, id) in updated.indexed)
        id: _now.subtract(const Duration(minutes: 3)).add(Duration(seconds: k)),
    };
    if (times[lateBelow] case final below?) {
      for (var i = 0; i < late; i++) {
        times['row-late-$i'] = below.subtract(
          Duration(milliseconds: 10 * (i + 1)),
        );
      }
    }
    removed.forEach(times.remove);
    final ids = times.keys.toList()
      ..sort((a, b) {
        final byTime = times[b]!.compareTo(times[a]!);
        return byTime != 0 ? byTime : b.compareTo(a);
      });
    var start = 0;
    if (cursor != null) {
      final [time, after] = cursor.split('|');
      final at = DateTime.fromMicrosecondsSinceEpoch(int.parse(time));
      start = ids.indexWhere((id) {
        final byTime = times[id]!.compareTo(at);
        return byTime < 0 || (byTime == 0 && id.compareTo(after) < 0);
      });
      if (start < 0) start = ids.length;
    }
    final end = (start + (cursor == null ? 30 : 5)).clamp(0, ids.length);
    return FeedPageResponse(
      items: [
        for (final id in ids.sublist(start, end))
          WorktreeUpdatedFeedItem(
            actor: FeedActor(displayName: 'Brady', userId: 'user-1'),
            id: id,
            occurredAt: times[id]!.toIso8601String(),
            branchName: id.replaceFirst('row', 'branch'),
          ),
      ],
      nextCursor: end < ids.length
          ? '${times[ids[end - 1]]!.microsecondsSinceEpoch}|${ids[end - 1]}'
          : null,
    );
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

/// Fails with the coded org-billing 403 the web API returns once an
/// organization loses its `teams` capability.
final class _LapsedFeedRepository implements FeedRepository {
  _LapsedFeedRepository({this.reason = 'trial_ended'});

  final String reason;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async => throw ApiException(
    statusCode: 403,
    body: jsonEncode({
      'error':
          "Your organization's trial has ended. Subscribe to Team to "
          'restore team features.',
      'code': 'org_teams_lapsed',
      'lapseReason': reason,
      'requiredPlanName': 'Team',
      'trialEndedAt': '2026-08-01T00:00:00.000Z',
    }),
  );

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

final class _CallbackFeedRepository implements FeedRepository {
  _CallbackFeedRepository(this.respond, {this.sharing});

  final Future<FeedPageResponse> Function(String? cursor) respond;
  final FeedSharingStatus? sharing;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) => respond(cursor);

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => sharing;
}
