import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/members/views/member_detail_screen.dart';
import 'package:provider/provider.dart';
import '../../../../support/account_organizations_fixture.dart';

const OrganizationMember _member = OrganizationMember(
  email: 'sam@acme.dev',
  id: 'member-1',
  name: 'Sam Chen',
  role: OrganizationRole.member,
  subTeamIds: [],
);

void main() {
  group('MemberDetailScreen', () {
    // Phone-width viewport: the detail screen stacks a header, a 2-up usage
    // grid, and three list sections, so it is overflow-prone. Every test runs
    // at 1170x2532 @3x and asserts no overflow via takeException.
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget buildSubject({
      required MemberDetailRepository repository,
      bool canViewStats = true,
      AuthViewModel? authViewModel,
    }) {
      return ChangeNotifierProvider<AuthViewModel>.value(
        value:
            authViewModel ??
            AuthViewModel(
              repository: MockAuthRepository(latency: Duration.zero),
            ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: MemberDetailScreen(
            repository: repository,
            member: _member,
            canViewStats: canViewStats,
          ),
        ),
      );
    }

    /// An [AuthViewModel] whose active organization is Acme, with the viewer
    /// holding [role] — what the lapse copy branches on.
    Future<AuthViewModel> seedAuth({required OrganizationRole role}) async {
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

    testWidgets('shows a loading indicator while fetching', (tester) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(
        buildSubject(
          repository: MockMemberDetailRepository(
            latency: const Duration(milliseconds: 200),
          ),
        ),
      );

      // Profile header is available immediately; the body is still loading.
      expect(find.text('Sam Chen'), findsWidgets);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders the profile header and every section', (tester) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(
        buildSubject(
          repository: MockMemberDetailRepository(latency: Duration.zero),
        ),
      );
      await tester.pumpAndSettle();

      // Header + first sections are on-screen at phone width.
      expect(find.text('Sam Chen'), findsWidgets);
      expect(find.text('sam@acme.dev'), findsOneWidget);
      expect(find.byKey(const Key('member-detail-usage')), findsOneWidget);
      expect(find.byKey(const Key('member-detail-plans')), findsOneWidget);
      expect(find.text('Activity feed rollout'), findsOneWidget);
      final refreshIndicator = tester.widget<RefreshIndicator>(
        find.byType(RefreshIndicator),
      );
      expect(
        refreshIndicator.edgeOffset,
        CanopyScaffold.contentPaddingOf(
          tester.element(find.byType(RefreshIndicator)),
        ).top,
      );

      // Lower sections are below the fold in a lazy ListView; scroll each into
      // view before asserting so overflow (if any) also surfaces here.
      final listView = find.byType(Scrollable).first;
      for (final entry in const [
        (Key('member-detail-approved-plans'), 'Wire the usage endpoint'),
        (Key('member-detail-pipelines'), 'Implementation Autopilot'),
      ]) {
        await tester.scrollUntilVisible(
          find.byKey(entry.$1),
          200,
          scrollable: listView,
        );
        await tester.pumpAndSettle();
        expect(find.byKey(entry.$1), findsOneWidget);
        expect(find.text(entry.$2), findsOneWidget);
      }

      expect(tester.takeException(), isNull);
    });

    testWidgets('hides the usage section when the viewer cannot view stats', (
      tester,
    ) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(
        buildSubject(
          repository: MockMemberDetailRepository(latency: Duration.zero),
          canViewStats: false,
        ),
      );
      await tester.pumpAndSettle();

      // The gated usage section is omitted; the ungated lists still render.
      expect(find.byKey(const Key('member-detail-usage')), findsNothing);
      expect(find.byKey(const Key('member-detail-plans')), findsOneWidget);

      expect(tester.takeException(), isNull);
    });

    testWidgets('renders empty-state copy when lists are empty', (
      tester,
    ) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(
        buildSubject(repository: _EmptyRepository(), canViewStats: false),
      );
      await tester.pumpAndSettle();

      expect(find.text('No shared plans.'), findsOneWidget);
      expect(find.text('No approved plans.'), findsOneWidget);
      expect(find.text('No shared pipelines.'), findsOneWidget);

      expect(tester.takeException(), isNull);
    });

    testWidgets('shows an error state with retry on failure', (tester) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(buildSubject(repository: _ThrowingRepository()));
      await tester.pumpAndSettle();

      expect(find.text('Could not load this member.'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);

      expect(tester.takeException(), isNull);
    });

    testWidgets('a generic failure shows fixed copy and Retry, not a dump', (
      tester,
    ) async {
      usePhoneViewport(tester);

      await tester.pumpWidget(
        buildSubject(repository: _FailingMemberDetailRepository()),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load this member.'), findsOneWidget);
      expect(find.textContaining('ApiException'), findsNothing);
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
          repository: _LapsedMemberDetailRepository(),
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
      expect(find.widgetWithText(FilledButton, 'Retry'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('a lapsed org tells a member to ask an owner, with no CTA', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final auth = await seedAuth(role: OrganizationRole.member);

      await tester.pumpWidget(
        buildSubject(
          repository: _LapsedMemberDetailRepository(),
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

final class _EmptyRepository implements MemberDetailRepository {
  @override
  Future<MemberDetailData> load({required bool canViewStats}) async =>
      const MemberDetailData(
        sharedPlans: [],
        approvedPlans: [],
        pipelines: [],
        usage: null,
      );
}

final class _ThrowingRepository implements MemberDetailRepository {
  @override
  Future<MemberDetailData> load({required bool canViewStats}) async {
    throw Exception('boom');
  }
}

/// Fails every load with an [ApiException], the shape a real failure has.
final class _FailingMemberDetailRepository implements MemberDetailRepository {
  @override
  Future<MemberDetailData> load({required bool canViewStats}) async =>
      throw const ApiException(
        statusCode: 503,
        body: '{"error":"Service unavailable"}',
      );
}

/// Fails with the coded org-billing 403 the gated usage rollup returns.
final class _LapsedMemberDetailRepository implements MemberDetailRepository {
  @override
  Future<MemberDetailData> load({required bool canViewStats}) async =>
      throw ApiException(
        statusCode: 403,
        body: jsonEncode({
          'error':
              "Your organization's trial has ended. Subscribe to Team to "
              'restore team features.',
          'code': 'org_teams_lapsed',
          'lapseReason': 'trial_ended',
          'requiredPlanName': 'Team',
          'trialEndedAt': null,
        }),
      );
}
