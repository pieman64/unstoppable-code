import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';

OrgTeamsLapsedError lapse({
  String? reason,
  String? plan = 'Team',
  String error = 'Your organization is on hold.',
}) => OrgTeamsLapsedError(
  code: 'org_teams_lapsed',
  error: error,
  lapseReason: reason,
  requiredPlanName: plan,
  trialEndedAt: null,
);

void main() {
  group('orgLapseReason', () {
    test('narrows each known wire value', () {
      expect(
        orgLapseReason(lapse(reason: 'trial_ended')),
        OrgTeamsLapseReason.trialEnded,
      );
      expect(
        orgLapseReason(lapse(reason: 'payment_failed')),
        OrgTeamsLapseReason.paymentFailed,
      );
      expect(
        orgLapseReason(lapse(reason: 'subscription_ended')),
        OrgTeamsLapseReason.subscriptionEnded,
      );
    });

    test('treats null and an unknown reason as unset rather than throwing', () {
      expect(orgLapseReason(lapse(reason: null)), isNull);
      expect(orgLapseReason(lapse(reason: 'meteor_strike')), isNull);
    });
  });

  group('canEditOrgBilling', () {
    test('is true only for owners, matching billing API authorization', () {
      expect(canEditOrgBilling(OrganizationRole.owner), isTrue);
      expect(canEditOrgBilling(OrganizationRole.admin), isFalse);
      expect(canEditOrgBilling(OrganizationRole.member), isFalse);
      expect(canEditOrgBilling(null), isFalse);
    });
  });

  group('buildOrgLapsePresentation', () {
    OrgLapsePresentation build({
      String? reason,
      String? plan = 'Team',
      OrganizationRole? role = OrganizationRole.owner,
      String? orgName = 'Acme',
    }) => buildOrgLapsePresentation(
      lapse: lapse(reason: reason, plan: plan),
      orgName: orgName,
      viewerRole: role,
    );

    test('names the organization in the title', () {
      expect(build().title, 'Acme is on hold');
    });

    test('falls back to generic naming when the org name is unknown', () {
      expect(build(orgName: null).title, 'Your organization is on hold');
      expect(build(orgName: '').title, 'Your organization is on hold');
    });

    test('states the cause per reason', () {
      expect(
        build(reason: 'trial_ended').message,
        startsWith('Your trial has ended.'),
      );
      expect(
        build(reason: 'payment_failed').message,
        startsWith('Your last payment failed.'),
      );
      expect(
        build(reason: 'subscription_ended').message,
        startsWith('Your subscription has ended.'),
      );
      expect(
        build(reason: null).message,
        startsWith('Your plan no longer includes team features.'),
      );
    });

    test('offers an actionable remedy to an owner', () {
      final result = build(reason: 'trial_ended');
      expect(
        result.message,
        endsWith('Subscribe to Team to restore your team.'),
      );
      expect(result.actionLabel, 'Subscribe');
    });

    test('directs an admin to an owner and offers no billing action', () {
      final result = build(reason: 'trial_ended', role: OrganizationRole.admin);
      expect(
        result.message,
        endsWith(
          'Ask an organization owner to subscribe to restore your team.',
        ),
      );
      expect(result.actionLabel, isNull);
    });

    test('drops the plan name when no plan grants team features', () {
      final result = build(reason: 'subscription_ended', plan: null);
      expect(result.message, endsWith('Subscribe to restore your team.'));
      expect(result.message, isNot(contains('null')));
    });

    test('drops the plan name when it is blank', () {
      expect(
        build(reason: 'subscription_ended', plan: '').message,
        endsWith('Subscribe to restore your team.'),
      );
    });

    test('tells a past-due owner to fix the card, not to subscribe', () {
      final result = build(reason: 'payment_failed');
      expect(
        result.message,
        endsWith('Update your payment method to restore your team.'),
      );
      expect(result.message, isNot(contains('Subscribe')));
      expect(result.actionLabel, 'Update payment method');
    });

    test('gives a member ask-an-owner copy and no action', () {
      for (final reason in ['trial_ended', 'subscription_ended', null]) {
        final result = build(reason: reason, role: OrganizationRole.member);
        expect(
          result.message,
          endsWith(
            'Ask an organization owner to subscribe to restore your '
            'team.',
          ),
          reason: 'reason=$reason',
        );
        expect(result.actionLabel, isNull, reason: 'reason=$reason');
      }
    });

    test('gives a member the payment-failed variant of ask-an-owner', () {
      final result = build(
        reason: 'payment_failed',
        role: OrganizationRole.member,
      );
      expect(
        result.message,
        endsWith(
          'Ask an organization owner to update the payment method to '
          'restore your team.',
        ),
      );
      expect(result.actionLabel, isNull);
    });

    test('treats an unknown viewer role as unable to act', () {
      expect(build(reason: 'trial_ended', role: null).actionLabel, isNull);
    });
  });

  group('orgLapseActionMessage', () {
    ApiException failure(String reason) => ApiException(
      statusCode: 403,
      body:
          '{"error":"Organization held","code":"org_teams_lapsed",'
          '"lapseReason":"$reason","requiredPlanName":"Team",'
          '"trialEndedAt":null}',
    );

    test('uses ask-an-owner copy for a member mutation', () {
      expect(
        orgLapseActionMessage(
          failure('trial_ended'),
          orgName: 'Acme',
          viewerRole: OrganizationRole.member,
        ),
        'Your trial has ended. Ask an organization owner to subscribe '
        'to restore your team.',
      );
    });

    test('uses the payment-method remedy for an owner mutation', () {
      expect(
        orgLapseActionMessage(
          failure('payment_failed'),
          orgName: 'Acme',
          viewerRole: OrganizationRole.owner,
        ),
        'Your last payment failed. Update your payment method to restore your '
        'team.',
      );
    });

    test('returns null for a non-lapse error so the caller can fall back', () {
      expect(
        orgLapseActionMessage(
          const ApiException(
            statusCode: 403,
            body: '{"error":"Permission denied"}',
          ),
          orgName: 'Acme',
          viewerRole: OrganizationRole.admin,
        ),
        isNull,
      );
    });
  });
}
