/// A computer file path split into one of its worktree's roots and a
/// `/`-separated path under it, so the viewer can resolve relative links
/// without knowing the computer's path style.
final class DeviceRootedPath {
  const DeviceRootedPath({
    required this.root,
    required this.relativePath,
    required this.separator,
  });

  final String root;
  final String relativePath;

  /// `\` for Windows paths, `/` otherwise.
  final String separator;

  /// The computer path of [relative], a `/`-separated path under [root].
  String absolute(String relative) =>
      '$root$separator${relative.replaceAll('/', separator)}';
}

/// Drive-letter (`C:\`, `C:/`) and UNC (`\\server`) paths.
final _windowsPath = RegExp(r'^(?:[A-Za-z]:[\\/]|\\\\)');

/// The deepest of [roots] that contains [absolutePath], or null when none
/// does. Only the computer decides access; this only builds requests.
///
/// Windows paths compare case-insensitively and accept either separator,
/// as Windows does. The folding keeps every code unit in place, so offsets
/// into the folded path are offsets into [absolutePath].
DeviceRootedPath? locateUnderRoot(List<String> roots, String absolutePath) {
  final windows = _windowsPath.hasMatch(absolutePath);
  final separator = windows ? r'\' : '/';
  String fold(String path) => windows
      ? String.fromCharCodes([
          for (final unit in path.codeUnits)
            unit ==
                    0x5C // \
                ? 0x2F // /
                : unit >= 0x41 &&
                      unit <=
                          0x5A // A-Z
                ? unit + 0x20
                : unit,
        ])
      : path;
  final path = fold(absolutePath);
  DeviceRootedPath? best;
  for (final candidate in roots) {
    var root = candidate;
    while (root.length > 1 && fold(root).endsWith('/')) {
      root = root.substring(0, root.length - 1);
    }
    final folded = fold(root);
    final prefix = folded.endsWith('/') ? folded : '$folded/';
    if (!path.startsWith(prefix) || path.length == prefix.length) continue;
    if (best != null && best.root.length >= root.length) continue;
    best = DeviceRootedPath(
      root: absolutePath.substring(0, prefix.length - 1),
      relativePath: windows
          ? absolutePath.substring(prefix.length).replaceAll(r'\', '/')
          : absolutePath.substring(prefix.length),
      separator: separator,
    );
  }
  return best;
}
