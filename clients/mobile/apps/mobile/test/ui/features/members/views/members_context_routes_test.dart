import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildCloudChatModels,
        buildNoOrganizationShellProviders,
        buildOrganizationShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_scope.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';
import 'package:mobile/ui/features/organizations/views/org_settings_screen.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_teams_screen.dart';
import 'package:provider/provider.dart';

import '../../../../support/settings_root_providers.dart';
import '../../../../support/workspace_context_fixture.dart';
import '../../../../support/account_organizations_fixture.dart';

/// CAN-4429: Organization settings and Sub-teams are pushed from Members with
/// the organization's view models. When the context leaves that organization,
/// main.dart disposes those models with the organization subtree, so the
/// pushed screen must close instead of showing the old organization.
void main() {
  setUp(() {
    // Empty base URLs: every repository builder resolves to its mock.
    AppConfig.configureEnvironmentController(
      ApiEnvironmentController(
        productionBaseUrl: '',
        stagingBaseUrl: '',
        initialEnvironment: ApiEnvironment.production,
        preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
      ),
    );
  });

  final routes = {
    'Organization settings': OrgSettingsScreen,
    'Sub-teams': SubTeamsScreen,
  };

  for (final MapEntry(key: label, value: screen) in routes.entries) {
    group('$label pushed from Members', () {
      testWidgets(
        'closes to the organization picker when a rename reload drops the '
        'organization',
        (tester) async {
          final held = Completer<List<OrganizationSummary>>();
          final auth = await _signedInToOrgA(tester, held);
          await _renameAndOpen(tester, auth, label, screen);

          held.complete([
            workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
          ]);
          await tester.pumpAndSettle();

          expect(auth.workspaceContext, const WorkspaceContext.personal());
          expect(tester.takeException(), isNull);
          expect(find.byType(screen), findsNothing);
          expect(
            find.byKey(const ValueKey('organization-context-gate')),
            findsOneWidget,
          );
          expect(_rootCanPop(tester), isFalse);
        },
      );

      testWidgets(
        'closes to the membership retry state when a rename reload fails',
        (tester) async {
          final held = Completer<List<OrganizationSummary>>();
          final auth = await _signedInToOrgA(tester, held);
          await _renameAndOpen(tester, auth, label, screen);

          held.completeError(Exception('offline'));
          await tester.pumpAndSettle();

          expect(auth.organizationsLoadFailed, isTrue);
          expect(tester.takeException(), isNull);
          expect(find.byType(screen), findsNothing);
          expect(find.text("Couldn't load your organizations"), findsOneWidget);
          expect(_rootCanPop(tester), isFalse);
        },
      );

      testWidgets('closes to the new organization\'s Members on a switch', (
        tester,
      ) async {
        final auth = await _signedInToOrgA(tester, null);
        await _openFromMembers(tester, label);
        expect(find.byType(screen), findsOneWidget);

        await tester.runAsync(
          () => auth.selectWorkspaceContext(
            const WorkspaceContext.organization(workspaceContextOrgB),
          ),
        );
        await tester.pumpAndSettle();

        expect(tester.takeException(), isNull);
        expect(find.byType(screen), findsNothing);
        expect(find.byType(MembersScreen), findsOneWidget);
        expect(_rootCanPop(tester), isFalse);
      });
    });
  }

  testWidgets('a dialog opened from Sub-teams closes with it', (tester) async {
    final held = Completer<List<OrganizationSummary>>();
    final auth = await _signedInToOrgA(tester, held);
    await _renameAndOpen(tester, auth, 'Sub-teams', SubTeamsScreen);
    await tester.tap(find.byTooltip('Create sub-team'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'Platform');

    held.complete([
      workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
    ]);
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.byType(Dialog), findsNothing);
    expect(find.byType(SubTeamsScreen), findsNothing);
    expect(
      find.byKey(const ValueKey('organization-context-gate')),
      findsOneWidget,
    );
    expect(_rootCanPop(tester), isFalse);
  });
}

/// Signs in, selects organization A and opens Members. Organization loads
/// after sign-in wait on [held] when given.
Future<AuthViewModel> _signedInToOrgA(
  WidgetTester tester,
  Completer<List<OrganizationSummary>>? held,
) async {
  var signedIn = false;
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
    loadOrganizations: teamsOnly(
      () => signedIn && held != null
          ? held.future
          : Future.value(workspaceContextOrganizations()),
    ),
  );
  addTearDown(auth.dispose);
  await tester.runAsync(
    () => auth.signIn(email: 'a@b.dev', password: 'password'),
  );
  signedIn = true;
  await tester.runAsync(
    () => auth.selectWorkspaceContext(
      const WorkspaceContext.organization(workspaceContextOrgA),
    ),
  );
  expect(auth.activeOrgId, workspaceContextOrgA);

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        workspaceContextProvider(),
        ...settingsRootTestProviders(),
      ],
      child: CloudChatScope(
        create: buildCloudChatModels,
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const _AuthenticatedShell(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();

  await tester.tap(find.byTooltip('Open navigation menu'));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('home-settings-button')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('account-nav-members')));
  await tester.pumpAndSettle();
  expect(find.byType(MembersScreen), findsOneWidget);
  return auth;
}

/// Renames the organization, which starts the held membership reload, then
/// opens [label] before that reload finishes.
Future<void> _renameAndOpen(
  WidgetTester tester,
  AuthViewModel auth,
  String label,
  Type screen,
) async {
  await tester.tap(find.byTooltip('More'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Rename organization'));
  await tester.pumpAndSettle();
  await tester.enterText(find.byType(TextField), 'Acme Labs');
  await tester.tap(find.text('Save'));
  await tester.pumpAndSettle();
  expect(auth.isLoadingOrganizations, isTrue);

  await _openFromMembers(tester, label);
  expect(find.byType(screen), findsOneWidget);
}

Future<void> _openFromMembers(WidgetTester tester, String label) async {
  await tester.tap(find.byTooltip('More'));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

bool _rootCanPop(WidgetTester tester) =>
    tester.state<NavigatorState>(find.byType(Navigator).first).canPop();

/// The authenticated part of main.dart's `AuthGate`: the shell mode follows
/// auth, and the organization view models live in a subtree keyed by the
/// active organization, so leaving it disposes them.
class _AuthenticatedShell extends StatelessWidget {
  const _AuthenticatedShell();

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    final orgId = auth.activeOrgId;
    final mode = resolveAuthenticatedShellMode(
      hasApiConfig: true,
      orgId: orgId,
      hasOrganizations: auth.organizations.isNotEmpty,
      hasPersonalOrganization: auth.personalOrganizationId != null,
      organizationsLoadFailed: auth.organizationsLoadFailed,
    );
    final shell = HomeShell(
      refreshActivity: refreshActivityFeed,
      activityAccount: watchActivityAccount,

      membersTab: membersTabForShellMode(
        mode,
        hasTeams: auth.organizations.isNotEmpty,
      ),
    );
    return MultiProvider(
      providers: buildSharedShellProviders(),
      child: HomeTabControllerProvider(
        tabs: homeTabsForShellMode(
          mode,
          hasTeams: auth.organizations.isNotEmpty,
        ),
        initialTab: landingTabForShellMode(mode, cloudAvailable: null),
        child: switch (mode) {
          AuthenticatedShellMode.organizationsUnavailable ||
          AuthenticatedShellMode.guest => shell,
          AuthenticatedShellMode.noOrganization => MultiProvider(
            providers: buildNoOrganizationShellProviders(),
            child: shell,
          ),
          AuthenticatedShellMode.personal => KeyedSubtree(
            key: const ValueKey('personal-context'),
            child: shell,
          ),
          AuthenticatedShellMode.organization => KeyedSubtree(
            key: ValueKey(orgId),
            child: MultiProvider(
              providers: buildOrganizationShellProviders(orgId),
              child: shell,
            ),
          ),
        },
      ),
    );
  }
}
