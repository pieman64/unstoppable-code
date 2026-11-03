import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/members/views/members_screen.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import '../../../../support/account_organizations_fixture.dart';

void main() {
  group('MembersScreen', () {
    Widget buildSubject({
      MembersRepository? repository,
      AuthViewModel? authViewModel,
      OrgRepository? orgRepository,
    }) {
      return MultiProvider(
        providers: [
          authViewModel == null
              ? ChangeNotifierProvider<AuthViewModel>(
                  create: (_) =>
                      AuthViewModel(repository: MockAuthRepository()),
                )
              : ChangeNotifierProvider<AuthViewModel>.value(
                  value: authViewModel,
                ),
          ChangeNotifierProvider<MembersViewModel>(
            create: (_) => MembersViewModel(
              repository:
                  repository ?? MockMembersRepository(latency: Duration.zero),
            )..load(),
          ),
          // The app-bar overflow "Organization settings" item reads this to
          // hand it to the pushed screen, so the screen must be provided here.
          ChangeNotifierProvider<OrgSettingsViewModel>(
            create: (_) => OrgSettingsViewModel(
              repository: MockOrgSettingsRepository(latency: Duration.zero),
            ),
          ),
          // The app-bar overflow "Sub-teams" item reads this to hand it to the
          // pushed screen, so the screen must be provided here.
          ChangeNotifierProvider<SubTeamsViewModel>(
            create: (_) => SubTeamsViewModel(
              repository: MockSubTeamsRepository(latency: Duration.zero),
            ),
          ),
          ChangeNotifierProvider<OrgViewModel>(
            create: (_) => OrgViewModel(
              repository:
                  orgRepository ?? MockOrgRepository(latency: Duration.zero),
            ),
          ),
        ],
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const MembersScreen(),
        ),
      );
    }

    testWidgets('shows a loading indicator while fetching', (tester) async {
      await tester.pumpWidget(buildSubject());
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.pumpAndSettle();
    });

    testWidgets('renders members after load', (tester) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Members'), findsWidgets);
      expect(find.text('Alex Rivera'), findsOneWidget);
      expect(find.text('alex@acme.dev'), findsOneWidget);
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

    testWidgets('shows the add-member action for an admin viewer', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byTooltip('Add member'), findsOneWidget);
    });

    testWidgets('opens the invite sheet and creates an invite', (tester) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('Add member'));
      await tester.pumpAndSettle();
      expect(find.text('Add member'), findsOneWidget);

      await tester.enterText(find.byType(TextField), 'invitee@acme.dev');
      await tester.tap(find.widgetWithText(FilledButton, 'Send invite'));
      await tester.pumpAndSettle();

      expect(find.text('Invite created'), findsOneWidget);
    });

    testWidgets('member rows expose an overflow menu for an admin viewer', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // ADMIN viewer: at least one member (a MEMBER) is removable, so the
      // overflow menu button is present.
      expect(find.byIcon(Icons.more_vert), findsWidgets);
    });

    testWidgets('tapping a member row opens the member-detail drill-down', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Tap a member row (Sam Chen). In test/mock mode the row builds a
      // MockMemberDetailRepository and pushes the detail route.
      await tester.tap(find.text('Sam Chen'));
      await tester.pumpAndSettle();

      // The pushed detail screen renders its (top-of-body) plans section with
      // mock data, confirming navigation off the members list.
      expect(find.byKey(const Key('member-detail-plans')), findsOneWidget);
      expect(find.text('Activity feed rollout'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'hides "Change role…" for an admin viewer and hides "Remove…" for an '
      'equal-rank peer',
      (tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        // Priya Nair is an ADMIN, same rank as the ADMIN viewer: the viewer
        // cannot change roles (OWNER-only) and cannot remove an equal-rank
        // peer, so her row has no action available and renders no overflow
        // icon at all.
        expect(find.text('Priya Nair'), findsOneWidget);
        final priyaRow = find.ancestor(
          of: find.text('Priya Nair'),
          matching: find.byType(ListTile),
        );
        expect(
          find.descendant(of: priyaRow, matching: find.byIcon(Icons.more_vert)),
          findsNothing,
        );

        // Sam Chen is a MEMBER (lower rank): removable, but role change is
        // still unavailable because the viewer is ADMIN, not OWNER.
        expect(find.text('Sam Chen'), findsOneWidget);
        final samRow = find.ancestor(
          of: find.text('Sam Chen'),
          matching: find.byType(ListTile),
        );
        await tester.tap(
          find.descendant(of: samRow, matching: find.byIcon(Icons.more_vert)),
        );
        await tester.pumpAndSettle();

        expect(find.text('Change role…'), findsNothing);
        expect(find.text('Remove…'), findsOneWidget);
      },
    );

    testWidgets('remove action confirms and drops the member', (tester) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Sam Chen is a MEMBER — the ADMIN viewer can remove them.
      expect(find.text('Sam Chen'), findsOneWidget);
      final samRow = find.ancestor(
        of: find.text('Sam Chen'),
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: samRow, matching: find.byIcon(Icons.more_vert)),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Remove…'));
      await tester.pumpAndSettle();

      // Confirm dialog.
      expect(find.text('Remove member'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await tester.pumpAndSettle();

      expect(find.text('Sam Chen'), findsNothing);
    });

    testWidgets('renders the invitations-to-you section and accepts', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Seeded incoming invite (MockMembersRepository).
      expect(find.text('Invitations to you'), findsOneWidget);
      expect(find.text('Globex Labs'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(find.text('Globex Labs'), findsNothing);
    });

    testWidgets('accepting an invitation refreshes auth organizations', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      var refreshes = 0;
      final authViewModel = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          refreshes += 1;
          return const [
            OrganizationSummary(
              id: 'org-accepted',
              name: 'Globex Labs',
              role: OrganizationRole.member,
              memberCount: 1,
              subTeamCount: 0,
            ),
          ];
        }),
      );

      await tester.pumpWidget(buildSubject(authViewModel: authViewModel));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(find.text('Globex Labs'), findsNothing);
      expect(refreshes, 1);
      expect(authViewModel.organizations, hasLength(1));
    });

    testWidgets('declining an invitation confirms before removing it', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
      await tester.pumpAndSettle();

      expect(find.text('Decline invitation'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Decline'));
      await tester.pumpAndSettle();

      expect(find.text('Globex Labs'), findsNothing);
    });

    testWidgets(
      'accepting an enforced invitation requires consent before joining',
      (tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          buildSubject(
            repository: MockMembersRepository(
              latency: Duration.zero,
              incoming: const [
                IncomingInvitation(
                  id: 'incoming-enforced',
                  organizationName: 'Secure Org',
                  role: OrganizationRole.member,
                  enforcedSettings: EnforcedSyncScopes(
                    transcripts: true,
                    plans: true,
                    metadata: false,
                  ),
                ),
              ],
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
        await tester.pumpAndSettle();

        expect(find.text('Organization data sharing'), findsOneWidget);
        expect(find.text('Telemetry sync'), findsOneWidget);
        expect(find.text('- Transcripts'), findsOneWidget);
        expect(find.text('- Plans'), findsOneWidget);
        expect(find.text('Secure Org'), findsOneWidget);

        await tester.tap(find.widgetWithText(FilledButton, 'Accept').last);
        await tester.pumpAndSettle();

        expect(find.text('Secure Org'), findsNothing);
      },
    );

    testWidgets('disables mutation controls while an invitation action runs', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        buildSubject(
          repository: MockMembersRepository(
            latency: const Duration(milliseconds: 500),
            incoming: const [
              IncomingInvitation(
                id: 'incoming-slow',
                organizationName: 'Slow Org',
                role: OrganizationRole.member,
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pump();

      final accept = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Accept'),
      );
      final decline = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Decline'),
      );
      expect(accept.onPressed, isNull);
      expect(decline.onPressed, isNull);
      // The app-bar overflow menu (org lifecycle + usage-stats) disables while
      // an action runs, including its design-system trigger.
      expect(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.byWidgetPredicate(
            (w) =>
                w is CanopyIconButton &&
                w.tooltip == 'More' &&
                w.onPressed == null,
          ),
        ),
        findsOneWidget,
      );

      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
    });

    testWidgets(
      'does not render invitations section when incoming list is empty',
      (tester) async {
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<AuthViewModel>(
                create: (_) => AuthViewModel(repository: MockAuthRepository()),
              ),
              ChangeNotifierProvider<MembersViewModel>(
                create: (_) => MembersViewModel(
                  repository: MockMembersRepository(
                    latency: Duration.zero,
                    incoming: [],
                  ),
                )..load(),
              ),
              ChangeNotifierProvider<OrgViewModel>(
                create: (_) => OrgViewModel(
                  repository: MockOrgRepository(latency: Duration.zero),
                ),
              ),
            ],
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: const MembersScreen(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // "Invitations to you" heading should not render when list is empty.
        expect(find.text('Invitations to you'), findsNothing);

        // But the main member list should still render.
        expect(find.text('Alex Rivera'), findsOneWidget);
      },
    );

    testWidgets('app-bar overflow lets an admin set usage-stats visibility', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 2600);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // The app-bar overflow (admin+) is present.
      final appBarMenu = find.descendant(
        of: find.byType(CanopyAppBar),
        matching: find.byTooltip('More'),
      );
      expect(appBarMenu, findsOneWidget);

      await tester.tap(appBarMenu);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Usage-stats visibility'));
      await tester.pumpAndSettle();

      // Role picker opens with a Save action.
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      // Choose Admin and save.
      await tester.tap(find.text('Admin').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      // No crash; picker dismissed.
      expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
    });

    testWidgets(
      'app-bar overflow opens the Organization settings screen for an admin',
      (tester) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        await tester.tap(
          find.descendant(
            of: find.byType(CanopyAppBar),
            matching: find.byTooltip('More'),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Organization settings'), findsOneWidget);
        await tester.tap(find.text('Organization settings'));
        await tester.pumpAndSettle();

        // The pushed settings screen renders its enforced-sync section.
        expect(find.text('Required member settings'), findsOneWidget);
        expect(find.text('GitHub connection'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'app-bar overflow for a MEMBER viewer offers org lifecycle but not '
      'admin/owner-only items',
      (tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<AuthViewModel>(
                create: (_) => AuthViewModel(repository: MockAuthRepository()),
              ),
              ChangeNotifierProvider<MembersViewModel>(
                create: (_) => MembersViewModel(
                  repository: MockMembersRepository(
                    latency: Duration.zero,
                    viewerRole: OrganizationRole.member,
                  ),
                )..load(),
              ),
              ChangeNotifierProvider<OrgViewModel>(
                create: (_) => OrgViewModel(
                  repository: MockOrgRepository(latency: Duration.zero),
                ),
              ),
            ],
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: const MembersScreen(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // A MEMBER viewer cannot invite members (gated on the same permission
        // level), confirming the mock viewer really is downgraded.
        expect(find.byTooltip('Add member'), findsNothing);

        // The app-bar overflow still renders because "New organization" is
        // always available. Opening it shows the member-safe lifecycle items
        // (new org + leave) but hides the ADMIN+ rename, the OWNER-only delete,
        // and the ADMIN+ usage-stats item.
        final appBarMenu = find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.byTooltip('More'),
        );
        expect(appBarMenu, findsOneWidget);
        await tester.tap(appBarMenu);
        await tester.pumpAndSettle();

        expect(find.text('New organization'), findsOneWidget);
        expect(find.text('Leave organization'), findsOneWidget);
        expect(find.text('Rename organization'), findsNothing);
        expect(find.text('Delete organization'), findsNothing);
        expect(find.text('Usage-stats visibility'), findsNothing);
        expect(find.text('Organization settings'), findsNothing);
        expect(find.text('Sub-teams'), findsNothing);
      },
    );

    testWidgets(
      'setting usage-stats visibility updates the organization value',
      (tester) async {
        tester.view.physicalSize = const Size(1200, 2600);
        tester.view.devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);

        late MembersViewModel viewModel;
        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<AuthViewModel>(
                create: (_) => AuthViewModel(repository: MockAuthRepository()),
              ),
              ChangeNotifierProvider<MembersViewModel>(
                create: (_) {
                  viewModel = MembersViewModel(
                    repository: MockMembersRepository(latency: Duration.zero),
                  )..load();
                  return viewModel;
                },
              ),
              ChangeNotifierProvider<OrgViewModel>(
                create: (_) => OrgViewModel(
                  repository: MockOrgRepository(latency: Duration.zero),
                ),
              ),
            ],
            child: MaterialApp(
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              home: const MembersScreen(),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // Seeded mock org starts with usageStatsMinRole == member.
        expect(
          viewModel.organization?.usageStatsMinRole,
          OrganizationRole.member,
        );

        await tester.tap(
          find.descendant(
            of: find.byType(CanopyAppBar),
            matching: find.byTooltip('More'),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Usage-stats visibility'));
        await tester.pumpAndSettle();

        await tester.tap(find.text('Admin').last);
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Save'));
        await tester.pumpAndSettle();

        expect(
          viewModel.organization?.usageStatsMinRole,
          OrganizationRole.admin,
        );
      },
    );

    testWidgets('revoking an outgoing invite confirms and removes it', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1200, 3000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      // Seeded active outgoing invite (MockMembersRepository).
      expect(find.text('Pending invitations'), findsOneWidget);
      expect(find.text('newhire@acme.dev'), findsOneWidget);

      final inviteRow = find.ancestor(
        of: find.text('newhire@acme.dev'),
        matching: find.byType(ListTile),
      );
      await tester.tap(
        find.descendant(of: inviteRow, matching: find.byIcon(Icons.more_vert)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Revoke…'));
      await tester.pumpAndSettle();

      expect(find.text('Revoke invitation'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
      await tester.pumpAndSettle();

      expect(find.text('newhire@acme.dev'), findsNothing);
    });

    testWidgets('app-bar overflow shows "Delete organization" for an owner', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        buildSubject(
          repository: MockMembersRepository(
            latency: Duration.zero,
            viewerRole: OrganizationRole.owner,
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.byTooltip('More'),
        ),
      );
      await tester.pumpAndSettle();

      // OWNER sees the full lifecycle set, including the destructive delete.
      expect(find.text('New organization'), findsOneWidget);
      expect(find.text('Rename organization'), findsOneWidget);
      expect(find.text('Leave organization'), findsOneWidget);
      expect(find.text('Delete organization'), findsOneWidget);
    });

    testWidgets(
      'creating an organization reloads auth orgs and shows a snackbar',
      (tester) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3.0;
        addTearDown(tester.view.reset);

        var reloads = 0;
        final authViewModel = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            reloads += 1;
            // The org id MockOrgRepository.create mints (org-new-1) so the
            // post-create switchOrg resolves to a known org.
            return const [
              OrganizationSummary(
                id: 'org-new-1',
                name: 'Launchpad',
                role: OrganizationRole.owner,
                memberCount: 1,
                subTeamCount: 0,
              ),
            ];
          }),
        );

        await tester.pumpWidget(buildSubject(authViewModel: authViewModel));
        await tester.pumpAndSettle();

        await tester.tap(
          find.descendant(
            of: find.byType(CanopyAppBar),
            matching: find.byTooltip('More'),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('New organization'));
        await tester.pumpAndSettle();

        // Name dialog.
        expect(find.text('New organization'), findsWidgets);
        await tester.enterText(find.byType(TextField), 'Launchpad');
        await tester.tap(find.widgetWithText(FilledButton, 'Create'));
        await tester.pumpAndSettle();

        expect(find.text('Organization created'), findsOneWidget);
        expect(reloads, greaterThanOrEqualTo(1));
        expect(authViewModel.activeOrgId, 'org-new-1');
      },
    );

    testWidgets('app-bar overflow opens the Sub-teams screen for an admin', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AuthViewModel>(
              create: (_) => AuthViewModel(repository: MockAuthRepository()),
            ),
            ChangeNotifierProvider<MembersViewModel>(
              create: (_) => MembersViewModel(
                repository: MockMembersRepository(latency: Duration.zero),
              )..load(),
            ),
            // The Sub-teams entry point reads this ambient VM on tap (the same
            // way main.dart provides it lazily); it is not touched at build.
            ChangeNotifierProvider<SubTeamsViewModel>(
              create: (_) => SubTeamsViewModel(
                repository: MockSubTeamsRepository(latency: Duration.zero),
              ),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            home: const MembersScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.byType(CanopyAppBar),
          matching: find.byTooltip('More'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Sub-teams'), findsOneWidget);
      await tester.tap(find.text('Sub-teams'));
      await tester.pumpAndSettle();

      // The pushed Sub-teams screen loaded its own org and shows a sub-team.
      expect(find.text('Frontend'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
