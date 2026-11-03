import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';

/// The full-screen "{Org} is on hold" state a gated org surface shows when the
/// API refuses it with the org-billing 403.
///
/// Mirrors the web `TeamLapsedState`: a cause sentence, a remedy sentence, and
/// a billing CTA for owners only — admins and members are told to ask an owner
/// and get no button, because billing mutations are owner-only.
///
/// Org name and viewer role come from [AuthViewModel]'s active organization,
/// which every org-scoped screen already sits under.
class OrgLapseStateView extends StatelessWidget {
  const OrgLapseStateView({
    required this.lapse,
    this.glyph,
    this.scrollable = true,
    super.key,
  });

  /// The parsed 403 payload from [orgTeamsLapse].
  final OrgTeamsLapsedError lapse;

  /// Screen-specific glyph. Defaults to a lock, which reads as "blocked"
  /// rather than "broken" — this is not a failure the user can retry away.
  final CanopyGlyph? glyph;

  /// Forwarded to [StateMessageView.scrollable]. Set false when rendering
  /// inside an existing scroll view.
  final bool scrollable;

  @override
  Widget build(BuildContext context) {
    // Read, not watch: this view is already rebuilt by the screen's own
    // ListenableBuilder when the failing load settles.
    final auth = context.read<AuthViewModel>();
    final org = auth.activeOrganization;
    final presentation = buildOrgLapsePresentation(
      lapse: lapse,
      orgName: org?.name,
      viewerRole: org?.role,
    );
    final actionLabel = presentation.actionLabel;
    final orgId = org?.id ?? auth.activeOrgId;

    return StateMessageView(
      glyph: glyph ?? CanopyGlyph.lock,
      scrollable: scrollable,
      title: presentation.title,
      message: presentation.message,
      actionLabel: actionLabel,
      onAction: actionLabel != null && orgId != null
          ? () => openExternalUrl(orgBillingUrl(orgId)).ignore()
          : null,
    );
  }
}
