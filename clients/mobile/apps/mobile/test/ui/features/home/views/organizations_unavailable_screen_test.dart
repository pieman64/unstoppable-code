import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/views/organizations_unavailable_screen.dart';
import '../../../../support/account_organizations_fixture.dart';

/// A phone-width viewport; the default 800x600 surface hides real overflow.
const Size _phone = Size(390, 844);

void main() {
  group('OrganizationsUnavailableScreen', () {
    Widget buildSubject({AuthViewModel? auth}) =>
        ChangeNotifierProvider<AuthViewModel>(
          create: (_) =>
              auth ??
              AuthViewModel(
                repository: MockAuthRepository(latency: Duration.zero),
              ),
          child: const MaterialApp(home: OrganizationsUnavailableScreen()),
        );

    testWidgets('explains that organizations could not be loaded', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text("Couldn't load your organizations"), findsOneWidget);
    });

    testWidgets(
      'never offers to create an organization, which could duplicate one the '
      'user already owns',
      (tester) async {
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
        expect(find.textContaining('Create'), findsNothing);
        expect(find.textContaining('New organization'), findsNothing);
      },
    );

    testWidgets('Retry re-resolves the active organization', (tester) async {
      var orgLoads = 0;
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          orgLoads++;
          return const <OrganizationSummary>[];
        }),
      );
      await tester.pumpWidget(buildSubject(auth: auth));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pumpAndSettle();

      expect(orgLoads, 1);
    });

    testWidgets(
      'Retry shows progress and refuses to stack duplicate requests while a '
      'load is in flight',
      (tester) async {
        final gate = Completer<List<OrganizationSummary>>();
        var calls = 0;
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            calls++;
            return gate.future;
          }),
        );
        await tester.pumpWidget(buildSubject(auth: auth));
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
        await tester.pump();

        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        expect(find.widgetWithText(FilledButton, 'Retry'), findsNothing);

        gate.complete(const <OrganizationSummary>[]);
        await tester.pumpAndSettle();

        // One tap, one request — the in-flight state is what prevents a user
        // from stacking them while nothing appears to happen.
        expect(calls, 1);
        expect(find.widgetWithText(FilledButton, 'Retry'), findsOneWidget);
      },
    );

    testWidgets(
      'a retry that fails again says so, rather than re-rendering a screen '
      'indistinguishable from nothing having happened',
      (tester) async {
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async => throw StateError('offline')),
        );
        await tester.pumpWidget(buildSubject(auth: auth));
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
        await tester.pumpAndSettle();

        expect(
          find.text("Still couldn't load your organizations."),
          findsOneWidget,
        );
      },
    );

    testWidgets('does not offer sign out, which lives on the Account tab', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('fits a phone-width viewport without overflow', (tester) async {
      tester.view.physicalSize = _phone;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });
}
