import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/views/organization_context_gate.dart';
import 'package:provider/provider.dart';

import '../../../../support/workspace_context_fixture.dart';
import '../../../../support/account_organizations_fixture.dart';

void main() {
  group('CAN-4429 OrganizationContextGate', () {
    Future<AuthViewModel> signIn(
      WidgetTester tester,
      List<OrganizationSummary> orgs,
    ) async {
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async => orgs),
      );
      addTearDown(auth.dispose);
      await tester.runAsync(
        () => auth.signIn(email: 'a@b.dev', password: 'password'),
      );
      return auth;
    }

    Widget host(AuthViewModel auth, {ThemeMode mode = ThemeMode.light}) =>
        ChangeNotifierProvider<AuthViewModel>.value(
          value: auth,
          child: MaterialApp(
            theme: AppTheme.light,
            darkTheme: AppTheme.dark,
            themeMode: mode,
            home: const OrganizationContextGate(
              title: 'Activity',
              child: Text('organization activity'),
            ),
          ),
        );

    final gate = find.byKey(const ValueKey('organization-context-gate'));

    for (final (label, mode) in const [
      ('light', ThemeMode.light),
      ('dark', ThemeMode.dark),
    ]) {
      testWidgets('Personal asks for an organization and switches ($label)', (
        tester,
      ) async {
        tester.view.physicalSize = const Size(1170, 2532);
        tester.view.devicePixelRatio = 3;
        addTearDown(tester.view.reset);
        final auth = await signIn(tester, workspaceContextOrganizations());
        await tester.pumpWidget(host(auth, mode: mode));

        expect(gate, findsOneWidget);
        expect(find.text('organization activity'), findsNothing);
        expect(find.text('Activity'), findsOneWidget);

        await tester.tap(find.text('Choose organization'));
        await tester.pumpAndSettle();
        // Organizations only: Personal is the current context.
        expect(
          find.byKey(const ValueKey('workspace-context-personal')),
          findsNothing,
        );
        await tester.tap(find.text('Bluebird'));
        await tester.pumpAndSettle();

        expect(auth.activeOrgId, workspaceContextOrgB);
        expect(gate, findsNothing);
        expect(find.text('organization activity'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('an organization context and a solo account pass through', (
      tester,
    ) async {
      final member = await signIn(tester, workspaceContextOrganizations());
      member.switchOrg(workspaceContextOrgA);
      await tester.pumpWidget(host(member));
      expect(find.text('organization activity'), findsOneWidget);

      final solo = await signIn(tester, const []);
      await tester.pumpWidget(host(solo));
      expect(find.text('organization activity'), findsOneWidget);
      expect(gate, findsNothing);
    });
  });
}
