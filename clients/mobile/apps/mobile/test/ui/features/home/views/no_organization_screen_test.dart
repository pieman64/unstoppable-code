import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/repositories/incoming_invitations_repository.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/home/views/no_organization_screen.dart';
import 'package:mobile/ui/features/members/view_models/incoming_invitations_view_model.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import '../../../../support/account_organizations_fixture.dart';

/// A phone-width viewport; the default 800x600 surface hides real overflow.
const Size _phone = Size(390, 844);

void main() {
  group('NoOrganizationScreen', () {
    Widget buildSubject({
      required IncomingInvitationsRepository repository,
      AuthViewModel? auth,
      OrgRepository? orgRepository,
    }) => MultiProvider(
      providers: [
        ChangeNotifierProvider<IncomingInvitationsViewModel>(
          create: (_) =>
              IncomingInvitationsViewModel(repository: repository)..load(),
        ),
        ChangeNotifierProvider<AuthViewModel>(
          create: (_) =>
              auth ??
              AuthViewModel(
                repository: MockAuthRepository(latency: Duration.zero),
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
        home: const NoOrganizationScreen(),
      ),
    );

    IncomingInvitationsRepository noInvitations() =>
        MockIncomingInvitationsRepository(
          latency: Duration.zero,
          incoming: const [],
        );

    IncomingInvitationsRepository oneInvitation() =>
        MockIncomingInvitationsRepository(
          latency: Duration.zero,
          incoming: const [
            IncomingInvitation(
              id: 'x',
              organizationName: 'Globex Labs',
              role: OrganizationRole.member,
            ),
          ],
        );

    testWidgets('explains no organization when there are no invitations', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(repository: noInvitations()));
      await tester.pumpAndSettle();

      expect(find.text('No organization'), findsOneWidget);
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

    testWidgets(
      'offers to create an organization instead of only telling the user to '
      'ask someone else for an invite (CAN-2576)',
      (tester) async {
        await tester.pumpWidget(buildSubject(repository: noInvitations()));
        await tester.pumpAndSettle();

        expect(
          find.widgetWithText(FilledButton, 'Create an organization'),
          findsOneWidget,
        );
      },
    );

    testWidgets('does not offer sign out, which lives on the Account tab', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(repository: noInvitations()));
      await tester.pumpAndSettle();

      expect(find.text('Sign out'), findsNothing);
    });

    testWidgets('create opens the name prompt', (tester) async {
      await tester.pumpWidget(buildSubject(repository: noInvitations()));
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(FilledButton, 'Create an organization'),
      );
      await tester.pumpAndSettle();

      expect(find.text('New organization'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Create'), findsOneWidget);
    });

    testWidgets('creating an organization re-resolves the active org', (
      tester,
    ) async {
      var orgLoads = 0;
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          orgLoads++;
          return const <OrganizationSummary>[];
        }),
      );

      await tester.pumpWidget(
        buildSubject(repository: noInvitations(), auth: auth),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(FilledButton, 'Create an organization'),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Acme Engineering');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();

      expect(orgLoads, greaterThan(0));
    });

    testWidgets(
      'cancelling the create dialog does not reload organizations, so a failed '
      'load cannot flip this tab into the "couldn\'t load" shell',
      (tester) async {
        var orgLoads = 0;
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async {
            orgLoads++;
            return const <OrganizationSummary>[];
          }),
        );

        await tester.pumpWidget(
          buildSubject(repository: noInvitations(), auth: auth),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.widgetWithText(FilledButton, 'Create an organization'),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();

        expect(orgLoads, 0);
        expect(auth.organizationsLoadFailed, isFalse);
      },
    );

    testWidgets(
      'a create whose follow-up reload fails reports that honestly instead of '
      'claiming plain success next to the "couldn\'t load" shell',
      (tester) async {
        // The post-create reload is the first (and only) org load here, so it
        // must fail from the start.
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(() async => throw StateError('offline')),
        );

        await tester.pumpWidget(
          buildSubject(repository: noInvitations(), auth: auth),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.widgetWithText(FilledButton, 'Create an organization'),
        );
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Acme Engineering');
        await tester.tap(find.widgetWithText(FilledButton, 'Create'));
        await tester.pumpAndSettle();

        expect(
          find.text("Organization created, but we couldn't refresh it yet."),
          findsOneWidget,
        );
        expect(find.text('Organization created'), findsNothing);
      },
    );

    testWidgets(
      'a create whose follow-up reload 401s does not claim success over the '
      'sign-in screen',
      (tester) async {
        final auth = AuthViewModel(
          repository: MockAuthRepository(latency: Duration.zero),
          loadOrganizations: teamsOnly(
            () async =>
                throw const ApiException(statusCode: 401, body: 'unauthorized'),
          ),
        );

        await tester.pumpWidget(
          buildSubject(repository: noInvitations(), auth: auth),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.widgetWithText(FilledButton, 'Create an organization'),
        );
        await tester.pumpAndSettle();
        await tester.enterText(find.byType(TextField), 'Acme Engineering');
        await tester.tap(find.widgetWithText(FilledButton, 'Create'));
        await tester.pumpAndSettle();

        expect(auth.status, AuthStatus.unauthenticated);
        expect(find.text('Organization created'), findsNothing);
      },
    );

    testWidgets('shows a pending invitation with an accept action', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(repository: oneInvitation()));
      await tester.pumpAndSettle();

      expect(find.text('Globex Labs'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Accept'), findsOneWidget);
    });

    testWidgets(
      'still offers to create an organization when an invitation is pending, '
      'so an invite the user does not want is not the only way forward',
      (tester) async {
        await tester.pumpWidget(buildSubject(repository: oneInvitation()));
        await tester.pumpAndSettle();

        expect(
          find.widgetWithText(TextButton, 'Create an organization instead'),
          findsOneWidget,
        );
      },
    );

    testWidgets('accepting an invitation re-resolves the active org', (
      tester,
    ) async {
      var orgLoads = 0;
      final auth = AuthViewModel(
        repository: MockAuthRepository(latency: Duration.zero),
        loadOrganizations: teamsOnly(() async {
          orgLoads++;
          return const <OrganizationSummary>[];
        }),
      );

      await tester.pumpWidget(
        buildSubject(repository: oneInvitation(), auth: auth),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(orgLoads, 1);
    });

    testWidgets(
      'a lapsed invitation accept becomes an ask-an-owner state, not a dead '
      'invite action or raw server error',
      (tester) async {
        final repository =
            _FakeIncomingRepo(
                responseError: const ApiException(
                  statusCode: 403,
                  body:
                      '{"error":"Your organization\'s trial has ended. Subscribe '
                      'to Team to restore team features.",'
                      '"code":"org_teams_lapsed","lapseReason":"trial_ended",'
                      '"requiredPlanName":"Team","trialEndedAt":null}',
                ),
              )
              ..incoming = const [
                IncomingInvitation(
                  id: 'x',
                  organizationName: 'Globex Labs',
                  role: OrganizationRole.member,
                ),
              ];

        await tester.pumpWidget(buildSubject(repository: repository));
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
        await tester.pumpAndSettle();

        expect(find.text('Globex Labs is on hold'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(StateMessageView),
            matching: find.textContaining(
              'Ask an organization owner to subscribe to restore your '
              'team.',
            ),
          ),
          findsOneWidget,
        );
        expect(find.widgetWithText(FilledButton, 'Accept'), findsNothing);
        expect(find.widgetWithText(FilledButton, 'Subscribe'), findsNothing);
        expect(find.textContaining('ApiException'), findsNothing);
        expect(tester.takeException(), isNull);

        // Once an owner fixes billing, a refresh must clear the stale
        // action failure and restore the invitation so it can be accepted.
        repository.responseError = null;
        await tester.fling(
          find.byType(RefreshIndicator),
          const Offset(0, 300),
          1000,
        );
        await tester.pumpAndSettle();

        expect(find.text('Globex Labs is on hold'), findsNothing);
        expect(find.widgetWithText(FilledButton, 'Accept'), findsOneWidget);
      },
    );

    testWidgets(
      'a failed invitations check says so instead of silently claiming there '
      'are none — the org endpoint succeeded, this one did not',
      (tester) async {
        final repository = _FakeIncomingRepo(error: StateError('offline'));

        await tester.pumpWidget(buildSubject(repository: repository));
        await tester.pumpAndSettle();

        expect(
          find.text("We couldn't check for pending invitations."),
          findsOneWidget,
        );
        // Membership itself is known — that came from a different endpoint —
        // so the primary action must stay available.
        expect(
          find.widgetWithText(FilledButton, 'Create an organization'),
          findsOneWidget,
        );
      },
    );

    testWidgets('retrying a failed invitations check re-runs it', (
      tester,
    ) async {
      final repository = _FakeIncomingRepo(error: StateError('offline'));
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();
      expect(repository.fetches, 1);

      repository
        ..error = null
        ..incoming = const [
          IncomingInvitation(
            id: 'x',
            organizationName: 'Globex Labs',
            role: OrganizationRole.member,
          ),
        ];
      await tester.tap(find.widgetWithText(TextButton, 'Retry'));
      await tester.pumpAndSettle();

      expect(repository.fetches, 2);
      expect(find.text('Globex Labs'), findsOneWidget);
    });

    testWidgets('pull to refresh re-checks for invitations', (tester) async {
      final repository = _FakeIncomingRepo();
      await tester.pumpWidget(buildSubject(repository: repository));
      await tester.pumpAndSettle();
      expect(repository.fetches, 1);

      await tester.fling(
        find.byType(RefreshIndicator),
        const Offset(0, 300),
        1000,
      );
      await tester.pumpAndSettle();

      expect(repository.fetches, 2);
    });

    testWidgets(
      'returning to the foreground picks up an invitation that arrived while '
      'the app was open',
      (tester) async {
        final repository = _FakeIncomingRepo();
        await tester.pumpWidget(buildSubject(repository: repository));
        await tester.pumpAndSettle();
        expect(find.text('Globex Labs'), findsNothing);

        repository.incoming = const [
          IncomingInvitation(
            id: 'x',
            organizationName: 'Globex Labs',
            role: OrganizationRole.member,
          ),
        ];
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pumpAndSettle();

        expect(find.text('Globex Labs'), findsOneWidget);
      },
    );

    testWidgets(
      'a refresh keeps the rendered body instead of blanking it — a full-screen '
      'spinner would take the CTA, the Retry and the pull gesture with it',
      (tester) async {
        final repository = _FakeIncomingRepo();
        await tester.pumpWidget(buildSubject(repository: repository));
        await tester.pumpAndSettle();
        expect(
          find.widgetWithText(FilledButton, 'Create an organization'),
          findsOneWidget,
        );

        // Hold the next fetch open and come back to the foreground.
        repository.hold = true;
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();

        expect(
          find.widgetWithText(FilledButton, 'Create an organization'),
          findsOneWidget,
        );
        expect(find.byType(Scrollable), findsWidgets);

        repository.release();
        await tester.pumpAndSettle();
      },
    );

    testWidgets('fits a phone-width viewport without overflow', (tester) async {
      tester.view.physicalSize = _phone;
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(buildSubject(repository: noInvitations()));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  });
}

/// Controllable invitations repository: the mock has no failure mode and no
/// way to change its payload between fetches, both of which these tests need.
final class _FakeIncomingRepo implements IncomingInvitationsRepository {
  _FakeIncomingRepo({this.error, this.responseError});

  Object? error;
  Object? responseError;
  List<IncomingInvitation> incoming = const [];

  /// When true, the next fetch stays in flight until [release].
  bool hold = false;
  Completer<List<IncomingInvitation>>? _held;

  /// How many times the screen has asked for invitations.
  int fetches = 0;

  void release() {
    _held?.complete(incoming);
    _held = null;
    hold = false;
  }

  @override
  Future<List<IncomingInvitation>> fetchIncomingInvitations() {
    fetches++;
    final failure = error;
    if (failure != null) return Future<List<IncomingInvitation>>.error(failure);
    if (hold) {
      final completer = Completer<List<IncomingInvitation>>();
      _held = completer;
      return completer.future;
    }
    return Future<List<IncomingInvitation>>.value(incoming);
  }

  @override
  Future<void> respondToInvitation({
    required String inviteId,
    required bool accept,
  }) async {
    final failure = responseError;
    if (failure != null) throw failure;
    incoming = incoming.where((invite) => invite.id != inviteId).toList();
  }
}
