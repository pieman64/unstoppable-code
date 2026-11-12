import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_overview_sections.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/workspaces/attention_sections.dart' as shared;
import 'worktree_archive_row.dart';

/// Remote Control's actions around the shared mobile attention queue.
class AttentionSections extends StatelessWidget {
  const AttentionSections({
    super.key,
    required this.data,
    required this.onOpenWorktree,
  });

  final AttentionSectionsData data;
  final ValueChanged<RemoteWorktree> onOpenWorktree;
  static const int visibleRowCap = shared.AttentionSections.visibleRowCap;

  @override
  Widget build(BuildContext context) => shared.AttentionSections(
    data: data,
    rowBuilder: (entry) => WorktreeArchiveRow(
      key: ValueKey(
        'attention-actions-${entry.worktree.workspaceLocalId}-${entry.worktree.localId}',
      ),
      worktree: entry.worktree,
      onTap: () => onOpenWorktree(entry.worktree),
      contextLabel: entry.workspaceName,
    ),
  );
}
