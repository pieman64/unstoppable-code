// Client-side path rules for the worktree file viewer (CAN-5130). The
// desktop still owns containment, including symlinks and excluded roots;
// these rules only keep unsafe input from becoming a request at all.

/// `scheme:` at the start, which also covers Windows drive letters.
final RegExp _scheme = RegExp(r'^[A-Za-z][A-Za-z0-9+.-]*:');

/// Returns [path] as normalized root-relative segments joined by `/`, or
/// null when it is empty, absolute, uses a scheme or backslashes, contains
/// control characters, or leaves the root through `..`. The scheme check
/// also applies to the result, which `..` may have shortened to `C:/...`.
String? normalizeRemoteFilePath(String path) {
  if (path.startsWith('/') ||
      path.contains(r'\') ||
      _scheme.hasMatch(path) ||
      path.codeUnits.any((unit) => unit < 0x20)) {
    return null;
  }
  final segments = <String>[];
  for (final segment in path.split('/')) {
    if (segment.isEmpty || segment == '.') continue;
    if (segment == '..') {
      if (segments.isEmpty) return null;
      segments.removeLast();
    } else {
      segments.add(segment);
    }
  }
  final normalized = segments.join('/');
  return normalized.isEmpty || _scheme.hasMatch(normalized) ? null : normalized;
}

/// Resolves a Markdown image [source] against the folder of [documentPath],
/// both relative to the same file root. Returns null for remote URLs, any
/// other scheme, absolute or protocol-relative paths, malformed escapes and
/// results outside the root, so the caller never reads them.
///
/// The source is percent-decoded exactly once, as a URL reference; a
/// trailing query or fragment is ignored.
String? resolveRemoteFileImagePath({
  required String documentPath,
  required String source,
}) {
  final document = normalizeRemoteFilePath(documentPath);
  final reference = source.trim().split(RegExp('[?#]')).first;
  if (document == null || reference.isEmpty || _scheme.hasMatch(reference)) {
    return null;
  }
  final String decoded;
  try {
    decoded = Uri.decodeComponent(reference);
  } on ArgumentError {
    return null;
  } on FormatException {
    return null;
  }
  // `//host` and `/abs` are not relative. A source must also name a file,
  // not the report's folder or one of its parents.
  final name = decoded.split('/').last;
  if (decoded.startsWith('/') ||
      _scheme.hasMatch(decoded) ||
      name.isEmpty ||
      name == '.' ||
      name == '..') {
    return null;
  }
  final folder = document.contains('/')
      ? document.substring(0, document.lastIndexOf('/'))
      : '';
  return normalizeRemoteFilePath(folder.isEmpty ? decoded : '$folder/$decoded');
}
