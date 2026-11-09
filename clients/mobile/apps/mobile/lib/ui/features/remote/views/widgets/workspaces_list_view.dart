import 'package:mobile/ui/core/workspaces/add_project_sheet.dart';
import 'package:mobile/ui/core/workspaces/workspace_section_header.dart';
import 'dart:async';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'remote_degraded_banner.dart';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/features/remote/view_models/project_clone_coordinator.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_route.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:mobile/ui/features/remote/views/widgets/attention_sections.dart';
import 'package:mobile/ui/features/remote/views/widgets/command_failure_banner.dart';
import 'package:mobile/ui/features/remote/views/widgets/pending_project_row.dart';
import 'package:mobile/ui/features/remote/views/widgets/standalone_chat_row.dart';
import 'package:mobile/ui/features/remote/views/widgets/worktree_archive_row.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/core/dimens.dart';

/// Connected Remote home: a compact, deduplicated attention queue is pinned
/// above the collapsed workspace navigator and disappears when it is empty.
class WorkspacesListView extends StatefulWidget {
  const WorkspacesListView({super.key});

  @override
  State<WorkspacesListView> createState() => _WorkspacesListViewState();
}

class _WorkspacesListViewState extends State<WorkspacesListView> {
  /// Workspace ids expanded by the user. Phone sections start collapsed so
  /// the first viewport remains a useful workspace index.
  final Set<String> _expanded = {};

  @override
  Widget build(BuildContext context) {
    final viewModel = context.read<RemoteControlViewModel>();
    // Select shell collections rather than the snapshot: transcript upserts
    // replace the snapshot too. Read receipts can change row badges without
    // replacing a shell collection, so include their projected scalar values.
    context.select<RemoteControlViewModel, List<Object?>>(
      (vm) => [
        vm.snapshot?.workspaces,
        vm.snapshot?.worktrees,
        vm.snapshot?.standaloneChats,
        for (final worktree in vm.allWorktrees)
          (worktree.hasUnread, worktree.isStreaming),
        for (final chat in vm.allStandaloneChats)
          (chat.hasUnread, chat.hasActiveChat),
        vm.portalConnectionStatus,
        vm.linkState,
        vm.connection?.deviceLabel,
        vm.commandFailureMessage,
        vm.error,
        vm.isSyncing,
        vm.isCreatingWorktree,
        vm.projectClones,
      ],
    );
    // Everything below lists the selected workspace context only (CAN-4429).
    final workspaceContext = context.watch<WorkspaceContext?>();
    final scope = RemoteContextScope(workspaceContext, viewModel.workspaces);
    final allWorkspaces = scope.workspaces;
    final unmatchedChats = scope.standaloneChats(
      viewModel.unmatchedStandaloneChats,
    );
    final worktreesByWorkspace = indexWorktreesByWorkspace(
      workspaces: allWorkspaces,
      worktrees: viewModel.allWorktrees,
    );
    List<RemoteWorktree> allWorktreesFor(String workspaceLocalId) =>
        worktreesByWorkspace[workspaceLocalId] ?? const [];
    // Sidebar visibility mirrors desktop: explicit hides drop out, empty
    // temporary (`alwaysShow: false`) workspaces don't render ghost headers,
    // and hidden worktrees don't render rows. Attention keeps its own
    // (intentionally different) hidden policy on the unfiltered lists.
    final workspaces = visibleRemoteWorkspaces(
      workspaces: allWorkspaces,
      worktreesFor: allWorktreesFor,
    );
    List<RemoteWorktree> worktreesFor(String workspaceLocalId) =>
        visibleRemoteWorktrees(allWorktreesFor(workspaceLocalId));
    // A project is added as Personal, so adding one and its pending clone
    // stay out of organization contexts.
    final addsProjects = workspaceContext?.isPersonal ?? true;
    final clones = addsProjects
        ? viewModel.projectClones
        : const <RemoteProjectClone>[];
    void addProject() => unawaited(
      showAddProjectSheet(
        context,
        description:
            'Your desktop clones the repository and adds it to Personal.',
        onSubmit: viewModel.addProject,
      ),
    );
    // A clone in progress is not an empty project list.
    final hasContent =
        workspaces.isNotEmpty || unmatchedChats.isNotEmpty || clones.isNotEmpty;
    // The documented hidden asymmetry covers hidden WORKTREES (they can
    // still be working); a workspace the user explicitly hid must not
    // surface its rows in the attention queue at all.
    final attention = computeAttentionSections(
      workspaces: [
        for (final workspace in allWorkspaces)
          if (!workspace.hidden) workspace,
      ],
      worktreesFor: allWorktreesFor,
    );

    // One session-wide summary batch warms tab discovery without queuing
    // activity/files snapshots for each visible worktree.
    if (workspaces.any(
      (workspace) =>
          _expanded.contains(workspace.localId) &&
          worktreesFor(workspace.localId).isNotEmpty,
    )) {
      viewModel.ensureChatSummariesIndex(background: true);
    }

    // Flatten sections into independently built rows. In particular, an expanded
    // workspace must not be one giant Column child of the scroll viewport.
    final rows = <({Key key, WidgetBuilder build})>[];
    void addRow(Key key, WidgetBuilder build) =>
        rows.add((key: key, build: build));
    final leading = <Widget>[
      if (RemoteDegradedBanner.shows(
        status: viewModel.portalConnectionStatus,
        linkState: viewModel.linkState,
      )) ...[
        RemoteDegradedBanner(
          status: viewModel.portalConnectionStatus,
          linkState: viewModel.linkState,
          deviceLabel: viewModel.connection?.deviceLabel,
        ),
        // The banner has no trailing space of its own; the connected
        // device card used to supply it from below.
        const SizedBox(height: 8),
      ],
      if (viewModel.commandFailureMessage case final message?) ...[
        CommandFailureBanner(
          message: message,
          onDismiss: viewModel.clearCommandFailure,
          borderRadius: BorderRadius.circular(12),
        ),
        const SizedBox(height: 8),
      ],
      // Gated on what actually renders, not on `isEmpty`: that predicate
      // still counts the working lists, which no longer pin anything, so
      // rendering on it would leave an empty block plus this spacer.
      if (attention.attentionEntries.isNotEmpty) ...[
        AttentionSections(
          data: attention,
          onOpenWorktree: (worktree) => _openRemoteChat(
            context,
            RemoteChatScreen.worktree(worktree: worktree),
          ),
        ),
        const SizedBox(height: 12),
      ],
      _SectionLabel(
        count: workspaces.length,
        onAddProject: addsProjects ? addProject : null,
      ),
      const SizedBox(height: 4),
      if (!hasContent && viewModel.error != null)
        _SnapshotLoadError(onRetry: viewModel.refresh)
      else if (!hasContent && viewModel.isSyncing)
        const _SyncingWorkspaces()
      else if (!hasContent && addsProjects)
        _EmptyWorkspaces(onAddProject: addProject)
      else if (!hasContent)
        const _NoOrganizationProjects(),
    ];
    for (var i = 0; i < leading.length; i++) {
      final child = leading[i];
      addRow(ValueKey('leading-$i'), (_) => child);
    }
    for (final clone in clones) {
      addRow(
        ValueKey('pending-project-${clone.id}'),
        (_) => PendingProjectRow(
          clone: clone,
          onDismiss: () => viewModel.dismissProjectClone(clone.id),
        ),
      );
    }
    void addChat(RemoteStandaloneChat chat) {
      addRow(
        ValueKey(('chat', chat.projectLocalId, chat.localId)),
        (context) => StandaloneChatRow(
          chat: chat,
          onTap: () => _openRemoteChat(
            context,
            RemoteChatScreen.standalone(standaloneChat: chat),
          ),
        ),
      );
    }

    if (unmatchedChats.isNotEmpty) {
      addRow(
        const ValueKey('unmatched-header'),
        (_) => const _StandaloneChatsHeader(),
      );
      for (final chat in unmatchedChats) {
        addChat(chat);
      }
      addRow(
        const ValueKey('unmatched-spacer'),
        (_) => const SizedBox(height: 8),
      );
    }
    for (final workspace in workspaces) {
      final worktrees = worktreesFor(workspace.localId);
      final chats = viewModel.standaloneChatsFor(workspace.localId);
      addRow(
        ValueKey('workspace-${workspace.localId}'),
        (context) => _WorkspaceHeader(
          workspace: workspace,
          worktrees: worktrees,
          chats: chats,
          collapsed: !_expanded.contains(workspace.localId),
          // The destination selects the correct create contract: tree
          // workspaces create a worktree immediately, while flat
          // workspaces mint a standalone chat with the first message.
          onCreateTask: () => _openNewWorktreeChat(context, workspace.localId),
          createTaskEnabled:
              workspace.resolvedLayout == RemoteWorkspaceLayout.flat ||
              !viewModel.isCreatingWorktree,
          onToggle: () => setState(() {
            if (!_expanded.remove(workspace.localId)) {
              _expanded.add(workspace.localId);
            }
          }),
        ),
      );
      if (!_expanded.contains(workspace.localId)) continue;
      if (worktrees.isEmpty && chats.isEmpty) {
        addRow(
          ValueKey('empty-${workspace.localId}'),
          (context) => Padding(
            padding: const EdgeInsets.only(
              left: AppDimens.navRowTitleInset,
              bottom: 10,
            ),
            child: Text(
              workspace.resolvedLayout == RemoteWorkspaceLayout.flat
                  ? 'No chats'
                  : 'No worktrees',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        );
      }
      for (final worktree in worktrees) {
        final key = ValueKey(
          'worktree-${worktree.workspaceLocalId}-${worktree.localId}',
        );
        addRow(
          ValueKey(('row', key)),
          (context) => WorktreeArchiveRow(
            key: key,
            worktree: worktree,
            onTap: () => _openRemoteChat(
              context,
              RemoteChatScreen.worktree(worktree: worktree),
            ),
          ),
        );
      }
      for (final chat in chats) {
        addChat(chat);
      }
      addRow(
        ValueKey('spacer-${workspace.localId}'),
        (_) => const SizedBox(height: 4),
      );
    }
    final indexByKey = {for (var i = 0; i < rows.length; i++) rows[i].key: i};
    return RefreshIndicator(
      edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
      onRefresh: () => _handleRefresh(ScaffoldMessenger.of(context), viewModel),
      child: ListView.builder(
        key: const ValueKey('remote-workspaces-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding:
            CanopyScaffold.contentPaddingOf(context) +
            const EdgeInsets.fromLTRB(16, 12, 16, 32),
        itemCount: rows.length,
        findChildIndexCallback: (key) => indexByKey[key],
        itemBuilder: (context, index) => KeyedSubtree(
          key: rows[index].key,
          child: rows[index].build(context),
        ),
      ),
    );
  }
}

/// Re-fetches the snapshot and, if it fails while still connected, surfaces a
/// retryable SnackBar.  Without this a failed pull-to-refresh would only stop
/// the spinner: the connected UI never reads [RemoteControlViewModel.error],
/// so the failure would otherwise be invisible to the user.
Future<void> _handleRefresh(
  ScaffoldMessengerState messenger,
  RemoteControlViewModel viewModel,
) async {
  await viewModel.refresh();
  if (viewModel.isConnected && viewModel.error != null) {
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: const Text(
            'Could not refresh projects. Check your connection and try '
            'again.',
          ),
          action: SnackBarAction(
            label: 'Retry',
            onPressed: () => unawaited(_handleRefresh(messenger, viewModel)),
          ),
        ),
      );
  }
}

/// `Projects  (n)` section label mirroring the web sidebar, with the Add
/// project action at its trailing edge.
class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.count, this.onAddProject});

  final int count;

  /// Null hides the action.
  final VoidCallback? onAddProject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Text(
          'Projects',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        const SizedBox(width: 8),
        if (count > 0)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              '$count',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        const Spacer(),
        if (onAddProject case final onAddProject?)
          CanopyIconButton(
            key: const ValueKey('add-project-header'),
            glyph: CanopyGlyph.plusMedium,
            tooltip: 'Add project',
            size: CanopyIconButtonSize.small,
            onPressed: onAddProject,
          ),
      ],
    );
  }
}

/// Workspace header; expanded rows are separate children of the lazy list.
class _WorkspaceHeader extends StatelessWidget {
  const _WorkspaceHeader({
    required this.workspace,
    required this.worktrees,
    required this.chats,
    required this.collapsed,
    required this.onToggle,
    required this.onCreateTask,
    required this.createTaskEnabled,
  });

  final RemoteWorkspace workspace;
  final List<RemoteWorktree> worktrees;
  final List<RemoteStandaloneChat> chats;
  final bool collapsed;
  final VoidCallback onToggle;

  /// Opens the shared composer preselected to this workspace; null for
  /// workspace types that cannot hold worktrees.
  final VoidCallback? onCreateTask;
  final bool createTaskEnabled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Temporary (adhoc-combine) workspaces render neutral instead of the
    // assigned color, mirroring the desktop's grey temporary badge.
    final accent = workspace.temporary
        ? theme.colorScheme.onSurfaceVariant
        : workspaceColor(workspace.color) ?? theme.colorScheme.primary;
    final itemLabel = switch (workspace.type) {
      RemoteWorkspaceType.cowork =>
        '${chats.length} ${chats.length == 1 ? 'chat' : 'chats'}',
      _ => [
        if (worktrees.isNotEmpty)
          '${worktrees.length} '
              '${worktrees.length == 1 ? 'worktree' : 'worktrees'}',
        if (chats.isNotEmpty)
          '${chats.length} ${chats.length == 1 ? 'chat' : 'chats'}',
        if (worktrees.isEmpty && chats.isEmpty) '0 worktrees',
      ].join(' · '),
    };

    return WorkspaceSectionHeader(
      id: workspace.localId,
      name: workspace.name,
      itemLabel: itemLabel,
      icon: workspaceTypeGlyph(workspace.type?.wire),
      accent: accent,
      collapsed: collapsed,
      onToggle: onToggle,
      onCreateTask: onCreateTask,
      createTaskEnabled: createTaskEnabled,
    );
  }
}

/// Standalone chats whose project has no corresponding workspace row are
/// still usable and must remain reachable from the connected list.
class _StandaloneChatsHeader extends StatelessWidget {
  const _StandaloneChatsHeader();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 10, bottom: 4),
      child: Text(
        'CHATS',
        style: theme.textTheme.labelSmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontWeight: AppTypography.emphasisWeight,
          fontVariations: AppTypography.emphasisVariations,
        ),
      ),
    );
  }
}

void _openRemoteChat(BuildContext context, Widget screen) {
  Navigator.of(context).push(remoteChatRoute(context, screen));
}

void _openNewWorktreeChat(BuildContext context, String workspaceLocalId) {
  final viewModel = context.read<RemoteControlViewModel>();
  final workspace = viewModel.workspaces
      .where((workspace) => workspace.localId == workspaceLocalId)
      .firstOrNull;
  if (workspace == null) return;
  // The real chat screen is the only route: it creates the worktree (or
  // mints the flat workspace's first chat) in place, so there is no handoff
  // from an intermediate screen.
  _openRemoteChat(context, RemoteChatScreen.create(workspace: workspace));
}

/// Shown while the desktop is still projecting its first snapshot into the
/// relay (`state.refreshing`): an empty list at that moment means "syncing",
/// not "no workspaces".
class _SyncingWorkspaces extends StatelessWidget {
  const _SyncingWorkspaces();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 48),
      child: Column(
        children: [
          const LoadingSpinner(size: 22),
          const SizedBox(height: 16),
          Text(
            'Syncing with your desktop…',
            style: theme.textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}

class _SnapshotLoadError extends StatelessWidget {
  const _SnapshotLoadError({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 48),
      child: Column(
        children: [
          Icon(Icons.sync_problem, size: 48, color: theme.colorScheme.error),
          const SizedBox(height: 16),
          Text('Could not load projects', style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Text(
            'Your desktop is still connected. Try loading its projects again.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: () => unawaited(onRetry()),
            icon: const Icon(Icons.refresh),
            label: const Text('Retry'),
          ),
        ],
      ),
    );
  }
}

class _EmptyWorkspaces extends StatelessWidget {
  const _EmptyWorkspaces({required this.onAddProject});

  final VoidCallback onAddProject;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 48),
      child: Column(
        children: [
          Icon(
            Icons.workspaces_outlined,
            size: 48,
            color: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 16),
          Text('No projects yet', style: theme.textTheme.titleMedium),
          const SizedBox(height: 16),
          CanopyButton(
            key: const ValueKey('add-project-empty'),
            label: 'Add project',
            glyph: CanopyGlyph.plusMedium,
            onPressed: onAddProject,
          ),
        ],
      ),
    );
  }
}

/// An organization context with none of its projects on this computer.
class _NoOrganizationProjects extends StatelessWidget {
  const _NoOrganizationProjects();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      key: const ValueKey('remote-no-organization-projects'),
      padding: const EdgeInsets.only(top: 48),
      child: Column(
        children: [
          CanopyIcon(
            glyph: CanopyGlyph.buildings,
            size: 48,
            tint: theme.colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 16),
          Text(
            'No organization projects',
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            'This computer has no projects from this organization. Choose '
            'another context in the menu to see its projects.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

/// Workspace-kind glyphs mirroring the shared `WorkspaceKindBadge`
/// vocabulary: code brackets for single-repo (git) workspaces, stacked
/// folders for multi-repo, and a single folder for cowork (non-git)
/// workspaces. (Desktop's GitHub owner-avatar swap needs the local git
/// remote, which the portal wire does not carry.)

/// Parses a `#rgb`, `#rrggbb`, or `#aarrggbb` hex string into a [Color],
/// returning null for absent/malformed values so callers can fall back to a
/// theme color.
