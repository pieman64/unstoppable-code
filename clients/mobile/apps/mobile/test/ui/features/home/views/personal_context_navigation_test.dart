import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';
import 'package:mobile/ui/features/stats/views/stats_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/can_3715_activity_fixture.dart';
import '../../../../support/fake_remote_control_repository.dart';

/// CAN-3715 AC-03 with the CAN-4429 workspace context: switching a team to
/// Personal keeps the current destination. Activity shows Personal work, and
/// the team-only destinations ask for an organization.
void main() {
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

  HomeTabController tabsOf(WidgetTester tester) =>
      Provider.of<HomeTabController>(
        tester.element(find.byType(Scaffold).first),
        listen: false,
      );

  Future<AuthViewModel> pumpTeamShell(
    WidgetTester tester, {
    required bool cloudAvailable,
    FeedSharingStatus? sharing,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532); // 390 logical
    tester.view.devicePixelRatio = 3.0;
    addTearDown(tester.view.reset);
    late AuthViewModel auth;
    await tester.runAsync(() async => auth = await can3715Auth());
    addTearDown(auth.dispose);
    await tester.pumpWidget(
      Can3715Shell(
        auth: auth,
        teamFeed: Can3715FeedRepository(personal: false, sharing: sharing),
        personalFeed: Can3715FeedRepository(personal: true),
        remote: FakeRemoteControlRepository(),
        cloudAvailable: cloudAvailable,
        initialTab: landingTabForShellMode(
          AuthenticatedShellMode.organization,
          cloudAvailable: cloudAvailable,
        ),
      ),
    );
    await tester.pumpAndSettle();
    return auth;
  }

  /// Opens [tab] in the team shell, then picks Personal from the drawer's
  /// workspace context row.
  Future<void> switchToPersonalFrom(
    WidgetTester tester,
    HomeTab tab,
    Type screen,
  ) async {
    tabsOf(tester).select(tab);
    await tester.pumpAndSettle();
    HomeNavigationScope.maybeOf(
      tester.element(find.byType(screen)),
    )!.openDrawer();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('home-workspace-context-row')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('workspace-context-personal')));
    await tester.pumpAndSettle();
  }

  testWidgets('View Personal on team Activity opens Personal Activity '
      '(AC-04)', (tester) async {
    final auth = await pumpTeamShell(
      tester,
      cloudAvailable: true,
      sharing: const FeedSharingStatus(
        metadata: FeedSharingState.private,
        plans: FeedSharingState.unknown,
        summaries: FeedSharingState.unknown,
      ),
    );
    tabsOf(tester).select(HomeTab.activity);
    await tester.pumpAndSettle();

    await tester.tap(find.text('View Personal'));
    await tester.pumpAndSettle();

    expect(auth.isPersonalActive, isTrue);
    expect(tabsOf(tester).value, HomeTab.activity);
    expect(find.textContaining('personal/work-0'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  for (final cloudAvailable in [true, false]) {
    final cloud = cloudAvailable ? 'cloud available' : 'cloud unavailable';

    testWidgets('Usage switched to Personal asks for an organization '
        '($cloud)', (tester) async {
      final auth = await pumpTeamShell(tester, cloudAvailable: cloudAvailable);

      await switchToPersonalFrom(tester, HomeTab.usage, StatsScreen);

      expect(auth.isPersonalActive, isTrue);
      expect(tabsOf(tester).value, HomeTab.usage);
      expect(
        find.byKey(const ValueKey('organization-context-gate')),
        findsOneWidget,
      );
      expect(find.byType(StatsScreen), findsNothing);
      expect(tester.takeException(), isNull);
    });

    for (final (tab, screen) in [
      (HomeTab.activity, FeedScreen),
      (HomeTab.members, MembersScreen),
    ]) {
      testWidgets('${tab.name} switched to Personal stays on '
          '${tab.name} ($cloud)', (tester) async {
        final auth = await pumpTeamShell(
          tester,
          cloudAvailable: cloudAvailable,
        );

        await switchToPersonalFrom(tester, tab, screen);

        expect(auth.isPersonalActive, isTrue);
        expect(tabsOf(tester).value, tab);
        if (tab == HomeTab.activity) {
          expect(find.textContaining('personal/work-0'), findsWidgets);
        } else {
          expect(
            find.byKey(const ValueKey('organization-context-gate')),
            findsOneWidget,
          );
        }
        expect(tester.takeException(), isNull);
      });
    }
  }
}
