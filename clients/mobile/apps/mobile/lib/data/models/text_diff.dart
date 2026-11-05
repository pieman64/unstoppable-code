import 'dart:math';
import 'dart:typed_data';

/// Produces display hunks from the desktop's before/after text. Work and memory
/// are bounded; unusually large edit regions are left for the desktop viewer.
String displayTextDiff(String before, String after, {int context = 4}) {
  List<(String, bool)> lines(String text) {
    if (text.isEmpty) return [];
    final result = text.split('\n');
    if (result.last.isEmpty) result.removeLast();
    return [
      for (var i = 0; i < result.length; i++)
        (result[i], i == result.length - 1 && !text.endsWith('\n')),
    ];
  }

  final a = lines(before), b = lines(after);
  var prefix = 0, suffix = 0;
  while (prefix < min(a.length, b.length) && a[prefix] == b[prefix]) {
    prefix++;
  }
  while (suffix < min(a.length, b.length) - prefix &&
      a[a.length - suffix - 1] == b[b.length - suffix - 1]) {
    suffix++;
  }
  final n = a.length - prefix - suffix, m = b.length - prefix - suffix;
  if (n == 0 && m == 0) return '';
  if ((n + 1) * (m + 1) > 1000000) {
    throw const FormatException(
      'This diff is too large to compare on this device. Open it on your computer.',
    );
  }
  final table = Uint32List((n + 1) * (m + 1));
  int at(int i, int j) => table[i * (m + 1) + j];
  for (var i = n - 1; i >= 0; i--) {
    for (var j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[prefix + i] == b[prefix + j]
          ? at(i + 1, j + 1) + 1
          : max(at(i + 1, j), at(i, j + 1));
    }
  }
  final edits = <(String, (String, bool))>[
    for (final line in a.take(prefix)) (' ', line),
  ];
  var i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] == b[prefix + j]) {
      edits.add((' ', a[prefix + i]));
      i++;
      j++;
    } else if (i < n && (j == m || at(i + 1, j) >= at(i, j + 1))) {
      edits.add(('-', a[prefix + i++]));
    } else {
      edits.add(('+', b[prefix + j++]));
    }
  }
  edits.addAll([for (final line in a.skip(a.length - suffix)) (' ', line)]);
  final changed = [
    for (var k = 0; k < edits.length; k++)
      if (edits[k].$1 != ' ') k,
  ];
  final ranges = <(int, int)>[];
  for (final k in changed) {
    final start = max(0, k - context), end = min(edits.length, k + context + 1);
    if (ranges.isNotEmpty && start <= ranges.last.$2) {
      ranges[ranges.length - 1] = (ranges.last.$1, end);
    } else {
      ranges.add((start, end));
    }
  }
  final patch = StringBuffer();
  for (final (start, end) in ranges) {
    final oldStart = edits.take(start).where((e) => e.$1 != '+').length;
    final newStart = edits.take(start).where((e) => e.$1 != '-').length;
    final chunk = edits.sublist(start, end);
    final oldCount = chunk.where((e) => e.$1 != '+').length;
    final newCount = chunk.where((e) => e.$1 != '-').length;
    patch.writeln(
      '@@ -${oldStart + (oldCount > 0 ? 1 : 0)},$oldCount +${newStart + (newCount > 0 ? 1 : 0)},$newCount @@',
    );
    for (final (kind, text) in chunk) {
      patch.writeln('$kind${text.$1}');
      if (text.$2) patch.writeln(r'\ No newline at end of file');
    }
  }
  return patch.toString();
}
