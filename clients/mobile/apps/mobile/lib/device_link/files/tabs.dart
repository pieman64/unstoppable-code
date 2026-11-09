import 'package:mobile/data/models/chat_tab_item.dart';

import '../desktop/ipc.dart';
import '../protocol.dart';
import '../worktree_ref.dart';
import 'reader.dart';
import 'rooted_path.dart';

/// A file tab the computer opened in a worktree, usually from an agent's
/// ShowFiles call.
final class DeviceFileTab implements ChatFileTabItem, DeviceWorktreeRef {
  const DeviceFileTab({
    required this.projectId,
    required this.worktreeId,
    required this.id,
    required this.filePath,
    required this.title,
  });

  @override
  final String projectId;
  @override
  final String worktreeId;
  final String id;

  /// The computer's absolute path.
  final String filePath;
  final String title;

  @override
  String get fileTabId => id;
  @override
  String get displayTitle => title;
  @override
  String? get displayFolder {
    final segments = filePath.split(RegExp(r'[\\/]'));
    return segments.length < 2 || segments[segments.length - 2].isEmpty
        ? null
        : segments[segments.length - 2];
  }
}

/// The worktree's open file tabs, in tab order. Archived tabs and tabs
/// without a file are skipped.
List<DeviceFileTab> deviceFileTabs(
  DeviceWorktreeRef worktree,
  Iterable<Map<String, dynamic>> tabs,
) => [
  for (final tab in tabs)
    if (tab case {
      'kind': 'file',
      'id': final String id,
      'filePath': final String path,
    } when path.isNotEmpty && tab['archivedAt'] == null)
      DeviceFileTab(
        projectId: worktree.projectId,
        worktreeId: worktree.worktreeId,
        id: id,
        filePath: path,
        title: switch (tab['title']) {
          final String title when title.trim().isNotEmpty => title.trim(),
          _ => path.split(RegExp(r'[\\/]')).last,
        },
      ),
];

/// Finds which of its worktree's roots a file tab lives under. Roots are
/// read once per worktree and kept for this connection.
final class DeviceFileLocator {
  DeviceFileLocator(this.ipc);

  final DesktopIpc ipc;
  final _roots = <String, Future<List<String>>>{};

  DeviceFileReader reader(DeviceWorktreeRef worktree) =>
      DeviceFileReader(ipc, worktree);

  /// Throws [DeviceLinkException] when the roots cannot be read, and
  /// [DeviceFileReadFailure.notFound] when no root contains the file.
  Future<DeviceRootedPath> locate(DeviceFileTab tab) async {
    final key = '${tab.projectId}/${tab.worktreeId}';
    final pending = _roots[key] ??= reader(tab).roots();
    final List<String> roots;
    try {
      roots = await pending;
    } catch (_) {
      if (identical(_roots[key], pending)) _roots.remove(key);
      rethrow;
    }
    final located = locateUnderRoot(roots, tab.filePath);
    if (located == null) {
      // Roots change when repositories are added; read them again next time.
      _roots.remove(key);
      throw const DeviceFileReadException(
        DeviceFileReadFailure.notFound,
        'The file is outside this worktree.',
      );
    }
    return located;
  }

  /// Forget cached roots, for example after a reconnect.
  void clear() => _roots.clear();
}
