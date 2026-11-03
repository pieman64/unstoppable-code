import 'package:mobile/data/models/remote_activity.dart';

/// One changed file placed under its directory group.
class ChangedFileEntry {
  const ChangedFileEntry({required this.file, required this.fileName});

  final RemoteChangedFile file;

  /// Last path segment, what the row shows once the directory is a header.
  final String fileName;
}

/// Files that share a parent directory (and, in multi-repo worktrees, a repo).
class ChangedFileDirectoryGroup {
  const ChangedFileDirectoryGroup({
    required this.repoId,
    required this.repoName,
    required this.directory,
    required this.files,
  });

  final String? repoId;
  final String? repoName;

  /// Parent directory without a trailing slash; empty for the repo root.
  final String directory;
  final List<ChangedFileEntry> files;
}

/// Totals for a section header (`12 files · +386 -10`).
class ChangedFilesSummary {
  const ChangedFilesSummary({
    required this.fileCount,
    required this.insertions,
    required this.deletions,
  });

  final int fileCount;
  final int insertions;
  final int deletions;
}

/// Groups [files] by repo then parent directory, both sorted, with file names
/// sorted inside each group. Turns a flat list of long, mostly-identical
/// paths into short rows under one directory header each.
List<ChangedFileDirectoryGroup> groupChangedFilesByDirectory(
  List<RemoteChangedFile> files,
) {
  final byKey = <(String, String), List<ChangedFileEntry>>{};
  final meta = <(String, String), (String?, String?)>{};
  for (final file in files) {
    final slash = file.filePath.lastIndexOf('/');
    final directory = slash < 0 ? '' : file.filePath.substring(0, slash);
    final fileName = slash < 0
        ? file.filePath
        : file.filePath.substring(slash + 1);
    final key = (file.repoId ?? '', directory);
    byKey
        .putIfAbsent(key, () => [])
        .add(ChangedFileEntry(file: file, fileName: fileName));
    meta[key] = (file.repoId, file.repoName);
  }
  final keys = byKey.keys.toList()
    ..sort((a, b) {
      final repo = _compareNames(a.$1, b.$1);
      return repo != 0 ? repo : compareDirectoriesLikeDesktop(a.$2, b.$2);
    });
  return [
    for (final key in keys)
      ChangedFileDirectoryGroup(
        repoId: meta[key]?.$1,
        repoName: meta[key]?.$2,
        directory: key.$2,
        files: (byKey[key] ?? const [])
          ..sort((a, b) => _compareNames(a.fileName, b.fileName)),
      ),
  ];
}

/// Orders two directory paths the way the desktop changed-files tree
/// (`DiffFileTree.tsx`) walks them: preorder, with a directory's
/// subfolders before its own files, and sibling names compared
/// case-insensitively (the desktop uses `localeCompare`). The root (`''`)
/// therefore comes last, after every folder.
int compareDirectoriesLikeDesktop(String a, String b) {
  if (a == b) return 0;
  final left = a.isEmpty ? const <String>[] : a.split('/');
  final right = b.isEmpty ? const <String>[] : b.split('/');
  final shared = left.length < right.length ? left.length : right.length;
  for (var i = 0; i < shared; i += 1) {
    final cmp = _compareNames(left[i], right[i]);
    if (cmp != 0) return cmp;
  }
  // One path is the other's ancestor: the deeper one (a subfolder) is
  // listed before the ancestor's own files.
  return right.length.compareTo(left.length);
}

/// Case-insensitive first, then case-sensitive as a stable tie-break.
int _compareNames(String a, String b) {
  final folded = a.toLowerCase().compareTo(b.toLowerCase());
  return folded != 0 ? folded : a.compareTo(b);
}

ChangedFilesSummary summarizeChangedFiles(List<RemoteChangedFile> files) {
  var insertions = 0;
  var deletions = 0;
  for (final file in files) {
    insertions += file.insertions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return ChangedFilesSummary(
    fileCount: files.length,
    insertions: insertions,
    deletions: deletions,
  );
}
