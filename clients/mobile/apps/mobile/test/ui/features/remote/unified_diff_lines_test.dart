import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/view_models/unified_diff_lines.dart';

const _patch = '''
diff --git a/lib/a.dart b/lib/a.dart
index 1111111..2222222 100644
--- a/lib/a.dart
+++ b/lib/a.dart
@@ -1,3 +1,3 @@
 void main() {
-  print('old');
+  print('new');
 }
\\ No newline at end of file
''';

void main() {
  group('classifyUnifiedDiffLines', () {
    test('classifies headers, hunks, adds, deletes, and context', () {
      final lines = classifyUnifiedDiffLines(_patch);
      expect(lines.map((line) => line.kind).toList(), [
        UnifiedDiffLineKind.meta, // diff --git
        UnifiedDiffLineKind.meta, // index
        UnifiedDiffLineKind.meta, // ---
        UnifiedDiffLineKind.meta, // +++
        UnifiedDiffLineKind.hunk,
        UnifiedDiffLineKind.context,
        UnifiedDiffLineKind.del,
        UnifiedDiffLineKind.add,
        UnifiedDiffLineKind.context,
        UnifiedDiffLineKind.meta, // \\ No newline
      ]);
      expect(lines[6].text, "-  print('old');");
      expect(lines[7].text, "+  print('new');");
    });

    test('does not treat body lines that look like headers as meta', () {
      const patch = '@@ -1,2 +1,2 @@\n --- divider\n+++ banner\n';
      final kinds = classifyUnifiedDiffLines(
        patch,
      ).map((line) => line.kind).toList();
      expect(kinds, [
        UnifiedDiffLineKind.hunk,
        UnifiedDiffLineKind.context,
        UnifiedDiffLineKind.add,
      ]);
    });

    test('a new diff header ends the current hunk body', () {
      const patch =
          '@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\nnew file mode 100644\n';
      final kinds = classifyUnifiedDiffLines(
        patch,
      ).map((line) => line.kind).toList();
      expect(kinds, [
        UnifiedDiffLineKind.hunk,
        UnifiedDiffLineKind.del,
        UnifiedDiffLineKind.add,
        UnifiedDiffLineKind.meta,
        UnifiedDiffLineKind.meta,
      ]);
    });

    test('stripUnifiedDiffFileHeaders drops per-file headers but keeps '
        'binary notices and in-hunk meta', () {
      final lines = stripUnifiedDiffFileHeaders(
        classifyUnifiedDiffLines(
          '$_patch'
          'diff --git a/img.png b/img.png\n'
          'new file mode 100644\n'
          'Binary files /dev/null and b/img.png differ\n',
        ),
      );
      expect(lines.map((line) => line.text).toList(), [
        '@@ -1,3 +1,3 @@',
        ' void main() {',
        "-  print('old');",
        "+  print('new');",
        ' }',
        r'\ No newline at end of file',
        'new file mode 100644',
        'Binary files /dev/null and b/img.png differ',
      ]);
    });

    test('keeps semantic metadata for rename-only and mode-only patches', () {
      final renameLines = stripUnifiedDiffFileHeaders(
        classifyUnifiedDiffLines(
          'diff --git a/old.dart b/new.dart\n'
          'similarity index 100%\n'
          'rename from old.dart\n'
          'rename to new.dart\n',
        ),
      );
      expect(renameLines.map((line) => line.text).toList(), [
        'similarity index 100%',
        'rename from old.dart',
        'rename to new.dart',
      ]);

      final modeLines = stripUnifiedDiffFileHeaders(
        classifyUnifiedDiffLines(
          'diff --git a/script.sh b/script.sh\n'
          'old mode 100644\n'
          'new mode 100755\n',
        ),
      );
      expect(modeLines.map((line) => line.text).toList(), [
        'old mode 100644',
        'new mode 100755',
      ]);
    });

    test('keeps metadata for empty added and deleted files', () {
      final addedLines = stripUnifiedDiffFileHeaders(
        classifyUnifiedDiffLines(
          'diff --git a/empty.txt b/empty.txt\n'
          'new file mode 100644\n'
          'index 0000000..e69de29\n',
        ),
      );
      expect(addedLines.map((line) => line.text).toList(), [
        'new file mode 100644',
      ]);

      final deletedLines = stripUnifiedDiffFileHeaders(
        classifyUnifiedDiffLines(
          'diff --git a/empty.txt b/empty.txt\n'
          'deleted file mode 100644\n'
          'index e69de29..0000000\n',
        ),
      );
      expect(deletedLines.map((line) => line.text).toList(), [
        'deleted file mode 100644',
      ]);
    });

    test('drops the single trailing empty line a patch ends with', () {
      expect(classifyUnifiedDiffLines('@@ -1 +1 @@\n+a\n'), hasLength(2));
      expect(classifyUnifiedDiffLines(''), isEmpty);
    });

    test('stops classifying once the requested line limit is exceeded', () {
      final patch = List.generate(10000, (index) => '+line $index').join('\n');

      final result = classifyUnifiedDiffLinesBounded(patch, maxLines: 10);

      expect(result.lines, hasLength(10));
      expect(result.lines.last.text, '+line 9');
      expect(result.isTruncated, isTrue);
    });
  });
}
