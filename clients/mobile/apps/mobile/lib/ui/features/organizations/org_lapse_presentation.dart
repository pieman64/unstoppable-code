import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/services/api_client.dart';

/// Presentation copy for the "organization is on hold" state.
///
/// Mirrors the web treatment in `apps/web/src/components/team/team-lapsed-state.tsx`
/// sentence for sentence, so a user who sees both surfaces reads the same
/// explanation and is pointed at the same remedy.
class OrgLapsePresentation {
  const OrgLapsePresentation({
    required this.title,
    required this.message,
    this.actionLabel,
  });

  /// '{orgName} is on hold'.
  final String title;

  /// Cause sentence + remedy sentence, already joined.
  final String message;

  /// Label for the billing CTA, or null when the viewer cannot act (admins and
  /// members are told to ask an owner and get no button, matching the billing
  /// API's owner-only authorization boundary).
  final String? actionLabel;
}

/// Reads the wire `lapseReason` off a generated [OrgTeamsLapsedError].
///
/// The protocol generator emits the nullable enum as `dynamic`, so the
/// narrowing lives here. An unknown value is treated as unset rather than
/// throwing: a newer server reason must still render a sane on-hold screen.
OrgTeamsLapseReason? orgLapseReason(OrgTeamsLapsedError lapse) {
  final raw = lapse.lapseReason;
  if (raw is! String) return null;
  try {
    return OrgTeamsLapseReason.fromWire(raw);
  } on FormatException {
    return null;
  }
}

/// True when [role] can act on billing, i.e. subscribe or fix a card.
///
/// Billing mutations are owner-only. Admins can view the billing summary but
/// cannot subscribe or update the payment method, so offering them this action
/// would send them into another dead end.
bool canEditOrgBilling(OrganizationRole? role) =>
    role == OrganizationRole.owner;

/// Builds the on-hold copy for [lapse].
///
/// [orgName] names the org explicitly because a viewer may belong to several
/// and only one of them is on hold. [viewerRole] decides between the
/// actionable remedy and the ask-an-owner variant.
///
/// `trialEndedAt` is deliberately not rendered: mobile has no
/// `formatPlanDateUtc` equivalent, and a raw ISO timestamp reads worse than
/// date-free copy.
OrgLapsePresentation buildOrgLapsePresentation({
  required OrgTeamsLapsedError lapse,
  required String? orgName,
  required OrganizationRole? viewerRole,
}) {
  final reason = orgLapseReason(lapse);
  final canEdit = canEditOrgBilling(viewerRole);

  final cause = switch (reason) {
    OrgTeamsLapseReason.paymentFailed => 'Your last payment failed.',
    OrgTeamsLapseReason.subscriptionEnded => 'Your subscription has ended.',
    OrgTeamsLapseReason.trialEnded => 'Your trial has ended.',
    null => 'Your plan no longer includes team features.',
  };

  // `requiredPlanName` is null only if no seeded plan grants `teams`, in which
  // case naming a plan would print "null" — fall back to plan-free copy.
  //
  // A past-due org is told to fix the card, not to subscribe: it already has a
  // subscription, so "Subscribe to Business" is unactionable for someone whose
  // plan is already Business.
  final plan = lapse.requiredPlanName;
  final remedy = canEdit
      ? (reason == OrgTeamsLapseReason.paymentFailed
            ? 'Update your payment method to restore your team.'
            : plan != null && plan.isNotEmpty
            ? 'Subscribe to $plan to restore your team.'
            : 'Subscribe to restore your team.')
      : (reason == OrgTeamsLapseReason.paymentFailed
            ? 'Ask an organization owner to update the payment method '
                  'to restore your team.'
            : 'Ask an organization owner to subscribe to restore your '
                  'team.');

  return OrgLapsePresentation(
    title:
        '${orgName == null || orgName.isEmpty ? 'Your organization' : orgName} is on hold',
    message: '$cause $remedy',
    actionLabel: canEdit
        ? (reason == OrgTeamsLapseReason.paymentFailed
              ? 'Update payment method'
              : 'Subscribe')
        : null,
  );
}

/// The role-aware lapse sentence for a failed org mutation, or null when
/// [error] is not the structured org-billing 403.
///
/// Mutation surfaces already own a snackbar or inline-error container, so they
/// need only the cause + remedy sentence from the same presentation used by
/// the full on-hold state. In particular, a member must be told to ask an
/// owner rather than receiving the server's role-neutral "Subscribe"
/// sentence.
String? orgLapseActionMessage(
  Object? error, {
  required String? orgName,
  required OrganizationRole? viewerRole,
}) {
  final lapse = errorOrgTeamsLapse(error);
  if (lapse == null) return null;
  return buildOrgLapsePresentation(
    lapse: lapse,
    orgName: orgName,
    viewerRole: viewerRole,
  ).message;
}
