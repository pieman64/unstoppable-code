import 'dart:async';

import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/sub_teams/view_models/sub_teams_view_model.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_team_members_sheet.dart';
import 'package:mobile/ui/features/sub_teams/views/sub_team_name_dialog.dart';

/// The organization sub-teams screen: lists the org's sub-teams and, for
/// ADMIN+/OWNER viewers, exposes create / rename / delete and membership
/// management. Lower-ranked viewers get a read-only list as defense in depth
/// even though the entry point is already role-gated.
///
/// The [SubTeamsViewModel] is provided lazily (it is not needed until this
/// screen is pushed from the Members overflow menu), so this screen kicks off
/// its initial [SubTeamsViewModel.load] on mount.
class SubTeamsScreen extends StatefulWidget {
  const SubTeamsScreen({super.key});

  @override
  State<SubTeamsScreen> createState() => _SubTeamsScreenState();
}

class _SubTeamsScreenState extends State<SubTeamsScreen> {
  @override
  void initState() {
    super.initState();
    // Defer the load to after the first frame: load() synchronously flips
    // isLoading and notifies, which would otherwise mark the provider dirty
    // during the initial build. A completed load (re-entering the screen)
    // re-fetches so the reused view model does not show stale org data.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final viewModel = context.read<SubTeamsViewModel>();
      if (!viewModel.isLoading) {
        unawaited(viewModel.load());
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<SubTeamsViewModel>();
    final canManage = viewModel.canManageSubTeams;

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Sub-teams'),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (canManage)
              CanopyIconButton(
                glyph: CanopyGlyph.userAdd,
                tooltip: 'Create sub-team',
                onPressed: viewModel.isBusy
                    ? null
                    : () => unawaited(_createSubTeam(context, viewModel)),
              ),
          ],
        ),
      ),
      body: Builder(
        builder: (context) => Builder(
          builder: (context) {
            if (viewModel.isLoading) {
              return const Center(child: CircularProgressIndicator());
            }
            if (viewModel.error != null) {
              return StateMessageView(
                glyph: CanopyGlyph.userGroup,
                title: 'Could not load sub-teams',
                message: viewModel.errorMessage,
                onRetry: viewModel.load,
              );
            }
            if (viewModel.organization == null) {
              return const SizedBox.shrink();
            }
            return RefreshIndicator(
              edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
              onRefresh: viewModel.load,
              child: _SubTeamsBody(viewModel: viewModel, canManage: canManage),
            );
          },
        ),
      ),
    );
  }

  Future<void> _createSubTeam(
    BuildContext context,
    SubTeamsViewModel viewModel,
  ) async {
    final name = await showSubTeamNameDialog(
      context,
      title: 'Create sub-team',
      confirmLabel: 'Create',
    );
    if (name == null) return;
    if (!context.mounted) return;
    await guardAction(
      context,
      () => viewModel.createSubTeam(name),
      'Could not create the sub-team.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }
}

class _SubTeamsBody extends StatelessWidget {
  const _SubTeamsBody({required this.viewModel, required this.canManage});

  final SubTeamsViewModel viewModel;
  final bool canManage;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subTeams = viewModel.subTeams;

    return ListView(
      padding:
          CanopyScaffold.contentPaddingOf(context) +
          const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      children: [
        Text(
          viewModel.organization?.name ?? '',
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        Text(
          '${subTeams.length} ${subTeams.length == 1 ? 'sub-team' : 'sub-teams'}',
          style: theme.textTheme.labelMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 8),
        if (subTeams.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 32),
            child: Center(
              child: Text(
                canManage
                    ? 'No sub-teams yet. Create one to group members.'
                    : 'No sub-teams yet.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          )
        else
          for (final team in subTeams)
            _SubTeamRow(viewModel: viewModel, team: team, canManage: canManage),
      ],
    );
  }
}

enum _SubTeamAction { manageMembers, rename, delete }

class _SubTeamRow extends StatelessWidget {
  const _SubTeamRow({
    required this.viewModel,
    required this.team,
    required this.canManage,
  });

  final SubTeamsViewModel viewModel;
  final OrganizationSubTeam team;
  final bool canManage;

  @override
  Widget build(BuildContext context) {
    final count = team.memberCount.toInt();
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: const CircleAvatar(child: Icon(Icons.diversity_3, size: 20)),
      title: Text(team.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text('$count ${count == 1 ? 'member' : 'members'}'),
      trailing: canManage
          ? PopupMenuButton<_SubTeamAction>(
              enabled: !viewModel.isBusy,
              icon: const Icon(Icons.more_vert),
              onSelected: (action) => unawaited(_onSelected(context, action)),
              itemBuilder: (context) => const [
                PopupMenuItem(
                  value: _SubTeamAction.manageMembers,
                  child: Text('Manage members…'),
                ),
                PopupMenuItem(
                  value: _SubTeamAction.rename,
                  child: Text('Rename…'),
                ),
                PopupMenuItem(
                  value: _SubTeamAction.delete,
                  child: Text('Delete…'),
                ),
              ],
            )
          : null,
    );
  }

  Future<void> _onSelected(BuildContext context, _SubTeamAction action) async {
    switch (action) {
      case _SubTeamAction.manageMembers:
        await _manageMembers(context);
      case _SubTeamAction.rename:
        await _rename(context);
      case _SubTeamAction.delete:
        await _delete(context);
    }
  }

  Future<void> _manageMembers(BuildContext context) async {
    final selected = await showModalBottomSheet<List<String>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => SubTeamMembersSheet(
        teamName: team.name,
        members: viewModel.members,
        selectedMemberIds: viewModel
            .membersInTeam(team.id)
            .map((m) => m.id)
            .toList(growable: false),
      ),
    );
    if (selected == null) return;
    if (!context.mounted) return;
    await guardAction(
      context,
      () => viewModel.setMembership(team.id, selected),
      'Could not update sub-team members.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }

  Future<void> _rename(BuildContext context) async {
    final name = await showSubTeamNameDialog(
      context,
      title: 'Rename sub-team',
      confirmLabel: 'Save',
      initialValue: team.name,
    );
    if (name == null || name == team.name) return;
    if (!context.mounted) return;
    await guardAction(
      context,
      () => viewModel.renameSubTeam(team.id, name),
      'Could not rename the sub-team.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }

  Future<void> _delete(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Delete sub-team',
      message:
          'Delete "${team.name}"? Its members stay in the organization but '
          'are removed from this sub-team.',
      confirmLabel: 'Delete',
    );
    if (!context.mounted) return;
    if (!confirmed) return;
    await guardAction(
      context,
      () => viewModel.deleteSubTeam(team.id),
      'Could not delete the sub-team.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }
}

String? _lapseActionMessage(Object error, SubTeamsViewModel viewModel) {
  final org = viewModel.organization;
  return orgLapseActionMessage(
    error,
    orgName: org?.name,
    viewerRole: org?.viewerRole,
  );
}
