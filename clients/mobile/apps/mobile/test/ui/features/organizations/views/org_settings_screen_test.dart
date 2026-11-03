import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/organizations/views/org_settings_screen.dart';

void main() {
  group('OrgSettingsScreen', () {
    // Phone-width viewport so any RenderFlex overflow surfaces as a real
    // exception instead of being hidden by an oversized test surface.
    void usePhoneViewport(WidgetTester tester) {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);
    }

    Widget buildSubject({OrgSettingsRepository? repository}) {
      return ChangeNotifierProvider<OrgSettingsViewModel>(
        create: (_) => OrgSettingsViewModel(
          repository:
              repository ?? MockOrgSettingsRepository(latency: Duration.zero),
        ),
        child: MaterialApp(
          theme: AppTheme.light,
          darkTheme: AppTheme.dark,
          home: const OrgSettingsScreen(),
        ),
      );
    }

    testWidgets('renders the enforced-sync toggles after load', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Organization settings'), findsOneWidget);
      expect(find.text('Required member settings'), findsOneWidget);
      expect(find.text('Transcripts'), findsOneWidget);
      expect(find.text('Session summaries'), findsOneWidget);
      expect(find.text('Plans'), findsOneWidget);
      expect(find.text('Usage details'), findsOneWidget);
      // Four scopes: the config PATCH is a full replacement, so every scope the
      // server stores needs a row here rather than being silently rewritten.
      expect(find.byType(SwitchListTile), findsNWidgets(4));
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

    testWidgets('reflects the seeded scope values on the switches', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      final plans = tester.widget<SwitchListTile>(
        find.ancestor(
          of: find.text('Plans'),
          matching: find.byType(SwitchListTile),
        ),
      );
      final transcripts = tester.widget<SwitchListTile>(
        find.ancestor(
          of: find.text('Transcripts'),
          matching: find.byType(SwitchListTile),
        ),
      );
      // Mock seed: plans enforced, transcripts not.
      expect(plans.value, isTrue);
      expect(transcripts.value, isFalse);
    });

    testWidgets('toggling a scope updates the view model', (tester) async {
      usePhoneViewport(tester);
      late OrgSettingsViewModel viewModel;
      await tester.pumpWidget(
        ChangeNotifierProvider<OrgSettingsViewModel>(
          create: (_) {
            viewModel = OrgSettingsViewModel(
              repository: MockOrgSettingsRepository(latency: Duration.zero),
            );
            return viewModel;
          },
          child: MaterialApp(
            theme: AppTheme.light,
            home: const OrgSettingsScreen(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(viewModel.isScopeEnforced(EnforcedSyncScope.transcripts), isFalse);

      await tester.tap(
        find.ancestor(
          of: find.text('Transcripts'),
          matching: find.byType(SwitchListTile),
        ),
      );
      await tester.pumpAndSettle();

      expect(viewModel.isScopeEnforced(EnforcedSyncScope.transcripts), isTrue);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows the connected GitHub row with a Disconnect action', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('GitHub connection'), findsOneWidget);
      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Installed on acme-eng'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Disconnect'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('disconnect confirms and clears the connection', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(TextButton, 'Disconnect'));
      await tester.pumpAndSettle();

      // Confirmation dialog.
      expect(find.text('Disconnect GitHub'), findsWidgets);
      await tester.tap(find.widgetWithText(FilledButton, 'Disconnect'));
      await tester.pumpAndSettle();

      // Row flips to the disconnected state.
      expect(find.text('Not connected'), findsOneWidget);
      expect(find.text('Connected'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders the disconnected state when not connected', (
      tester,
    ) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        buildSubject(
          repository: MockOrgSettingsRepository(
            latency: Duration.zero,
            githubConnection: const OrganizationGitHubConnectionDetail(
              connected: false,
              accountLogin: null,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Not connected'), findsOneWidget);
      // Connect is deferred to the web app; no Disconnect action here.
      expect(find.widgetWithText(TextButton, 'Disconnect'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows a no-access state for a member viewer', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(
        buildSubject(
          repository: MockOrgSettingsRepository(
            latency: Duration.zero,
            viewerRole: OrganizationRole.member,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text(
          'Only organization owners and admins can change these settings.',
        ),
        findsOneWidget,
      );
      expect(find.byType(SwitchListTile), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('shows an error state when the load fails', (tester) async {
      usePhoneViewport(tester);
      await tester.pumpWidget(buildSubject(repository: _FailingRepository()));
      await tester.pumpAndSettle();

      expect(find.text('Could not load organization settings'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}

final class _FailingRepository implements OrgSettingsRepository {
  @override
  Future<OrganizationDetail> fetchOrganization() async =>
      throw StateError('fetch failed');

  @override
  Future<EnforcedSyncScopes> setEnforcedSync(EnforcedSyncScopes scopes) =>
      throw UnimplementedError();

  @override
  Future<void> disconnectGitHub() => throw UnimplementedError();
}
