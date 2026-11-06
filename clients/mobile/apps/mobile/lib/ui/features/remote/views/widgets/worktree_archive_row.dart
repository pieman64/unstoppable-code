import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/space_notifications_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/space_notifications_sheet.dart';
import 'package:mobile/ui/core/workspaces/worktree_archive_menu.dart';
import 'package:mobile/ui/core/workspaces/worktree_row.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/core/dimens.dart';

/// Worktree context menu shared by project and attention rows.
class WorktreeArchiveRow extends StatefulWidget {
  const WorktreeArchiveRow({
    super.key,
    required this.worktree,
    required this.onTap,
    this.contextLabel,
  });
  final RemoteWorktree worktree;
  final VoidCallback onTap;

  /// Passed to [WorktreeRow.contextLabel].
  final String? contextLabel;

  @override
  State<WorktreeArchiveRow> createState() => _WorktreeArchiveRowState();
}

class _WorktreeArchiveRowState extends State<WorktreeArchiveRow> {
  bool _menuOpen = false;
  bool _confirming = false;

  Future<void> _archive(RemoteControlViewModel vm) async {
    if (_confirming || vm.isArchivingWorktree(widget.worktree)) return;
    _confirming = true;
    final generation = vm.sessionGeneration;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final confirmed = await confirmWorktreeArchive(
        context,
        widget.worktree.label ?? widget.worktree.branch,
      );
      if (!mounted || generation != vm.sessionGeneration) return;

      if (!confirmed) return;
      await vm.archiveWorktree(widget.worktree);
    } catch (error) {
      if (!messenger.mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            error is RemoteControlException
                ? error.message
                : 'Could not archive the worktree. Check your connection and try again.',
          ),
        ),
      );
    } finally {
      _confirming = false;
    }
  }

  Future<void> _showMenu(Offset position) async {
    if (_menuOpen || _confirming) return;
    final vm = context.read<RemoteControlViewModel>();
    final generation = vm.sessionGeneration;
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final local = overlay.globalToLocal(position);
    final enabled = vm.canArchiveWorktree(widget.worktree);
    final pending = vm.isArchivingWorktree(widget.worktree);
    final notifications = context.read<SpaceNotificationsViewModel?>();
    final spaceId = widget.worktree.notificationSpaceId;
    final notificationsAvailable =
        notifications != null &&
        spaceId != null &&
        vm.canChooseSpaceNotifications;
    _menuOpen = true;
    try {
      final selected = await showMenu<String>(
        context: context,
        position: RelativeRect.fromRect(
          Rect.fromLTWH(local.dx, local.dy, 0, 0),
          Offset.zero & overlay.size,
        ),
        items: [
          if (notificationsAvailable)
            PopupMenuItem<String>(
              key: ValueKey('space-notify-open-${widget.worktree.localId}'),
              value: 'notifications',
              child: Row(
                children: [
                  CanopyIcon(
                    glyph: CanopyGlyph.bell,
                    size: 20,
                    tint: Theme.of(context).colorScheme.onSurface,
                  ),
                  const SizedBox(width: 12),
                  const Text('Notifications'),
                ],
              ),
            ),
          worktreeArchiveMenuItem(
            context,
            key: ValueKey('archive-worktree-${widget.worktree.localId}'),
            enabled: enabled,
            pending: pending,
          ),
          if (!enabled && !pending)
            const PopupMenuItem<String>(
              enabled: false,
              child: Text('Archiving is unavailable for this connection.'),
            ),
        ],
      );
      if (!mounted || generation != vm.sessionGeneration) return;
      if (selected == 'notifications' &&
          notifications != null &&
          spaceId != null &&
          vm.canChooseSpaceNotifications) {
        await showSpaceNotificationsSheet(
          context,
          viewModel: notifications,
          spaceId: spaceId,
          title: switch (widget.worktree.label?.trim()) {
            final label? when label.isNotEmpty => label,
            _ => widget.worktree.branch,
          },
        );
      }
      if (selected == 'archive' && vm.canArchiveWorktree(widget.worktree)) {
        await _archive(vm);
      }
    } finally {
      _menuOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.read<RemoteControlViewModel>();
    context.select<RemoteControlViewModel, Object>(
      (vm) => (
        vm.isArchivingWorktree(widget.worktree),
        vm.worktreeNeedsAnswer(widget.worktree),
      ),
    );
    final pending = vm.isArchivingWorktree(widget.worktree);
    void openMenu() {
      final box = context.findRenderObject()! as RenderBox;
      _showMenu(box.localToGlobal(box.size.center(Offset.zero)));
    }

    final onTap = pending ? null : widget.onTap;
    return Semantics(
      customSemanticsActions: {
        const CustomSemanticsAction(label: 'Worktree actions'): openMenu,
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onLongPressStart: (details) => _showMenu(details.globalPosition),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            WorktreeRow(
              worktree: widget.worktree,
              onTap: onTap,
              needsAnswer: vm.worktreeNeedsAnswer(widget.worktree),
              contextLabel: widget.contextLabel,
            ),
            if (pending)
              const Padding(
                padding: EdgeInsets.only(
                  left: AppDimens.navRowTitleInset,
                  bottom: 8,
                ),
                child: Text('Archiving…'),
              ),
          ],
        ),
      ),
    );
  }
}
