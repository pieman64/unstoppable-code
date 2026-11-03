import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/account_organizations.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/main.dart'
    show
        buildCloudChatModels,
        buildOrganizationShellProviders,
        buildPersonalShellProviders,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/services/push_message_coordinator.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_scope.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/push_tap_binding.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import '../../../support/can_3715_activity_fixture.dart';
import '../../../support/fake_remote_control_repository.dart';
import '../../../support/settings_root_providers.dart';
import '../../../support/workspace_context_fixture.dart';
import '../../../support/account_organizations_fixture.dart';

/// CAN-4429: a notification tap that cannot open a chat lands on a tab that
/// renders in the live context. In Personal with a Personal organization,
/// Activity shows the viewer's own work (CAN-3715), so the tap opens and
/// reloads it. In Personal without one, Activity asks the user to choose an
/// organization, so the tap leads to Remote instead.
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

  testWidgets('a disconnected tap in Personal without a Personal organization '
      'lands on Remote', (tester) async {
    final auth = await _signIn(tester, () async {
      return workspaceContextOrganizations();
    });
    expect(auth.workspaceContext, const WorkspaceContext.personal());
    final coordinator = await _pumpShell(tester, auth, connected: false);

    coordinator.requestOpen(
      const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'nope'}),
    );
    await tester.pumpAndSettle();

    expect(_tabs(tester).value, HomeTab.remote);
    expect(
      find.byKey(const ValueKey('organization-context-gate')),
      findsNothing,
    );
    expect(coordinator.pendingTap.value, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a refused switch in Personal without a Personal organization lands on '
    'Remote, and Retry opens the chat',
    (tester) async {
      // The account belongs to organization B only, so the switch to the
      // chat's owner, organization A, is refused.
      var organizations = [
        workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
      ];
      final auth = await _signIn(tester, () async => organizations);
      expect(auth.workspaceContext, const WorkspaceContext.personal());
      final coordinator = await _pumpShell(tester, auth, connected: true);

      coordinator.requestOpen(
        const PushMessage(data: {'clientChatId': 'chat-acme'}),
      );
      await tester.pumpAndSettle();

      expect(auth.workspaceContext, const WorkspaceContext.personal());
      expect(_tabs(tester).value, HomeTab.remote);
      expect(
        find.byKey(const ValueKey('organization-context-gate')),
        findsNothing,
      );
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(find.text("Couldn't switch context. Try again."), findsOneWidget);

      // The owner's membership appears; Retry switches first, then opens.
      organizations = workspaceContextOrganizations();
      await tester.runAsync(auth.reloadOrganizations);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();

      expect(
        auth.workspaceContext,
        const WorkspaceContext.organization(workspaceContextOrgA),
      );
      expect(find.byType(RemoteChatScreen), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('a disconnected tap in an organization keeps Activity', (
    tester,
  ) async {
    final auth = await _signIn(tester, () async {
      return workspaceContextOrganizations();
    });
    await tester.runAsync(
      () => auth.selectWorkspaceContext(
        const WorkspaceContext.organization(workspaceContextOrgA),
      ),
    );
    final coordinator = await _pumpShell(tester, auth, connected: false);

    coordinator.requestOpen(
      const PushMessage(data: {'worktreeId': 'nope', 'clientChatId': 'nope'}),
    );
    await tester.pumpAndSettle();

    expect(_tabs(tester).value, HomeTab.activity);
    expect(find.byType(FeedScreen), findsOneWidget);
    expect(coordinator.pendingTap.value, isNull);
    // The fallback also reloads Activity (CAN-3715); let the mock feed answer.
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
  });

  // CAN-3715: Personal Activity shows the Personal organization's feed, so a
  // tap that falls back to the feed opens it and reloads it, as it does in an
  // organization. The organization case is the control.
  for (final shape in _PersonalFeedShape.values) {
    for (final stacked in [false, true]) {
      testWidgets('a disconnected tap in ${shape.description} opens Activity '
          'and reloads it${stacked ? ' from a stacked route' : ''}', (
        tester,
      ) async {
        final auth = await _signInWithPersonal(tester, shape);
        final feed = Can3715FeedRepository(personal: auth.isPersonalActive);
        final coordinator = await _pumpShell(
          tester,
          auth,
          connected: false,
          feed: feed,
        );
        final reloadsBefore = await _leaveActivityForSettings(tester, feed);
        if (stacked) await _pushStackedRoute(tester);

        coordinator.requestOpen(
          const PushMessage(
            data: {'worktreeId': 'nope', 'clientChatId': 'nope'},
          ),
        );
        await tester.pumpAndSettle();
        await tester.pump(const Duration(seconds: 1));

        expect(find.byKey(const Key('stacked-route')), findsNothing);
        expect(_tabs(tester).value, HomeTab.activity);
        expect(find.byType(FeedScreen), findsOneWidget);
        expect(
          find.byKey(const ValueKey('organization-context-gate')),
          findsNothing,
        );
        expect(
          feed.cursors.length,
          greaterThan(reloadsBefore),
          reason: 'the fallback reloads the feed',
        );
        expect(coordinator.pendingTap.value, isNull);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets(
    'a refused switch in Personal with a Personal organization opens and '
    'reloads Activity, and offers Retry',
    (tester) async {
      // The account belongs to organization B only, so the switch to the
      // chat's owner, organization A, is refused.
      final auth = await _signIn(
        tester,
        () async => [
          workspaceContextOrganization(workspaceContextOrgB, 'Bluebird'),
        ],
        personalOrganizationId: can3715PersonalId,
      );
      expect(auth.isPersonalActive, isTrue);
      final feed = Can3715FeedRepository(personal: true);
      final coordinator = await _pumpShell(
        tester,
        auth,
        connected: true,
        feed: feed,
      );
      final reloadsBefore = await _leaveActivityForSettings(tester, feed);
      await _pushStackedRoute(tester);

      coordinator.requestOpen(
        const PushMessage(data: {'clientChatId': 'chat-acme'}),
      );
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 1));

      expect(auth.workspaceContext, const WorkspaceContext.personal());
      expect(find.byKey(const Key('stacked-route')), findsNothing);
      expect(_tabs(tester).value, HomeTab.activity);
      expect(find.byType(FeedScreen), findsOneWidget);
      expect(feed.cursors.length, greaterThan(reloadsBefore));
      expect(find.byType(RemoteChatScreen), findsNothing);
      expect(find.text("Couldn't switch context. Try again."), findsOneWidget);
      expect(coordinator.pendingTap.value, isNull);
      expect(tester.takeException(), isNull);
    },
  );
}

/// Accounts whose Activity shows a feed when a tap falls back to it.
enum _PersonalFeedShape {
  personalWithTeams('Personal with a Personal organization and a team'),
  soloPersonal('Personal with only a Personal organization'),
  organization('an organization of an account with a Personal organization');

  const _PersonalFeedShape(this.description);
  final String description;
}

Future<AuthViewModel> _signInWithPersonal(
  WidgetTester tester,
  _PersonalFeedShape shape,
) async {
  final auth = await _signIn(
    tester,
    () async => switch (shape) {
      _PersonalFeedShape.soloPersonal => const <OrganizationSummary>[],
      _ => workspaceContextOrganizations(),
    },
    personalOrganizationId: can3715PersonalId,
  );
  if (shape == _PersonalFeedShape.organization) {
    await tester.runAsync(
      () => auth.selectWorkspaceContext(
        const WorkspaceContext.organization(workspaceContextOrgA),
      ),
    );
  }
  expect(auth.isPersonalActive, shape != _PersonalFeedShape.organization);
  return auth;
}

/// Shows Activity once, then opens Settings, as a user who read the feed
/// earlier would be. Returns the feed requests made so far.
Future<int> _leaveActivityForSettings(
  WidgetTester tester,
  Can3715FeedRepository feed,
) async {
  _tabs(tester).select(HomeTab.activity);
  await tester.pumpAndSettle();
  expect(find.byType(FeedScreen), findsOneWidget);
  _tabs(tester).select(HomeTab.account);
  await tester.pumpAndSettle();
  expect(feed.cursors, isNotEmpty);
  return feed.cursors.length;
}

Future<void> _pushStackedRoute(WidgetTester tester) async {
  unawaited(
    Navigator.of(tester.element(find.byType(HomeShell))).push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(key: Key('stacked-route')),
      ),
    ),
  );
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('stacked-route')), findsOneWidget);
}

Future<AuthViewModel> _signIn(
  WidgetTester tester,
  Future<List<OrganizationSummary>> Function() loadOrganizations, {
  String? personalOrganizationId,
}) async {
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
    loadOrganizations: personalOrganizationId == null
        ? teamsOnly(loadOrganizations)
        : () async => AccountOrganizations(
            organizations: await loadOrganizations(),
            personalOrganizationId: personalOrganizationId,
          ),
  );
  addTearDown(auth.dispose);
  await tester.runAsync(
    () => auth.signIn(email: 'a@b.dev', password: 'password'),
  );
  return auth;
}

/// Mounts the authenticated shell the way main.dart composes it, with a
/// Remote Control model that is [connected] to the synthetic desktop. A
/// [feed] replaces the Activity feed's repository, so its requests count.
Future<PushMessageCoordinator> _pumpShell(
  WidgetTester tester,
  AuthViewModel auth, {
  required bool connected,
  Can3715FeedRepository? feed,
}) async {
  tester.view.physicalSize = const Size(1170, 2532);
  tester.view.devicePixelRatio = 3.0;
  addTearDown(tester.view.reset);
  final coordinator = PushMessageCoordinator(messaging: FakePushMessaging());
  unawaited(coordinator.start());
  addTearDown(() => unawaited(coordinator.dispose()));
  final remote = RemoteControlViewModel(
    repository: FakeRemoteControlRepository()
      ..snapshotBuilder = () =>
          RemoteSessionSnapshot.fromJson(workspaceContextShellState()),
    stateRefreshDebounce: Duration.zero,
  );
  addTearDown(remote.dispose);
  if (connected) await tester.runAsync(() => remote.connect('123456'));

  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        workspaceContextProvider(),
        ...settingsRootTestProviders(),
        ChangeNotifierProvider<TurnFeedbackController>(
          create: (_) =>
              TurnFeedbackController(repository: MockTurnFeedbackRepository()),
        ),
      ],
      child: CloudChatScope(
        create: buildCloudChatModels,
        child: MaterialApp(
          theme: AppTheme.light,
          home: _AuthenticatedShell(
            coordinator: coordinator,
            remote: remote,
            feed: feed,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return coordinator;
}

HomeTabController _tabs(WidgetTester tester) =>
    tester.element(find.byType(HomeShell)).read<HomeTabController>();

/// main.dart's `_shell` for the organization and Personal modes: the tap
/// binding sits above the subtree keyed by the active context, which mounts
/// the same providers as main.dart.
class _AuthenticatedShell extends StatelessWidget {
  const _AuthenticatedShell({
    required this.coordinator,
    required this.remote,
    this.feed,
  });

  final PushMessageCoordinator coordinator;
  final RemoteControlViewModel remote;
  final Can3715FeedRepository? feed;

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
    final feed = this.feed;
    final countedFeed = [
      if (feed != null)
        ChangeNotifierProvider<FeedViewModel>(
          create: (_) => FeedViewModel(repository: feed)..loadFeed(),
        ),
    ];
    final personalOrganizationId = auth.personalOrganizationId;
    return MultiProvider(
      providers: [
        ...buildSharedShellProviders(),
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
      ],
      child: HomeTabControllerProvider(
        tabs: homeTabsForShellMode(
          mode,
          hasTeams: auth.organizations.isNotEmpty,
        ),
        initialTab: HomeTab.account,
        child: PushTapBinding(
          coordinator: coordinator,
          selectWorkspaceContext: auth.selectWorkspaceContext,
          workspaceContext: () => auth.workspaceContext,
          personalActivityAvailable: () => auth.isPersonalActive,
          child: orgId == null
              ? KeyedSubtree(
                  key: ValueKey('personal-context:$personalOrganizationId'),
                  child: MultiProvider(
                    providers: [
                      ...buildPersonalShellProviders(personalOrganizationId),
                      if (personalOrganizationId != null) ...countedFeed,
                    ],
                    child: shell,
                  ),
                )
              : KeyedSubtree(
                  key: ValueKey(orgId),
                  child: MultiProvider(
                    providers: [
                      ...buildOrganizationShellProviders(orgId),
                      ...countedFeed,
                    ],
                    child: shell,
                  ),
                ),
        ),
      ),
    );
  }
}
