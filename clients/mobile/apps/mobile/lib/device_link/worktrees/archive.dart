import '../desktop/ipc.dart';
import '../dto.dart';
import '../protocol.dart';

/// Removing the checkout stops its sessions first, so it can outlast the
/// session's default request timeout.
const _archiveTimeout = Duration(minutes: 2);

/// Archives a worktree through the desktop's own archive IPC, as desktop's
/// `worktree.archive` client command does. No local writer.
final class DeviceWorktreeArchiver {
  DeviceWorktreeArchiver(this.ipc);
  final DesktopIpc ipc;

  Future<void> archive(String projectId, String worktreeId) async {
    final result = deviceLinkObject(
      deviceChatDto(await ipc.invoke('projects:load')),
    );
    final project = (result['items'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .where((row) => row['id'] == projectId)
        .firstOrNull;
    final type = project?['type'];
    if (project == null || (type != 'single-repo' && type != 'multi-repo')) {
      throw const DeviceLinkException('This project is no longer available.');
    }
    final rows = (project['worktrees'] as List? ?? const [])
        .whereType<Map<String, dynamic>>()
        .toList();
    final target = rows.where((row) => row['id'] == worktreeId).firstOrNull;
    if (target == null) {
      throw const DeviceLinkException('This worktree is no longer available.');
    }
    final remaining = [
      for (final row in rows)
        if (row['id'] case final String id when id != worktreeId) id,
    ];
    final multi = type == 'multi-repo';
    final response = deviceChatDto(
      await ipc.invoke(
        multi ? 'workspace:archive-worktree' : 'worktree:archive',
        [
          {
            if (multi) 'workspaceId': projectId else 'projectId': projectId,
            if (!multi) 'repoPath': deviceLinkString(project, 'repoPath'),
            'worktreeId': worktreeId,
            'remainingWorktreeOrder': remaining,
            'expectedRemainingWorktreeOrder': remaining,
            if (target['createdAt'] case final String createdAt)
              'expectedCreatedAt': createdAt,
            // Matches Remote Control's `portal.worktree.archive`: the
            // retained archive stays until it is managed on the desktop.
            'lockAfterArchive': true,
          },
        ],
        _archiveTimeout,
      ),
    );
    if (response is Map && response['success'] == false) {
      throw const DeviceLinkException(
        'Your computer could not archive the worktree.',
      );
    }
    try {
      await ipc.invoke('desktop:session-snapshot-invalidate');
    } on DeviceLinkException {
      // Older hosts may refuse it; the overview re-reads projects anyway.
    }
  }
}
