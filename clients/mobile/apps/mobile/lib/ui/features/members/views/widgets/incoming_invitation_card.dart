import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/features/members/views/widgets/role_badge.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';

/// A pending incoming-invitation card with Accept / Decline actions, shared by
/// the Members screen and the no-organization screen so the accept flow — and
/// in particular the enforced-settings consent disclosure — lives in one place
/// and cannot diverge between surfaces.
///
/// Accepting an invite that carries enforced settings shows the consent
/// disclosure first; [onAccept] only runs once the user consents. [onDecline]
/// runs after a confirmation. Both are guarded so failures surface a SnackBar.
class IncomingInvitationCard extends StatelessWidget {
  const IncomingInvitationCard({
    super.key,
    required this.invite,
    required this.busy,
    required this.onAccept,
    required this.onDecline,
  });

  final IncomingInvitation invite;

  /// Whether an action is in flight; disables both buttons while true.
  final bool busy;

  /// Performs the accept (after any required consent). Should surface its own
  /// result; thrown errors are caught and shown as a SnackBar.
  final Future<void> Function() onAccept;

  /// Performs the decline (after confirmation).
  final Future<void> Function() onDecline;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitleParts = <String>[
      if (invite.inviterName != null) 'Invited by ${invite.inviterName}',
      if (invite.organizationTeamName != null)
        'Team: ${invite.organizationTeamName}',
    ];
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    invite.organizationName,
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                RoleBadge(role: invite.role),
              ],
            ),
            if (subtitleParts.isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                subtitleParts.join(' · '),
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
            const SizedBox(height: 12),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                OutlinedButton(
                  onPressed: busy ? null : () => unawaited(_decline(context)),
                  child: const Text('Decline'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: busy ? null : () => unawaited(_accept(context)),
                  child: const Text('Accept'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _accept(BuildContext context) async {
    final confirmed = await confirmEnforcedSettings(context, invite);
    if (!context.mounted) return;
    if (!confirmed) return;
    await guardAction(
      context,
      onAccept,
      'Could not accept the invitation.',
      failureMessageBuilder: (error) => orgLapseActionMessage(
        error,
        orgName: invite.organizationName,
        // The invitee is not a member yet and cannot manage the target org's
        // billing, regardless of the role the invitation would later grant.
        viewerRole: null,
      ),
    );
  }

  Future<void> _decline(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Decline invitation',
      message: 'Decline the invitation to ${invite.organizationName}?',
      confirmLabel: 'Decline',
    );
    if (!context.mounted) return;
    if (!confirmed) return;
    await guardAction(context, onDecline, 'Could not decline the invitation.');
  }
}

/// Shows the enforced-settings consent disclosure for [invite] before joining
/// an organization. Returns true when the user consents, or immediately when
/// the invitation carries no enforced settings.
///
/// Discloses BOTH dispositions, mirroring `describeEnforcedPolicies` in
/// `packages/ui-shared/src/lib/org-enforced-consent.ts`: what joining requires
/// the member to start sharing, and what it blocks them from sharing anywhere.
/// A prohibition is global — it also silences that scope for the member's own
/// private account and for every other org they belong to — so listing only
/// the requirements would be an incomplete consent screen.
Future<bool> confirmEnforcedSettings(
  BuildContext context,
  IncomingInvitation invite,
) async {
  final requiredLabels = enforcedSyncLabels(
    invite.enforcedSettings,
    prohibited: invite.prohibitedSettings,
  );
  final blockedLabels = prohibitedSyncLabels(invite.prohibitedSettings);
  if (requiredLabels.isEmpty && blockedLabels.isEmpty) return true;

  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      final headingStyle = Theme.of(dialogContext).textTheme.bodyMedium
          ?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          );
      return AlertDialog(
        title: const Text('Organization data sharing'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'By joining ${invite.organizationName}, you agree to these '
                'organization settings:',
              ),
              if (requiredLabels.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text('Telemetry sync', style: headingStyle),
                const SizedBox(height: 4),
                const Text(
                  'Always shared with the organization, and locked on.',
                ),
                for (final label in requiredLabels)
                  Padding(
                    padding: const EdgeInsets.only(left: 12, top: 2),
                    child: Text('- $label'),
                  ),
              ],
              if (blockedLabels.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text('Blocked from sharing', style: headingStyle),
                const SizedBox(height: 4),
                const Text(
                  'Never leaves your machine at any sharing setting. Not for '
                  'this organization, not for any other organization you '
                  'belong to, and not for your own private account.',
                ),
                for (final label in blockedLabels)
                  Padding(
                    padding: const EdgeInsets.only(left: 12, top: 2),
                    child: Text('- $label'),
                  ),
              ],
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Accept'),
          ),
        ],
      );
    },
  );
  return confirmed ?? false;
}

/// User-facing scope labels, listed below in the canonical least-invasive →
/// most-invasive order used by every other data-sharing surface.
///
/// The wording tracks `DATA_SHARING_SCOPE_LABELS` in `packages/ui-shared`,
/// except that metadata keeps this app's existing "Usage details" label so the
/// invite disclosure and the org settings screen agree with each other.
const String _metadataLabel = 'Usage details';
const String _plansLabel = 'Plans';
const String _summariesLabel = 'Session summaries';
const String _transcriptsLabel = 'Transcripts';

/// Human-readable labels for the telemetry-sync scopes the org REQUIRES, or
/// empty when none are required.
///
/// Read with `== true` on purpose: the scopes are three-state, so `false`
/// (prohibited) and `null` (unset) are both "not required" and neither belongs
/// under this heading. Any scope named in [prohibited] is dropped, because a
/// prohibition beats a requirement and the two lists must not contradict
/// each other.
List<String> enforcedSyncLabels(
  EnforcedSyncScopes? scopes, {
  EnforcedSyncScopes? prohibited,
}) {
  if (scopes == null) return const [];
  bool isRequired(bool? scope, bool? blocked) =>
      scope == true && blocked != true;
  return [
    if (isRequired(scopes.metadata, prohibited?.metadata)) _metadataLabel,
    if (isRequired(scopes.plans, prohibited?.plans)) _plansLabel,
    if (isRequired(scopes.summaries, prohibited?.summaries)) _summariesLabel,
    if (isRequired(scopes.transcripts, prohibited?.transcripts))
      _transcriptsLabel,
  ];
}

/// Human-readable labels for the telemetry-sync scopes the org PROHIBITS, or
/// empty when none are prohibited.
///
/// [scopes] is the prohibition map, where `true` means "this scope is blocked"
/// and `null` means "no prohibition" — so this too reads with `== true`.
List<String> prohibitedSyncLabels(EnforcedSyncScopes? scopes) {
  if (scopes == null) return const [];
  return [
    if (scopes.metadata == true) _metadataLabel,
    if (scopes.plans == true) _plansLabel,
    if (scopes.summaries == true) _summariesLabel,
    if (scopes.transcripts == true) _transcriptsLabel,
  ];
}
