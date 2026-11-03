import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/members/views/widgets/incoming_invitation_card.dart';

void main() {
  group('IncomingInvitationCard', () {
    Widget host({
      required IncomingInvitation invite,
      bool busy = false,
      VoidCallback? onAccept,
      VoidCallback? onDecline,
    }) => MaterialApp(
      theme: AppTheme.light,
      home: Scaffold(
        body: IncomingInvitationCard(
          invite: invite,
          busy: busy,
          onAccept: () async => onAccept?.call(),
          onDecline: () async => onDecline?.call(),
        ),
      ),
    );

    const plain = IncomingInvitation(
      id: 'i1',
      organizationName: 'Globex Labs',
      role: OrganizationRole.member,
    );

    test('enforcedSyncLabels omits unset and prohibited scopes', () {
      // false = prohibited, null = unset; neither is a requirement.
      expect(
        enforcedSyncLabels(
          const EnforcedSyncScopes(
            transcripts: true,
            plans: null,
            metadata: false,
          ),
        ),
        ['Transcripts'],
      );
    });

    test('enforcedSyncLabels lists every scope in canonical order', () {
      expect(
        enforcedSyncLabels(
          const EnforcedSyncScopes(
            transcripts: true,
            plans: true,
            metadata: true,
            summaries: true,
          ),
        ),
        ['Usage details', 'Plans', 'Session summaries', 'Transcripts'],
      );
    });

    test('enforcedSyncLabels drops a scope that is also prohibited', () {
      // Prohibition beats requirement, so the two lists never contradict.
      expect(
        enforcedSyncLabels(
          const EnforcedSyncScopes(transcripts: true, summaries: true),
          prohibited: const EnforcedSyncScopes(summaries: true),
        ),
        ['Transcripts'],
      );
    });

    test('prohibitedSyncLabels lists only blocked scopes', () {
      expect(
        prohibitedSyncLabels(
          const EnforcedSyncScopes(
            transcripts: true,
            summaries: true,
            plans: null,
          ),
        ),
        ['Session summaries', 'Transcripts'],
      );
      expect(prohibitedSyncLabels(null), isEmpty);
    });

    testWidgets('renders the org name and role', (tester) async {
      await tester.pumpWidget(host(invite: plain));

      expect(find.text('Globex Labs'), findsOneWidget);
      expect(find.text('Member'), findsOneWidget);
    });

    testWidgets('accepting a plain invite calls onAccept', (tester) async {
      var accepted = false;
      await tester.pumpWidget(
        host(invite: plain, onAccept: () => accepted = true),
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(accepted, isTrue);
    });

    testWidgets('accepting an enforced invite requires consent first', (
      tester,
    ) async {
      var accepted = false;
      const enforced = IncomingInvitation(
        id: 'i2',
        organizationName: 'Secure Org',
        role: OrganizationRole.member,
        enforcedSettings: EnforcedSyncScopes(plans: true, transcripts: true),
      );
      await tester.pumpWidget(
        host(invite: enforced, onAccept: () => accepted = true),
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      // Consent disclosure shown; not accepted until confirmed.
      expect(find.text('Organization data sharing'), findsOneWidget);
      expect(find.text('Telemetry sync'), findsOneWidget);
      expect(find.text('- Transcripts'), findsOneWidget);
      expect(find.text('- Plans'), findsOneWidget);
      // Nothing is prohibited, so the blocked heading stays off the dialog.
      expect(find.text('Blocked from sharing'), findsNothing);
      expect(accepted, isFalse);

      await tester.tap(find.widgetWithText(FilledButton, 'Accept').last);
      await tester.pumpAndSettle();
      expect(accepted, isTrue);
    });

    testWidgets('the disclosure lists prohibitions as well as requirements', (
      tester,
    ) async {
      // Phone-width viewport so a RenderFlex overflow in the dialog surfaces
      // as a real exception rather than being hidden by a large test surface.
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3.0;
      addTearDown(tester.view.reset);

      var accepted = false;
      const enforced = IncomingInvitation(
        id: 'i3',
        organizationName: 'Secure Org',
        role: OrganizationRole.member,
        enforcedSettings: EnforcedSyncScopes(metadata: true),
        prohibitedSettings: EnforcedSyncScopes(
          summaries: true,
          transcripts: true,
        ),
      );
      await tester.pumpWidget(
        host(invite: enforced, onAccept: () => accepted = true),
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(find.text('Telemetry sync'), findsOneWidget);
      expect(find.text('- Usage details'), findsOneWidget);
      expect(find.text('Blocked from sharing'), findsOneWidget);
      expect(find.text('- Session summaries'), findsOneWidget);
      expect(find.text('- Transcripts'), findsOneWidget);
      expect(accepted, isFalse);
      expect(tester.takeException(), isNull);

      await tester.tap(find.widgetWithText(FilledButton, 'Accept').last);
      await tester.pumpAndSettle();
      expect(accepted, isTrue);
    });

    testWidgets('a prohibition-only invite still shows the disclosure', (
      tester,
    ) async {
      var accepted = false;
      const blocked = IncomingInvitation(
        id: 'i4',
        organizationName: 'Secure Org',
        role: OrganizationRole.member,
        prohibitedSettings: EnforcedSyncScopes(summaries: true),
      );
      await tester.pumpWidget(
        host(invite: blocked, onAccept: () => accepted = true),
      );

      await tester.tap(find.widgetWithText(FilledButton, 'Accept'));
      await tester.pumpAndSettle();

      // Joining turns sharing OFF here, which is exactly the case a
      // requirements-only disclosure used to hide.
      expect(find.text('Blocked from sharing'), findsOneWidget);
      expect(find.text('- Session summaries'), findsOneWidget);
      expect(find.text('Telemetry sync'), findsNothing);
      expect(accepted, isFalse);

      await tester.tap(find.widgetWithText(FilledButton, 'Accept').last);
      await tester.pumpAndSettle();
      expect(accepted, isTrue);
    });

    testWidgets('declining requires confirmation then calls onDecline', (
      tester,
    ) async {
      var declined = false;
      await tester.pumpWidget(
        host(invite: plain, onDecline: () => declined = true),
      );

      await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
      await tester.pumpAndSettle();
      expect(find.text('Decline invitation'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'Decline'));
      await tester.pumpAndSettle();

      expect(declined, isTrue);
    });

    testWidgets('busy disables both actions', (tester) async {
      await tester.pumpWidget(host(invite: plain, busy: true));

      final accept = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Accept'),
      );
      final decline = tester.widget<OutlinedButton>(
        find.widgetWithText(OutlinedButton, 'Decline'),
      );
      expect(accept.onPressed, isNull);
      expect(decline.onPressed, isNull);
    });
  });
}
