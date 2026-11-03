/// Classification of one line of a unified-diff patch.
///
/// Mirrors the dependency-free classifier in
/// `packages/ui-app/src/code/file/UnifiedDiffView.tsx` so mobile colors a
/// patch exactly as the web portal does.
enum UnifiedDiffLineKind { add, del, hunk, meta, context }

/// One classified patch line. [text] keeps its leading `+`/`-`/space marker.
class UnifiedDiffLine {
  const UnifiedDiffLine(this.kind, this.text);

  final UnifiedDiffLineKind kind;
  final String text;
}

/// A bounded classification result. [isTruncated] is true when [lines] omits
/// at least one patch line after the requested limit.
class UnifiedDiffClassification {
  const UnifiedDiffClassification({
    required this.lines,
    required this.isTruncated,
  });

  final List<UnifiedDiffLine> lines;
  final bool isTruncated;
}

// Prefixes that mark a file-section header OUTSIDE a hunk body. Inside a
// hunk a line is classified by its marker instead, so body content that
// merely looks like a header (` --- divider`, `+++ banner`) is not meta.
const List<String> _metaPrefixes = [
  'diff ',
  'index ',
  '--- ',
  '+++ ',
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'rename ',
  'copy ',
  'similarity ',
  'dissimilarity ',
  'Binary ',
];

const List<String> _semanticMetaPrefixes = [
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'rename ',
  'copy ',
  'similarity ',
  'dissimilarity ',
  'Binary ',
];

/// Removes redundant per-file headers (`diff --git`, `index`, `---`, `+++`)
/// that only restate what the screen header already shows. Keeps semantic
/// rename/copy/mode metadata, `Binary files … differ` (the sole content of a
/// binary diff), and in-hunk meta such as `\ No newline at end of file`.
List<UnifiedDiffLine> stripUnifiedDiffFileHeaders(List<UnifiedDiffLine> lines) {
  return [
    for (final line in lines)
      if (line.kind != UnifiedDiffLineKind.meta ||
          _semanticMetaPrefixes.any(line.text.startsWith) ||
          line.text.startsWith(r'\ No newline'))
        line,
  ];
}

UnifiedDiffLine _classifyUnifiedDiffLine(String text, bool inHunk) {
  if (text.startsWith('@@')) {
    return UnifiedDiffLine(UnifiedDiffLineKind.hunk, text);
  }
  if (text.startsWith(r'\ No newline')) {
    return UnifiedDiffLine(UnifiedDiffLineKind.meta, text);
  }
  if (text.startsWith('diff ') || text.startsWith('index ')) {
    return UnifiedDiffLine(UnifiedDiffLineKind.meta, text);
  }
  if (inHunk) {
    return UnifiedDiffLine(
      text.startsWith('+')
          ? UnifiedDiffLineKind.add
          : text.startsWith('-')
          ? UnifiedDiffLineKind.del
          : UnifiedDiffLineKind.context,
      text,
    );
  }
  return UnifiedDiffLine(
    _metaPrefixes.any(text.startsWith)
        ? UnifiedDiffLineKind.meta
        : UnifiedDiffLineKind.context,
    text,
  );
}

UnifiedDiffClassification _classifyUnifiedDiffLines(
  String patch, {
  int? maxLines,
}) {
  if (patch.isEmpty) {
    return const UnifiedDiffClassification(lines: [], isTruncated: false);
  }
  var inHunk = false;
  final lines = <UnifiedDiffLine>[];
  var offset = 0;
  while (offset < patch.length) {
    if (maxLines != null && lines.length >= maxLines) {
      return UnifiedDiffClassification(lines: lines, isTruncated: true);
    }
    final newline = patch.indexOf('\n', offset);
    final text = newline == -1
        ? patch.substring(offset)
        : patch.substring(offset, newline);
    final line = _classifyUnifiedDiffLine(text, inHunk);
    lines.add(line);
    if (line.kind == UnifiedDiffLineKind.hunk) {
      inHunk = true;
    } else if (text.startsWith('diff ') || text.startsWith('index ')) {
      inHunk = false;
    }
    if (newline == -1) break;
    offset = newline + 1;
  }
  return UnifiedDiffClassification(lines: lines, isTruncated: false);
}

/// Classifies every line of [patch] in one pass that tracks whether the
/// cursor is inside a hunk body. A new `diff `/`index ` header ends the
/// current body; `\ No newline …` is always meta. The single empty line a
/// patch ends with after its trailing newline is dropped.
List<UnifiedDiffLine> classifyUnifiedDiffLines(String patch) {
  return _classifyUnifiedDiffLines(patch).lines;
}

/// Classifies at most [maxLines] without splitting or allocating the rest of
/// the patch. The caller can surface [UnifiedDiffClassification.isTruncated]
/// while keeping work on the UI isolate bounded.
UnifiedDiffClassification classifyUnifiedDiffLinesBounded(
  String patch, {
  required int maxLines,
}) {
  assert(maxLines >= 0, 'maxLines must not be negative');
  return _classifyUnifiedDiffLines(patch, maxLines: maxLines);
}
