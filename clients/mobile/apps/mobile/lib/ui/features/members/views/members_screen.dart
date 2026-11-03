import 'dart:async';

import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/main.dart' show buildMemberDetailRepository;
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/workspace_context_route.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/members/views/invite_member_sheet.dart';
import 'package:mobile/ui/features/members/views/member_detail_screen.dart';
import 'package:mobile/ui/features/members/views/widgets/incoming_invitation_card.dart';
import 'package:mobile/ui/features/members/views/widgets/role_badge.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';
import 'package:mobile/ui/features/organizations/views/org_settings_screen.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';
import 'package:mobile/ui/features/organizations/views/create_organization_flow.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_teams_screen.dart';

/// The organization members screen: the member list plus, for ADMIN+ viewers,
/// the pending invitations and the "Add member" invite flow.
class MembersScreen extends StatelessWidget {
  const MembersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<MembersViewModel>();

    return CanopyScaffold(
      appBar: CanopyAppBar(
        actionExtent: 96,
        leading: Align(
          alignment: Alignment.centerLeft,
          child: HomeMenuButton.maybeOf(context, designSystem: true),
        ),
        content: const Text('Members'),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (viewModel.canManageMembers)
              CanopyIconButton(
                glyph: CanopyGlyph.userAdd,
                tooltip: 'Add member',
                onPressed: viewModel.isBusy
                    ? null
                    : () => _openInviteSheet(context, viewModel),
              ),
            MenuAnchor(
              builder: (context, controller, child) => CanopyIconButton(
                glyph: CanopyGlyph.dotGrid1x3Horizontal,
                tooltip: 'More',
                onPressed: viewModel.isBusy
                    ? null
                    : () => controller.isOpen
                          ? controller.close()
                          : controller.open(),
              ),
              menuChildren: [
                MenuItemButton(
                  onPressed: () => unawaited(
                    _onAppBarAction(
                      context,
                      viewModel,
                      _AppBarMenuAction.createOrg,
                    ),
                  ),
                  child: Text('New organization'),
                ),
                // Renaming an org is an ADMIN+ action on the backend
                // (`canEditOrg`), and the web UI hides the control for members,
                // so gate it here too rather than let a member tap into a 403.
                if (viewModel.canManageMembers)
                  MenuItemButton(
                    onPressed: () => unawaited(
                      _onAppBarAction(
                        context,
                        viewModel,
                        _AppBarMenuAction.renameOrg,
                      ),
                    ),
                    child: Text('Rename organization'),
                  ),
                MenuItemButton(
                  onPressed: () => unawaited(
                    _onAppBarAction(
                      context,
                      viewModel,
                      _AppBarMenuAction.leaveOrg,
                    ),
                  ),
                  child: Text('Leave organization'),
                ),
                if (viewModel.organization?.viewerRole ==
                    OrganizationRole.owner)
                  MenuItemButton(
                    onPressed: () => unawaited(
                      _onAppBarAction(
                        context,
                        viewModel,
                        _AppBarMenuAction.deleteOrg,
                      ),
                    ),
                    child: Text('Delete organization'),
                  ),
                if (viewModel.canEditUsageStatsConfig)
                  MenuItemButton(
                    onPressed: () => unawaited(
                      _onAppBarAction(
                        context,
                        viewModel,
                        _AppBarMenuAction.usageStats,
                      ),
                    ),
                    child: Text('Usage-stats visibility'),
                  ),
                if (viewModel.canManageMembers)
                  MenuItemButton(
                    onPressed: () => unawaited(
                      _onAppBarAction(
                        context,
                        viewModel,
                        _AppBarMenuAction.orgSettings,
                      ),
                    ),
                    child: Text('Organization settings'),
                  ),
                // Sub-teams management is an ADMIN+ capability, matching the
                // usage-stats gate above (canEditUsageStatsConfig == canManage-
                // Members), so members do not see an entry point they cannot use.
                if (viewModel.canManageMembers)
                  MenuItemButton(
                    onPressed: () => unawaited(
                      _onAppBarAction(
                        context,
                        viewModel,
                        _AppBarMenuAction.subTeams,
                      ),
                    ),
                    child: Text('Sub-teams'),
                  ),
              ],
            ),
          ],
        ),
      ),
      // No ListenableBuilder here: the AppBar gates on `canManageMembers`, so
      // `context.watch` above is load-bearing and already rebuilds this whole
      // subtree on every notify — a second listener would be redundant.
      body: Builder(
        builder: (context) {
          if (viewModel.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          if (viewModel.error != null) {
            return StateMessageView(
              glyph: CanopyGlyph.userGroup,
              title: 'Could not load members',
              message: viewModel.errorMessage,
              onRetry: viewModel.load,
            );
          }
          final org = viewModel.organization;
          if (org == null) {
            return const SizedBox.shrink();
          }
          return RefreshIndicator(
            edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
            onRefresh: viewModel.load,
            child: _MembersBody(
              viewModel: viewModel,
              org: org,
              invites: viewModel.pendingInvites,
              canManageMembers: viewModel.canManageMembers,
            ),
          );
        },
      ),
    );
  }

  void _openInviteSheet(BuildContext context, MembersViewModel viewModel) {
    unawaited(
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => InviteMemberSheet(
          viewModel: viewModel,
          canGrantAdmin: viewModel.canGrantAdmin,
        ),
      ),
    );
  }

  /// Pushes the Sub-teams screen, handing it the ambient [SubTeamsViewModel]
  /// (provided lazily in `main.dart`) via `.value` so the pushed route keeps
  /// the same instance rather than creating a new one. That instance belongs
  /// to this organization, so the route closes when the context leaves it.
  void _openSubTeams(BuildContext context) {
    final viewModel = context.read<SubTeamsViewModel>();
    unawaited(
      Navigator.of(context).push(
        workspaceContextRoute(
          context,
          (_) => ChangeNotifierProvider<SubTeamsViewModel>.value(
            value: viewModel,
            child: const SubTeamsScreen(),
          ),
        ),
      ),
    );
  }

  Future<void> _openUsageStatsPicker(
    BuildContext context,
    MembersViewModel viewModel,
  ) async {
    final current = viewModel.organization?.usageStatsMinRole;
    if (current == null) return;
    final selected = await showDialog<OrganizationRole>(
      context: context,
      builder: (_) =>
          _RolePickerDialog(title: 'Usage-stats visibility', current: current),
    );
    if (selected == null || selected == current) return;
    if (!context.mounted) return;
    await guardAction(
      context,
      () => viewModel.setUsageStatsMinRole(selected),
      'Could not update usage-stats visibility.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }

  /// Pushes the Organization-settings screen, handing it the ambient
  /// [OrgSettingsViewModel] (provided lazily in `main.dart`) via `.value` so the
  /// pushed route keeps the same instance rather than creating a new one.
  /// That instance belongs to this organization, so the route closes when the
  /// context leaves it.
  void _openOrgSettings(BuildContext context) {
    final viewModel = context.read<OrgSettingsViewModel>();
    Navigator.of(context).push(
      workspaceContextRoute(
        context,
        (_) => ChangeNotifierProvider<OrgSettingsViewModel>.value(
          value: viewModel,
          child: const OrgSettingsScreen(),
        ),
      ),
    );
  }

  Future<void> _onAppBarAction(
    BuildContext context,
    MembersViewModel viewModel,
    _AppBarMenuAction action,
  ) async {
    switch (action) {
      case _AppBarMenuAction.createOrg:
        await promptCreateOrganization(context);
      case _AppBarMenuAction.renameOrg:
        await _renameOrganization(context, viewModel);
      case _AppBarMenuAction.leaveOrg:
        await _leaveOrganization(context, viewModel);
      case _AppBarMenuAction.deleteOrg:
        await _deleteOrganization(context, viewModel);
      case _AppBarMenuAction.usageStats:
        await _openUsageStatsPicker(context, viewModel);
      case _AppBarMenuAction.orgSettings:
        _openOrgSettings(context);
      case _AppBarMenuAction.subTeams:
        _openSubTeams(context);
    }
  }

  Future<void> _renameOrganization(
    BuildContext context,
    MembersViewModel viewModel,
  ) async {
    final org = viewModel.organization;
    if (org == null) return;
    final name = await promptForOrganizationName(
      context,
      title: 'Rename organization',
      confirmLabel: 'Save',
      initialValue: org.name,
    );
    final trimmed = name?.trim();
    if (trimmed == null || trimmed.isEmpty || trimmed == org.name) return;
    if (!context.mounted) return;
    final orgVm = context.read<OrgViewModel>();
    final auth = context.read<AuthViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await orgVm.rename(orgId: org.id, name: trimmed);
    if (!ok) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not rename the organization.')),
      );
      return;
    }
    await auth.reloadOrganizations();
    if (viewModel.isDisposed) return;
    await viewModel.load();
    messenger.showSnackBar(
      const SnackBar(content: Text('Organization renamed')),
    );
  }

  Future<void> _leaveOrganization(
    BuildContext context,
    MembersViewModel viewModel,
  ) async {
    final org = viewModel.organization;
    if (org == null) return;
    final confirmed = await confirmDestructive(
      context,
      title: 'Leave organization',
      message: 'Leave ${org.name}? You will lose access to its data.',
      confirmLabel: 'Leave',
    );
    if (!confirmed) return;
    if (!context.mounted) return;
    final orgVm = context.read<OrgViewModel>();
    final auth = context.read<AuthViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await orgVm.leave(org.id);
    if (!ok) {
      messenger.showSnackBar(
        const SnackBar(content: Text('Could not leave the organization.')),
      );
      return;
    }
    await auth.reloadOrganizations();
    messenger.showSnackBar(SnackBar(content: Text('Left ${org.name}')));
  }

  Future<void> _deleteOrganization(
    BuildContext context,
    MembersViewModel viewModel,
  ) async {
    final org = viewModel.organization;
    if (org == null) return;
    final confirmed = await confirmDestructive(
      context,
      title: 'Delete organization',
      message:
          'Delete ${org.name}? This removes access for you and everyone else '
          'in it. Billing and usage history is kept, and you cannot get the '
          'organization back. Cancel any active subscription first.',
      confirmLabel: 'Delete',
    );
    if (!confirmed) return;
    if (!context.mounted) return;
    final orgVm = context.read<OrgViewModel>();
    final auth = context.read<AuthViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await orgVm.delete(org.id);
    if (!ok) {
      // Prefer the server's own reason. A delete can be refused deliberately
      // (409 while a subscription is live), and the generic fallback hid the
      // one thing the owner needs to act on.
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            orgLapseActionMessage(
                  orgVm.error,
                  orgName: org.name,
                  viewerRole: org.viewerRole,
                ) ??
                orgVm.errorMessage ??
                'Could not delete the organization.',
          ),
        ),
      );
      return;
    }
    await auth.reloadOrganizations();
    messenger.showSnackBar(SnackBar(content: Text('Deleted ${org.name}')));
  }
}

/// Overflow-menu actions in the Members screen app bar.
enum _AppBarMenuAction {
  createOrg,
  renameOrg,
  leaveOrg,
  deleteOrg,
  usageStats,
  orgSettings,
  subTeams,
}

class _MembersBody extends StatelessWidget {
  const _MembersBody({
    required this.viewModel,
    required this.org,
    required this.invites,
    required this.canManageMembers,
  });

  final MembersViewModel viewModel;
  final OrganizationDetail org;
  final List<OutgoingInvite> invites;
  final bool canManageMembers;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activeInvites = invites
        .where(
          (i) => i.status == InviteStatus.active && i.organizationId == org.id,
        )
        .toList();
    final memberCount = org.members.length;

    return ListView(
      padding:
          CanopyScaffold.contentPaddingOf(context) +
          const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      children: [
        if (viewModel.incomingInvitations.isNotEmpty) ...[
          _IncomingInvitationsSection(viewModel: viewModel),
          const SizedBox(height: 16),
          const Divider(),
          const SizedBox(height: 8),
        ],
        Text(
          org.name,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        Text(
          '$memberCount ${memberCount == 1 ? 'member' : 'members'}',
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 8),
        for (final member in org.members)
          _MemberRow(viewModel: viewModel, member: member),
        if (canManageMembers && activeInvites.isNotEmpty) ...[
          const SizedBox(height: 16),
          const Divider(),
          const SizedBox(height: 8),
          Text(
            'Pending invitations',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: AppTypography.emphasisWeight,
              fontVariations: AppTypography.emphasisVariations,
            ),
          ),
          const SizedBox(height: 4),
          for (final invite in activeInvites)
            _InviteRow(viewModel: viewModel, invite: invite),
        ],
      ],
    );
  }
}

class _IncomingInvitationsSection extends StatelessWidget {
  const _IncomingInvitationsSection({required this.viewModel});

  final MembersViewModel viewModel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Invitations to you',
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        const SizedBox(height: 4),
        for (final invite in viewModel.incomingInvitations)
          IncomingInvitationCard(
            invite: invite,
            busy: viewModel.isBusy,
            onAccept: () async {
              await viewModel.acceptInvitation(invite.id);
              if (!context.mounted) return;
              await context.read<AuthViewModel>().refreshActiveOrg();
            },
            onDecline: () => viewModel.declineInvitation(invite.id),
          ),
      ],
    );
  }
}

enum _MemberAction { changeRole, remove }

class _MemberRow extends StatelessWidget {
  const _MemberRow({required this.viewModel, required this.member});

  final MembersViewModel viewModel;
  final OrganizationMember member;

  @override
  Widget build(BuildContext context) {
    final canChangeRoles = viewModel.canChangeRoles;
    final canRemove = viewModel.canRemove(member);
    final hasMenu = canChangeRoles || canRemove;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      onTap: viewModel.isBusy ? null : () => _openDetail(context),
      leading: CircleAvatar(child: Text(_initials(member.name))),
      title: Text(member.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        member.email,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          RoleBadge(role: member.role),
          if (hasMenu)
            PopupMenuButton<_MemberAction>(
              enabled: !viewModel.isBusy,
              icon: const Icon(Icons.more_vert),
              onSelected: (action) => unawaited(_onSelected(context, action)),
              itemBuilder: (context) => [
                if (canChangeRoles)
                  const PopupMenuItem(
                    value: _MemberAction.changeRole,
                    child: Text('Change role…'),
                  ),
                if (canRemove)
                  const PopupMenuItem(
                    value: _MemberAction.remove,
                    child: Text('Remove…'),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  /// Pushes the read-only member-detail drill-down. The org id and the
  /// `canViewUsageStats` gate come from the already-loaded org detail; the
  /// per-member repository is built at this call site and scoped to the pushed
  /// route.
  void _openDetail(BuildContext context) {
    final org = viewModel.organization;
    if (org == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => MemberDetailScreen(
          repository: buildMemberDetailRepository(
            orgId: org.id,
            memberId: member.id,
          ),
          member: member,
          canViewStats: org.canViewUsageStats,
        ),
      ),
    );
  }

  Future<void> _onSelected(BuildContext context, _MemberAction action) async {
    switch (action) {
      case _MemberAction.changeRole:
        final selected = await showDialog<OrganizationRole>(
          context: context,
          builder: (_) =>
              _RolePickerDialog(title: 'Change role', current: member.role),
        );
        if (!context.mounted) return;
        if (selected == null || selected == member.role) return;
        await guardAction(
          context,
          () => viewModel.changeMemberRole(member.id, selected),
          'Could not change the role.',
          failureMessageBuilder: (error) =>
              _lapseActionMessage(error, viewModel),
        );
      case _MemberAction.remove:
        final confirmed = await confirmDestructive(
          context,
          title: 'Remove member',
          message: 'Remove ${member.name} from this organization?',
          confirmLabel: 'Remove',
        );
        if (!context.mounted) return;
        if (!confirmed) return;
        await guardAction(
          context,
          () => viewModel.removeMember(member.id),
          'Could not remove the member.',
          failureMessageBuilder: (error) =>
              _lapseActionMessage(error, viewModel),
        );
    }
  }
}

class _InviteRow extends StatelessWidget {
  const _InviteRow({required this.viewModel, required this.invite});

  final MembersViewModel viewModel;
  final OutgoingInvite invite;

  @override
  Widget build(BuildContext context) {
    final role = invite.role;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const CircleAvatar(child: Icon(Icons.mail_outline, size: 20)),
      title: Text(
        invite.invitedEmail ?? 'Invite link',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: const Text('Pending invitation'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (role != null) RoleBadge(role: role),
          PopupMenuButton<String>(
            enabled: !viewModel.isBusy,
            icon: const Icon(Icons.more_vert),
            onSelected: (_) => unawaited(_revoke(context)),
            itemBuilder: (context) => const [
              PopupMenuItem(value: 'revoke', child: Text('Revoke…')),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _revoke(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Revoke invitation',
      message:
          'Revoke the invitation to ${invite.invitedEmail ?? 'this user'}?',
      confirmLabel: 'Revoke',
    );
    if (!context.mounted) return;
    if (!confirmed) return;
    await guardAction(
      context,
      () => viewModel.revokeInvite(invite.id),
      'Could not revoke the invitation.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }
}

String? _lapseActionMessage(Object error, MembersViewModel viewModel) {
  final org = viewModel.organization;
  return orgLapseActionMessage(
    error,
    orgName: org?.name,
    viewerRole: org?.viewerRole,
  );
}

String _initials(String name) {
  final parts = name
      .trim()
      .split(RegExp(r'\s+'))
      .where((p) => p.isNotEmpty)
      .toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.substring(0, 1).toUpperCase();
  return (parts.first.substring(0, 1) + parts.last.substring(0, 1))
      .toUpperCase();
}

/// A radio-list role picker returning the chosen [OrganizationRole], or null
/// when dismissed.  [current] is pre-selected.
class _RolePickerDialog extends StatefulWidget {
  const _RolePickerDialog({required this.title, required this.current});

  final String title;
  final OrganizationRole current;

  @override
  State<_RolePickerDialog> createState() => _RolePickerDialogState();
}

class _RolePickerDialogState extends State<_RolePickerDialog> {
  late OrganizationRole _selected = widget.current;

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: RadioGroup<OrganizationRole>(
        groupValue: _selected,
        onChanged: (value) => setState(() => _selected = value ?? _selected),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final role in OrganizationRole.values)
              RadioListTile<OrganizationRole>(
                value: role,
                title: Text(_roleLabel(role)),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_selected),
          child: const Text('Save'),
        ),
      ],
    );
  }
}

String _roleLabel(OrganizationRole role) => switch (role) {
  OrganizationRole.owner => 'Owner',
  OrganizationRole.admin => 'Admin',
  OrganizationRole.member => 'Member',
};
