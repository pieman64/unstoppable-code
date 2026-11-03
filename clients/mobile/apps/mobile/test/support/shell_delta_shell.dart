/// CAN-4874: the production authenticated shell with Remote Control paired
/// to a synthetic Portal desktop ([FakePortalSessionServer]) whose cowork
/// project holds standalone chats. Shared by the device flow and its capture
/// harness, so both exercise the same composition and the same deltas.
///
/// The server's shell state follows every delta pushed through
/// [pushShellDeltas], as the server cache does, so an overview read always
/// returns the current rows. Rows and labels are synthetic test data.
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show
        buildOrganizationShellProviders,
        buildProviderUsageSourceProvider,
        buildSharedShellProviders,
        refreshActivityFeed,
        watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/authenticated_shell.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import 'cloud_chat_providers.dart';
import 'portal_shell_cache_model.dart';
import 'remote_session_fake_server.dart';
import 'settings_root_providers.dart';
import 'usage_limits_shell.dart' show proveUsageLimitsDelivery;

const String shellDeltaSessionId = 'sess-shell';
const String shellDeltaCoworkName = 'Cowork';

/// The desktop's cached rows when the phone connects.
List<Map<String, dynamic>> shellDeltaInitialEntities() => [
  {
    'entityType': 'workspace',
    'localId': 'ws-1',
    'payload': {'name': 'Repository', 'type': 'single-repo', 'order': 1},
  },
  {
    'entityType': 'workspace',
    'localId': 'ws-cowork',
    'payload': {'name': shellDeltaCoworkName, 'type': 'cowork', 'order': 2},
  },
  shellDeltaWorktree('wt-1', label: 'koala', unread: true),
  shellDeltaWorktree('wt-2', label: 'lynx'),
  shellDeltaChat(
    'sc-1',
    title: 'Plan launch',
    active: true,
    lastMessageAt: '2026-10-25T10:00:00.000Z',
  ),
  shellDeltaChat(
    'sc-2',
    title: 'Write notes',
    lastMessageAt: '2026-10-25T09:00:00.000Z',
  ),
  {
    'entityType': 'chat_summary',
    'localId': 'chat-1',
    'parentLocalId': 'ws-1:wt-1',
    'payload': {
      'chatId': 'chat-1',
      'scope': 'worktree',
      'workspaceLocalId': 'ws-1',
      'worktreeLocalId': 'wt-1',
      'title': 'Koala tab',
      'hasUnread': true,
      'lastMessageAt': '2026-10-25T08:00:00.000Z',
    },
  },
];

Map<String, dynamic> shellDeltaWorktree(
  String localId, {
  required String label,
  bool unread = false,
}) => {
  'entityType': 'worktree',
  'localId': localId,
  'parentLocalId': 'ws-1',
  'payload': {
    'workspaceLocalId': 'ws-1',
    'branch': 'feature/$label',
    'label': label,
    'status': 'active',
    if (unread) 'hasUnread': true,
  },
};

Map<String, dynamic> shellDeltaChat(
  String localId, {
  required String title,
  required String lastMessageAt,
  bool active = false,
  bool unread = false,
}) => {
  'entityType': 'standalone_chat',
  'localId': localId,
  'parentLocalId': 'ws-cowork',
  'payload': {
    'projectLocalId': 'ws-cowork',
    'title': title,
    'lastMessageAt': lastMessageAt,
    'hasActiveChat': active,
    if (unread) 'hasUnread': true,
  },
};

/// The synthetic desktop and the server cache its reads project.
final class ShellDeltaDesktop {
  ShellDeltaDesktop() {
    cache
      ..seed(shellDeltaInitialEntities())
      ..cursor = 100;
    server.addSession(
      id: shellDeltaSessionId,
      clientName: 'Studio',
      eventCursor: 100,
      shellState: cache.overviewState(),
    );
  }

  final server = FakePortalSessionServer();
  final cache = PortalShellCacheModel();

  /// Overview reads (`GET .../state`) the phone has sent so far.
  int get stateReads => [
    for (final request in server.requestsFor(shellDeltaSessionId))
      if (request.startsWith('GET ') && request.contains('/state')) request,
  ].length;

  /// Sends [payloads] as cursored `portal.state.delta` events in one batch,
  /// and applies them to the server cache that later reads return.
  void pushShellDeltas(List<Map<String, dynamic>> payloads) {
    final row = server.row(shellDeltaSessionId);
    final events = [
      for (final (index, payload) in payloads.indexed)
        {
          'type': 'portal.state.delta',
          'eventId': 'ev-${row.eventCursor + index + 1}',
          'cursor': row.eventCursor + index + 1,
          'payload': payload,
        },
    ];
    for (final event in events) {
      cache.applyDelta(
        event['payload']! as Map<String, dynamic>,
        cursor: event['cursor']! as int,
      );
    }
    row.shellState = cache.overviewState();
    server.push(shellDeltaSessionId, events);
  }
}

/// Pumps the shell on the Remote tab and waits until delivery is live.
Future<RemoteControlViewModel> pumpShellDeltaShell(
  WidgetTester tester, {
  required ShellDeltaDesktop desktop,
  required ThemeMode themeMode,
}) async {
  AppConfig.configureEnvironmentController(
    ApiEnvironmentController(
      productionBaseUrl: '',
      stagingBaseUrl: '',
      initialEnvironment: ApiEnvironment.production,
      preferenceStore: InMemoryApiEnvironmentPreferenceStore(),
    ),
  );
  final auth = AuthViewModel(
    repository: MockAuthRepository(latency: Duration.zero),
  );
  await tester.runAsync(() => auth.signInWithSocial(SocialProvider.google));
  final remote = RemoteControlViewModel(
    repository: desktop.server.repository(),
    stateRefreshDebounce: Duration.zero,
  );
  await tester.pumpWidget(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<AuthViewModel>.value(value: auth),
        ...buildSharedShellProviders(),
        // Later providers shadow earlier ones: the shell's Remote Control
        // view model is replaced by one paired to the synthetic desktop.
        ChangeNotifierProvider<RemoteControlViewModel>.value(value: remote),
        buildProviderUsageSourceProvider(),
        ...cloudChatTestProviders(),
        ...settingsRootTestProviders(),
        ...buildOrganizationShellProviders('org-1'),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light,
        darkTheme: AppTheme.dark,
        themeMode: themeMode,
        home: HomeTabControllerProvider(
          tabs: homeTabsForShellMode(
            AuthenticatedShellMode.organization,
            hasTeams: false,
          ),
          initialTab: HomeTab.remote,
          child: HomeShell(
            refreshActivity: refreshActivityFeed,
            activityAccount: watchActivityAccount,
            membersTab: membersTabForShellMode(
              AuthenticatedShellMode.organization,
              hasTeams: false,
            ),
          ),
        ),
      ),
    ),
  );
  for (var i = 0; i < 40 && !remote.isConnected; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(remote.isConnected, isTrue, reason: 'synthetic desktop paired');
  await proveUsageLimitsDelivery(
    tester,
    desktop.server,
    sessionId: shellDeltaSessionId,
  );
  await tester.pump(const Duration(milliseconds: 300));
  return remote;
}

/// Releases the fake server and the shell so no request outlives the test.
Future<void> unmountShellDeltaShell(
  WidgetTester tester,
  ShellDeltaDesktop desktop,
  RemoteControlViewModel remote,
) async {
  desktop.server.close();
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pump(const Duration(milliseconds: 100));
  remote.dispose();
}
