import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/ui/features/remote/view_models/changed_files_grouping.dart';

RemoteChangedFile _file(
  String path, {
  String status = 'modified',
  String? repoId,
  String? repoName,
  int? insertions,
  int? deletions,
}) => RemoteChangedFile(
  filePath: path,
  status: status,
  committed: false,
  repoId: repoId,
  repoName: repoName,
  insertions: insertions,
  deletions: deletions,
);

void main() {
  group('groupChangedFilesByDirectory', () {
    test('orders groups like the desktop tree: folders before files, '
        'case-insensitive at every level', () {
      final groups = groupChangedFilesByDirectory([
        _file('lib/ui/b.dart'),
        _file('lib/data/z.dart'),
        _file('lib/ui/A.dart'),
        _file('lib/ui/widgets/w.dart'),
        _file('lib/Zed/x.dart'),
        _file('lib/index.dart'),
        _file('README.md'),
      ]);
      // Desktop preorder: within `lib`, the folders data, ui (and ui's own
      // subfolder widgets before ui's files), Zed sort case-insensitively;
      // `lib`'s files come after its folders; root files come last.
      expect(groups.map((g) => g.directory).toList(), [
        'lib/data',
        'lib/ui/widgets',
        'lib/ui',
        'lib/Zed',
        'lib',
        '',
      ]);
      expect(groups[2].files.map((f) => f.fileName).toList(), [
        'A.dart',
        'b.dart',
      ]);
      expect(groups.last.files.single.fileName, 'README.md');
    });

    test('keeps same-named directories from different repos apart', () {
      final groups = groupChangedFilesByDirectory([
        _file('src/a.ts', repoId: 'web', repoName: 'web'),
        _file('src/a.ts', repoId: 'api', repoName: 'api'),
      ]);
      expect(groups.map((g) => g.repoName).toList(), ['api', 'web']);
      expect(groups.map((g) => g.directory).toList(), ['src', 'src']);
    });
  });

  group('summarizeChangedFiles', () {
    test('totals insertions and deletions across files', () {
      final summary = summarizeChangedFiles([
        _file('a', insertions: 3, deletions: 1),
        _file('b', insertions: 2),
        _file('c'),
      ]);
      expect(summary.fileCount, 3);
      expect(summary.insertions, 5);
      expect(summary.deletions, 1);
    });
  });
}
