import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/protocol/generated/usage.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/stats_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/stats/view_models/stats_view_model.dart';
import 'package:mobile/ui/features/stats/views/stats_screen.dart';
import '../../../../support/account_organizations_fixture.dart';

/// [StatsRepository] that counts fetches, records the scope/team of each, and
/// delegates to the sample data, so a test can assert pull-to-refresh and scope
/// changes re-invoke the load with the right arguments.
final class _CountingStatsRepository implements StatsRepository {
  _CountingStatsRepository()
    : _delegate = MockStatsRepository(latency: Duration.zero);

  final MockStatsRepository _delegate;
  int fetchCount = 0;
  TelemetryUsageScope? lastScope;
  String? lastTeamId;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) {
    fetchCount++;
    lastScope = scope;
    lastTeamId = teamId;
    return _delegate.fetchUsage(
      window: window,
      granularity: granularity,
      scope: scope,
      teamId: teamId,
    );
  }
}

void main() {
  group('StatsScreen', () {
    Widget buildSubject({
      StatsRepository? statsRepository,
      bool withOrganizations = false,
      AuthViewModel? authViewModel,
    }) {
      return MultiProvider(
        providers: [
          if (authViewModel != null)
            ChangeNotifierProvider<AuthViewModel>.value(value: authViewModel)
          else
            ChangeNotifierProvider<AuthViewModel>(
              create: (_) {
                final auth = AuthViewModel(
                  repository: MockAuthRepository(latency: Duration.zero),
                  loadOrganizations: withOrganizations
                      ? teamsOnly(() async => _organizationSummaries)
                      : null,
                );
                if (withOrganizations) {
                  unawaited(
                    auth
                        .signIn(
                          email: 'viewer@example.com',
                          password: 'password',
                        )
                        .then(
                          (_) =>
                              auth.switchOrg(_organizationSummaries.first.id),
                        ),
                  );
                }
                return auth;
              },
            ),
          ChangeNotifierProvider<StatsViewModel>(
            create: (_) => StatsViewModel(
              repository: statsRepository ?? MockStatsRepository(),
            )..loadUsage(),
          ),
          ChangeNotifierProvider<MembersViewModel>(
            create: (_) => MembersViewModel(
              repository: MockMembersRepository(latency: Duration.zero),
            )..load(),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const StatsScreen(),
        ),
      );
    }

    testWidgets('shows a loading indicator while fetching', (tester) async {
      await tester.pumpWidget(buildSubject());
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.pumpAndSettle();
    });

    testWidgets('renders all seven tab labels after load', (tester) async {
      tester.view.physicalSize = const Size(1600, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byType(TabBar), findsOneWidget);
      expect(find.text('Overview'), findsWidgets);
      expect(find.text('Team Impact'), findsOneWidget);
      expect(find.text('Tokens'), findsOneWidget);
      expect(find.text('Observed cost'), findsWidgets);
      expect(find.text('Pipelines'), findsOneWidget);
      expect(find.text('Tools'), findsOneWidget);
      expect(find.text('Activity'), findsOneWidget);
    });

    testWidgets('pins the scrollable tab bar to the start (no leading gap)', (
      tester,
    ) async {
      // Realistic phone viewport (iPhone 13: 390x844 logical).
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final tabBar = tester.widget<TabBar>(find.byType(TabBar));
      expect(tabBar.isScrollable, isTrue);
      // Documents intent: a scrollable TabBar defaults to
      // TabAlignment.startOffset in Material 3, inserting a ~52px indent before
      // the first tab; it must be pinned to the start instead.
      expect(tabBar.tabAlignment, TabAlignment.start);

      // Behavioral guard: assert the rendered geometry, not just the property,
      // so the test fails if the indent reappears via any layout change. With
      // startOffset the "Overview" label sits ~52px + label padding (~68px)
      // from the TabBar's leading edge; with start only the label padding
      // (~16px) remains. A 40px threshold sits cleanly between the two states.
      final tabBarLeft = tester.getTopLeft(find.byType(TabBar)).dx;
      final overviewLabelLeft = tester
          .getTopLeft(
            find.descendant(
              of: find.byType(TabBar),
              matching: find.text('Overview'),
            ),
          )
          .dx;
      expect(overviewLabelLeft - tabBarLeft, lessThan(40.0));
    });

    testWidgets('overview tab still renders headline cards and runs', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Most expensive runs'), findsOneWidget);
      expect(find.text('Implement the activity feed screen'), findsOneWidget);
    });

    testWidgets('pull-to-refresh on a tab re-invokes the usage load', (
      tester,
    ) async {
      final repo = _CountingStatsRepository();
      await tester.pumpWidget(buildSubject(statsRepository: repo));
      await tester.pumpAndSettle();
      expect(repo.fetchCount, 1);

      // Over-drag the visible tab body downward: the vertical tab scroll is
      // nested under TabBarView's horizontal PageView, so the enclosing
      // RefreshIndicator must accept the depth-1 notification to fire.
      await tester.drag(find.byType(ListView).first, const Offset(0, 300));
      await tester.pump();
      await tester.pumpAndSettle();

      expect(repo.fetchCount, 2);
    });

    testWidgets('selecting a different time range reloads usage', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final repo = _CountingStatsRepository();
      await tester.pumpWidget(buildSubject(statsRepository: repo));
      await tester.pumpAndSettle();
      expect(repo.fetchCount, 1);

      // Open the range menu (defaults to '7d') and choose '30d'.
      await tester.tap(find.text('7d'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('30d'));
      await tester.pumpAndSettle();

      expect(repo.fetchCount, 2);
    });

    testWidgets('renders the scope selector as a compact AppBar action', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // The scope trigger stays icon-only so the dense action row does not
      // overflow at phone width.
      expect(find.byIcon(Icons.groups_outlined), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('does not overflow narrow AppBar with all actions visible', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // 390 logical px
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject(withOrganizations: true));
      await tester.pumpAndSettle();

      expect(find.byIcon(Icons.groups_outlined), findsOneWidget);
      expect(find.text('7d'), findsOneWidget);
      // The drawer owns the workspace context now (CAN-4429).
      expect(find.text('Org A'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('selecting a sub-team reloads usage scoped to that team', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532); // iPhone 13
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      final repo = _CountingStatsRepository();
      await tester.pumpWidget(buildSubject(statsRepository: repo));
      await tester.pumpAndSettle();
      expect(repo.fetchCount, 1);
      expect(repo.lastScope, TelemetryUsageScope.organization);

      // Open the compact scope menu and pick the 'Frontend' sub-team from the
      // mock org detail.
      await tester.tap(find.byIcon(Icons.groups_outlined));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Frontend'));
      await tester.pumpAndSettle();

      expect(repo.fetchCount, 2);
      expect(repo.lastScope, TelemetryUsageScope.team);
      expect(repo.lastTeamId, 'team-fe');
      expect(tester.takeException(), isNull);
    });

    testWidgets('a generic failure shows fixed copy and Retry, not a dump', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(statsRepository: _FailingStatsRepository()),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load stats'), findsOneWidget);
      expect(find.textContaining('ApiException'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a permission 403 shows the server sentence, not a lapse', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          statsRepository: _FailingStatsRepository(
            status: 403,
            body:
                '{"error":"You do not have permission to view usage '
                'statistics"}',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('You do not have permission to view usage statistics'),
        findsOneWidget,
      );
      expect(find.textContaining('is on hold'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a lapsed org shows an owner the on-hold state and CTA', (
      tester,
    ) async {
      final auth = await _seedAuth(role: OrganizationRole.owner);
      await tester.pumpWidget(
        buildSubject(
          statsRepository: _LapsedStatsRepository(),
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
      // The dead-end Retry from the old error state is gone.
      expect(find.widgetWithText(FilledButton, 'Retry'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a lapsed org tells a member to ask an owner, with no CTA', (
      tester,
    ) async {
      final auth = await _seedAuth(role: OrganizationRole.member);
      await tester.pumpWidget(
        buildSubject(
          statsRepository: _LapsedStatsRepository(),
          authViewModel: auth,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Acme is on hold'), findsOneWidget);
      expect(find.textContaining('Ask an organization owner'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });
}

const _organizationSummaries = [
  OrganizationSummary(
    id: 'org-1',
    memberCount: 5,
    name: 'Org A',
    role: OrganizationRole.owner,
    subTeamCount: 2,
  ),
  OrganizationSummary(
    id: 'org-2',
    memberCount: 3,
    name: 'Org B',
    role: OrganizationRole.member,
    subTeamCount: 0,
  ),
];

/// An [AuthViewModel] whose active organization is Acme, with the viewer
/// holding [role] — what the lapse copy branches on.
Future<AuthViewModel> _seedAuth({required OrganizationRole role}) async {
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
    loadOrganizations: teamsOnly(
      () async => [
        OrganizationSummary(
          id: 'org-lapsed',
          name: 'Acme',
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

/// Fails every fetch with an [ApiException], the shape a real failure has.
final class _FailingStatsRepository implements StatsRepository {
  _FailingStatsRepository({
    this.status = 503,
    this.body = '{"error":"Service unavailable"}',
  });

  final int status;
  final String body;

  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) async => throw ApiException(statusCode: status, body: body);
}

/// Fails with the coded org-billing 403 `requireOrgTeamsCapability` returns.
final class _LapsedStatsRepository implements StatsRepository {
  @override
  Future<TeamUsageResponse> fetchUsage({
    Duration? window,
    TelemetryTimeGranularity? granularity,
    TelemetryUsageScope? scope,
    String? teamId,
  }) async => throw ApiException(
    statusCode: 403,
    body: jsonEncode({
      'error':
          "Your organization's trial has ended. Subscribe to Team to restore "
          'team features.',
      'code': 'org_teams_lapsed',
      'lapseReason': 'trial_ended',
      'requiredPlanName': 'Team',
      'trialEndedAt': null,
    }),
  );
}
