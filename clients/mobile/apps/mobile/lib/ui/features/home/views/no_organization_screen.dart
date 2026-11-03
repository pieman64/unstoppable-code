import 'dart:async';

import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/members/view_models/incoming_invitations_view_model.dart';
import 'package:mobile/ui/features/members/views/widgets/incoming_invitation_card.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/organizations/views/create_organization_flow.dart';

/// The Members tab for a signed-in user who belongs to no organization.
///
/// Individual and Pro accounts are legitimate users, so this is a tab in a
/// working app rather than a wall in front of it (CAN-2576) — Remote Control
/// and Account sit alongside it and need no organization at all. It offers the
/// two ways into an organization: accept a pending invitation, or create one.
/// Either outcome re-resolves the active org, which swaps the whole shell over
/// to the full five-tab app.
///
/// Sign-out deliberately lives on the Account tab instead of here.
class NoOrganizationScreen extends StatefulWidget {
  const NoOrganizationScreen({super.key});

  @override
  State<NoOrganizationScreen> createState() => _NoOrganizationScreenState();
}

class _NoOrganizationScreenState extends State<NoOrganizationScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    // Nothing pushes invitation updates, and this list loads once — so an
    // invitation sent while the app was open would never appear. Returning to
    // the foreground is the moment a user who just accepted an emailed invite
    // expects to see it.
    unawaited(context.read<IncomingInvitationsViewModel>().load());
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<IncomingInvitationsViewModel>();
    final actionLapse = viewModel.actionPlanLapse;
    final loadLapse = viewModel.planLapse;

    final Widget body;
    if (actionLapse != null) {
      final invitation = viewModel.actionErrorInvitation;
      body = _InvitationLapseState(
        lapse: actionLapse,
        organizationName: invitation?.organizationName,
      );
    } else if (loadLapse != null) {
      body = _InvitationLapseState(lapse: loadLapse);
    } else if (viewModel.hasInvitations) {
      body = _InvitationsView(viewModel: viewModel);
    } else if (viewModel.isLoading && !viewModel.hasLoaded) {
      // Only the FIRST load gets a full-screen spinner. A refresh must keep the
      // rendered body: replacing it would take the create CTA, the Retry and —
      // because the spinner is not scrollable — the pull gesture with it,
      // leaving a stalled fetch with no way out.
      body = const Center(child: CircularProgressIndicator());
    } else {
      body = _NoOrganizationExplainer(
        // A failed fetch is not the same as "you have none". Membership itself
        // is known here — that came from the organizations endpoint, which
        // succeeded, or this shell would be the unavailable one — so the
        // create CTA stays and only the invitations claim is qualified.
        invitationsUnavailable: viewModel.error != null,
        onRetryInvitations: viewModel.load,
      );
    }

    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const Text('Members'),
      ),
      body: Builder(
        builder: (context) => RefreshIndicator(
          edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
          onRefresh: viewModel.load,
          child: body,
        ),
      ),
    );
  }
}

class _InvitationLapseState extends StatelessWidget {
  const _InvitationLapseState({required this.lapse, this.organizationName});

  final OrgTeamsLapsedError lapse;
  final String? organizationName;

  @override
  Widget build(BuildContext context) {
    // A pending invitee is not a member yet and therefore cannot administer
    // the target org's billing, even if the invitation would eventually grant
    // ADMIN. Render the member/unknown-role remedy and no billing button.
    final presentation = buildOrgLapsePresentation(
      lapse: lapse,
      orgName: organizationName,
      viewerRole: null,
    );
    return StateMessageView(
      glyph: CanopyGlyph.buildings,
      title: presentation.title,
      message: presentation.message,
    );
  }
}

/// Re-resolves the active organization so the shell can advance out of the
/// no-organization state once the user has one.
Future<void> _refreshActiveOrg(BuildContext context) =>
    context.read<AuthViewModel>().refreshActiveOrg();

/// Creates an organization. [promptCreateOrganization] already reloads and
/// switches on success, so there is deliberately no refresh here: adding one
/// would fire a second org load on success and — worse — a pointless one on
/// cancel, where a failed load would silently flip this tab into the
/// "couldn't load your organizations" shell.
Future<void> _createOrganization(BuildContext context) =>
    promptCreateOrganization(context);

class _InvitationsView extends StatelessWidget {
  const _InvitationsView({required this.viewModel});

  final IncomingInvitationsViewModel viewModel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding:
          CanopyScaffold.contentPaddingOf(context) +
          const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      children: [
        Text(
          'Join an organization',
          style: theme.textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          'You have a pending invitation. Accept it to join and start using '
          'your organization.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 16),
        for (final invite in viewModel.invitations)
          IncomingInvitationCard(
            invite: invite,
            busy: viewModel.isBusy,
            onAccept: () async {
              await viewModel.accept(invite.id);
              if (!context.mounted) return;
              await _refreshActiveOrg(context);
            },
            onDecline: () => viewModel.decline(invite.id),
          ),
        const SizedBox(height: 24),
        TextButton(
          onPressed: () => unawaited(_createOrganization(context)),
          child: const Text('Create an organization instead'),
        ),
      ],
    );
  }
}

class _NoOrganizationExplainer extends StatelessWidget {
  const _NoOrganizationExplainer({
    required this.invitationsUnavailable,
    required this.onRetryInvitations,
  });

  /// True when the invitations check failed, so this screen cannot honestly
  /// claim the user has none.
  final bool invitationsUnavailable;

  final Future<void> Function() onRetryInvitations;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Scrollable and full-height even though the content is short, so the
    // RefreshIndicator above has something to pull.
    return LayoutBuilder(
      builder: (context, viewport) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: CanopyScaffold.contentPaddingOf(context),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight:
                (viewport.maxHeight -
                        CanopyScaffold.contentPaddingOf(context).vertical)
                    .clamp(0, double.infinity),
          ),
          child: IntrinsicHeight(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.business_outlined,
                    size: 48,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'No organization',
                    style: theme.textTheme.titleLarge,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Organizations let you share activity, usage and members '
                    'with a team. Create one, or ask an owner to invite you — '
                    'the rest of the app works without one.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: () => unawaited(_createOrganization(context)),
                    child: const Text('Create an organization'),
                  ),
                  if (invitationsUnavailable) ...[
                    const SizedBox(height: 24),
                    Text(
                      "We couldn't check for pending invitations.",
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    TextButton(
                      onPressed: () => unawaited(onRetryInvitations()),
                      child: const Text('Retry'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
