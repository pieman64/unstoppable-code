// CAN-4429 visual evidence for the drawer's workspace context row at phone
// width: Personal, an organization with projects, and an empty organization,
// in light and dark mode. The assertions run in every suite; images are
// written only when capturing:
//
//   CAN4429_CAPTURE=1 flutter test --no-pub test/capture/can_4429_workspace_context_capture_test.dart --update-goldens
//
// The paired desktop is a deterministic fake repository with the synthetic
// Personal and organization projects of `workspace_context_fixture.dart`. No
// live account, desktop, agent, or network is involved. Output is written to
// the gitignored `<repo>/.playwright/can-4429/` directory.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/main.dart'
    show buildSharedShellProviders, refreshActivityFeed, watchActivityAccount;
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/workspace_context_provider.dart';
import 'package:mobile/ui/features/home/home_tab.dart';
import 'package:mobile/ui/features/home/home_tab_controller.dart';
import 'package:mobile/ui/features/home/views/home_shell.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:provider/provider.dart';

import '../support/cloud_chat_providers.dart';
import '../support/fake_remote_control_repository.dart';
import '../support/workspace_context_fixture.dart';
import '../support/account_organizations_fixture.dart';

final bool _captureEnabled = Platform.environment['CAN4429_CAPTURE'] == '1';

Future<void> _loadFont(String family, List<String> candidates) async {
  for (final path in candidates) {
    if (path.isEmpty) continue;
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = ByteData.sublistView(await file.readAsBytes());
    await (FontLoader(family)..addFont(Future.value(bytes))).load();
    return;
  }
}

final class _PairedRepository extends FakeRemoteControlRepository {
  _PairedRepository() {
    snapshotBuilder = () =>
        RemoteSessionSnapshot.fromJson(workspaceContextShellState());
  }

  @override
  Future<RemoteConnection?> restoreSession() async =>
      RemoteConnection(deviceLabel: 'Studio', pairedAt: DateTime(2026));
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    await _loadFont('Inter', const ['assets/fonts/inter/InterVariable.ttf']);
  });

  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    for (final (context, orgId) in const [
      ('personal', null),
      ('org-a', workspaceContextOrgA),
      ('org-b', workspaceContextOrgB),
    ]) {
      testWidgets('CAN-4429 drawer in $context (${mode.name})', (tester) async {
        tester.view.physicalSize = const Size(390, 844);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.reset);
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
          loadOrganizations: teamsOnly(
            () async => workspaceContextOrganizations(),
          ),
        );
        addTearDown(auth.dispose);
        await tester.runAsync(
          () => auth.signIn(email: 'a@b.dev', password: 'password'),
        );
        if (orgId != null) auth.switchOrg(orgId);
        final repository = _PairedRepository();
        addTearDown(repository.eventsController.close);

        await tester.pumpWidget(
          MultiProvider(
            providers: [
              ChangeNotifierProvider<AuthViewModel>.value(value: auth),
              workspaceContextProvider(),
              ...buildSharedShellProviders(),
              ChangeNotifierProvider<RemoteControlViewModel>(
                create: (_) => RemoteControlViewModel(repository: repository),
              ),
              ...cloudChatTestProviders(),
            ],
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: AppTheme.light,
              darkTheme: AppTheme.dark,
              themeMode: mode,
              home: HomeTabControllerProvider(
                tabs: const [HomeTab.cloud, HomeTab.remote, HomeTab.chat],
                initialTab: HomeTab.remote,
                child: const HomeShell(
                  refreshActivity: refreshActivityFeed,
                  activityAccount: watchActivityAccount,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Open navigation menu').first);
        await tester.pumpAndSettle();

        final drawer = find.byKey(const ValueKey('home-navigation-drawer'));
        final row = find.byKey(const ValueKey('home-workspace-context-row'));
        final label = switch (orgId) {
          null => 'Personal',
          workspaceContextOrgA => 'Acme',
          _ => 'Bluebird',
        };
        expect(find.descendant(of: row, matching: find.text(label)), findsOne);
        Finder recent(String title) =>
            find.descendant(of: drawer, matching: find.text(title));
        expect(
          recent('Personal task chat'),
          orgId == null ? findsOne : findsNothing,
        );
        expect(
          recent('Acme task chat'),
          orgId == workspaceContextOrgA ? findsOne : findsNothing,
        );
        expect(tester.takeException(), isNull);

        if (_captureEnabled) {
          Directory('../../.playwright/can-4429').createSync(recursive: true);
          await expectLater(
            find.byType(HomeShell),
            matchesGoldenFile(
              '../../../../.playwright/can-4429/'
              'can-4429-widget-drawer-$context-after-${mode.name}.png',
            ),
          );
        }
      });
    }
  }
}
