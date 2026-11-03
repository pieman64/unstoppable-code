import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_teams_screen.dart';

void main() {
  group('SubTeamsScreen', () {
    // Always drive the screen at a real phone width/height so any RenderFlex
    // overflow surfaces as a test exception instead of being hidden by an
    // oversized default viewport.
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget buildSubject({SubTeamsRepository? repository}) {
      return ChangeNotifierProvider<SubTeamsViewModel>(
        create: (_) => SubTeamsViewModel(
          repository:
              repository ?? MockSubTeamsRepository(latency: Duration.zero),
        ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const SubTeamsScreen(),
        ),
      );
    }

    testWidgets('renders the sub-team list after load', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Sub-teams'), findsWidgets);
      expect(find.text('Frontend'), findsOneWidget);
      expect(find.text('Backend'), findsOneWidget);
      final refreshIndicator = tester.widget<RefreshIndicator>(
        find.byType(RefreshIndicator),
      );
      expect(
        refreshIndicator.edgeOffset,
        CanopyScaffold.contentPaddingOf(
          tester.element(find.byType(RefreshIndicator)),
        ).top,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('refreshes when mounted with a previously loaded view model', (
      tester,
    ) async {
      usePhoneViewport(tester);
      final repository = _CountingSubTeamsRepository();
      final viewModel = SubTeamsViewModel(repository: repository);
      addTearDown(viewModel.dispose);

      await viewModel.load();
      expect(repository.fetchCount, 1);

      await tester.pumpWidget(
        ChangeNotifierProvider<SubTeamsViewModel>.value(
          value: viewModel,
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const SubTeamsScreen(),
          ),
        ),
      );
      await tester.pump();

      expect(repository.fetchCount, 2);
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the create action for an admin viewer', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byTooltip('Create sub-team'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('hides management affordances for a member viewer', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        buildSubject(
          repository: MockSubTeamsRepository(
            latency: Duration.zero,
            viewerRole: OrganizationRole.member,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Read-only: no create action and no per-row overflow menu.
      expect(find.byTooltip('Create sub-team'), findsNothing);
      expect(find.byIcon(Icons.more_vert), findsNothing);
      // But the list still renders.
      expect(find.text('Frontend'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('creates a sub-team via the app-bar action', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Create sub-team'));
      await tester.pumpAndSettle();

      expect(find.text('Create sub-team'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Platform');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();

      expect(find.text('Platform'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('renames a sub-team from its overflow menu', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final row = find.ancestor(
        of: find.text('Frontend'),
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: row, matching: find.byIcon(Icons.more_vert)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Rename…'));
      await tester.pumpAndSettle();

      expect(find.text('Rename sub-team'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'Web');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      expect(find.text('Web'), findsOneWidget);
      expect(find.text('Frontend'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('deletes a sub-team after confirmation', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final row = find.ancestor(
        of: find.text('Backend'),
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: row, matching: find.byIcon(Icons.more_vert)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Delete…'));
      await tester.pumpAndSettle();

      expect(find.text('Delete sub-team'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
      await tester.pumpAndSettle();

      expect(find.text('Backend'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('manages membership via the picker sheet', (tester) async {
      usePhoneViewport(tester);
      late SubTeamsViewModel viewModel;
      await tester.pumpWidget(
        ChangeNotifierProvider<SubTeamsViewModel>(
          create: (_) {
            viewModel = SubTeamsViewModel(
              repository: MockSubTeamsRepository(latency: Duration.zero),
            );
            return viewModel;
          },
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const SubTeamsScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Frontend starts with 2 members in the mock seed.
      final row = find.ancestor(
        of: find.text('Frontend'),
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: row, matching: find.byIcon(Icons.more_vert)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Manage members…'));
      await tester.pumpAndSettle();

      expect(find.text('Members of Frontend'), findsOneWidget);

      // Toggle Jordan Lee (not in the team) on, then save.
      await tester.tap(find.widgetWithText(CheckboxListTile, 'Jordan Lee'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      final jordan = viewModel.members.firstWhere(
        (m) => m.name == 'Jordan Lee',
      );
      expect(jordan.subTeamIds.contains('team-fe'), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows an error state and retries', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        buildSubject(repository: _FailingSubTeamsRepository()),
      );
      await tester.pumpAndSettle();

      expect(find.text('Could not load sub-teams'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pumpAndSettle();

      // Still failing, so the error state persists (no crash).
      expect(find.text('Could not load sub-teams'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}

final class _FailingSubTeamsRepository implements SubTeamsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> createSubTeam(String name) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) => Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) =>
      Future.error(StateError('boom'));

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) => Future.error(StateError('boom'));
}

final class _CountingSubTeamsRepository implements SubTeamsRepository {
  int fetchCount = 0;
  final OrganizationDetail _org = const OrganizationDetail(
    id: 'org-1',
    name: 'Acme Engineering',
    viewerRole: OrganizationRole.admin,
    canViewUsageStats: true,
    githubConnection: OrganizationGitHubConnectionDetail(connected: false),
    usageStatsMinRole: OrganizationRole.member,
    subTeams: [
      OrganizationSubTeam(id: 'team-fe', memberCount: 1, name: 'Frontend'),
    ],
    members: [
      OrganizationMember(
        id: 'u1',
        name: 'Alex Rivera',
        email: 'alex@acme.dev',
        role: OrganizationRole.owner,
        subTeamIds: ['team-fe'],
      ),
    ],
  );

  @override
  Future<OrganizationDetail> fetchOrganization() {
    fetchCount += 1;
    return Future.value(_org);
  }

  @override
  Future<OrganizationDetail> createSubTeam(String name) => Future.value(_org);

  @override
  Future<OrganizationDetail> renameSubTeam({
    required String teamId,
    required String name,
  }) => Future.value(_org);

  @override
  Future<OrganizationDetail> deleteSubTeam(String teamId) => Future.value(_org);

  @override
  Future<OrganizationDetail> setMembership({
    required String teamId,
    required List<String> memberUserIds,
  }) => Future.value(_org);
}
