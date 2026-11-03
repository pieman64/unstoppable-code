import 'package:mobile/data/protocol/generated/organization.dart';

/// A pending team invitation shown to the invitee, mirroring the web
/// `IncomingTeamInvitation` (`apps/web/src/lib/teams/types.ts`).  Hand-written
/// because the incoming-invite type is web-local, not in `@canopy/protocol`.
///
/// The inviter is read from the `invitedByName` wire key.  `organizationTeamName`
/// and `inviterName` are nullable for defensive parsing.
class IncomingInvitation {
  const IncomingInvitation({
    required this.id,
    required this.organizationName,
    required this.role,
    this.enforcedSettings,
    this.prohibitedSettings,
    this.organizationTeamName,
    this.inviterName,
    this.expiresAt,
  });

  final String id;
  final String organizationName;
  final String? organizationTeamName;
  final OrganizationRole role;

  /// Scopes the org REQUIRES the member to share, unioned across every
  /// enforcing org on the invite.
  ///
  /// A scope is `true` when required and `null` otherwise. It is deliberately
  /// never `false` here: under the three-state model `false` means PROHIBITED,
  /// which is a different disposition and lives in [prohibitedSettings].
  final EnforcedSyncScopes? enforcedSettings;

  /// Scopes the org PROHIBITS the member from sharing anywhere — not for this
  /// org, not for any other org they belong to, and not for their own private
  /// account.
  ///
  /// `true` means prohibited, `null` means no prohibition. Disclosed alongside
  /// [enforcedSettings] because joining can just as easily turn sharing OFF as
  /// on, and a consent screen that only lists what gets switched on is
  /// materially incomplete.
  final EnforcedSyncScopes? prohibitedSettings;

  final String? inviterName;

  /// ISO timestamp of when the invite expires.
  final String? expiresAt;

  factory IncomingInvitation.fromJson(Map<String, dynamic> json) {
    final enforced = _parseEnforcedSettings(json['enforcedSettings']);
    return IncomingInvitation(
      id: json['id'] as String,
      organizationName: json['organizationName'] as String,
      role: OrganizationRole.fromWire(json['role'] as String),
      enforcedSettings: enforced.requiredScopes,
      prohibitedSettings: enforced.prohibitedScopes,
      organizationTeamName: json['organizationTeamName'] as String?,
      inviterName: json['invitedByName'] as String?,
      expiresAt: json['expiresAt'] as String?,
    );
  }
}

/// The requirement/prohibition split parsed off an invite's
/// `enforcedSettings`.
typedef _ParsedEnforcedSettings = ({
  EnforcedSyncScopes? requiredScopes,
  EnforcedSyncScopes? prohibitedScopes,
});

/// Reads the invite's `enforcedSettings` array into the two dispositions the
/// consent disclosure renders, mirroring `describeEnforcedPolicies` in
/// `packages/ui-shared/src/lib/org-enforced-consent.ts`.
///
/// Every flag is read with `== true`: an absent or null scope means "unset"
/// (the member's own choice), which is neither required nor prohibited, so a
/// negated test would invent a policy the org never set. Scopes are unioned
/// across every org and policy on the invite, and a prohibition beats a
/// requirement — the same precedence the server applies when it resolves the
/// member's effective policy — so the two maps stay disjoint and the
/// disclosure never lists one scope under both headings.
_ParsedEnforcedSettings _parseEnforcedSettings(Object? raw) {
  if (raw is! List<dynamic>) {
    return (requiredScopes: null, prohibitedScopes: null);
  }

  var requiredMetadata = false;
  var requiredPlans = false;
  var requiredSummaries = false;
  var requiredTranscripts = false;
  var blockedMetadata = false;
  var blockedPlans = false;
  var blockedSummaries = false;
  var blockedTranscripts = false;

  for (final orgSettings in raw) {
    if (orgSettings is! Map<String, dynamic>) continue;
    final policies = orgSettings['policies'];
    if (policies is! List<dynamic>) continue;
    for (final policy in policies) {
      if (policy is! Map<String, dynamic>) continue;
      if (policy['kind'] != 'telemetry-sync') continue;

      final scopes = policy['scopes'];
      if (scopes is Map<String, dynamic>) {
        requiredMetadata = requiredMetadata || scopes['metadata'] == true;
        requiredPlans = requiredPlans || scopes['plans'] == true;
        requiredSummaries = requiredSummaries || scopes['summaries'] == true;
        requiredTranscripts =
            requiredTranscripts || scopes['transcripts'] == true;
      }

      // Absent on policies minted before prohibitions existed, and on orgs that
      // do not enforce their full configuration. Absent means no prohibition.
      final prohibited = policy['prohibitedScopes'];
      if (prohibited is Map<String, dynamic>) {
        blockedMetadata = blockedMetadata || prohibited['metadata'] == true;
        blockedPlans = blockedPlans || prohibited['plans'] == true;
        blockedSummaries = blockedSummaries || prohibited['summaries'] == true;
        blockedTranscripts =
            blockedTranscripts || prohibited['transcripts'] == true;
      }
    }
  }

  // Prohibition wins during resolution, so mirror that here rather than
  // claiming the same scope is both required and blocked.
  if (blockedMetadata) requiredMetadata = false;
  if (blockedPlans) requiredPlans = false;
  if (blockedSummaries) requiredSummaries = false;
  if (blockedTranscripts) requiredTranscripts = false;

  final anyRequired =
      requiredMetadata ||
      requiredPlans ||
      requiredSummaries ||
      requiredTranscripts;
  final anyBlocked =
      blockedMetadata || blockedPlans || blockedSummaries || blockedTranscripts;

  return (
    requiredScopes: anyRequired
        ? EnforcedSyncScopes(
            metadata: _flag(requiredMetadata),
            plans: _flag(requiredPlans),
            summaries: _flag(requiredSummaries),
            transcripts: _flag(requiredTranscripts),
          )
        : null,
    prohibitedScopes: anyBlocked
        ? EnforcedSyncScopes(
            metadata: _flag(blockedMetadata),
            plans: _flag(blockedPlans),
            summaries: _flag(blockedSummaries),
            transcripts: _flag(blockedTranscripts),
          )
        : null,
  );
}

/// `true` when the scope carries this disposition, `null` when it does not.
///
/// Never `false`: these maps say which scopes hold one disposition, and a
/// literal `false` in a scope map already means PROHIBITED elsewhere in the
/// protocol.
bool? _flag(bool on) => on ? true : null;
