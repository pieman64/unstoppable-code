import 'dart:typed_data';

/// Why a file, or a file it links to, cannot be shown. Each maps to one safe
/// message, so transport errors never reach the screen.
enum FileViewerProblem {
  invalidPath,
  notFound,
  unsupported,
  permissionDenied,
  offline,
  timedOut,
  unavailable,
  sessionEnded,

  /// The computer's app is too old to serve this read.
  outdatedHost,
}

final class FileViewerException implements Exception {
  const FileViewerException(this.problem);

  final FileViewerProblem problem;

  @override
  String toString() => 'FileViewerException(${problem.name})';
}

final class FileViewerText {
  const FileViewerText({required this.contents, required this.truncated});

  final String contents;
  final bool truncated;
}

/// Reads files under one root on a connected computer. Paths are already
/// normalized and root-relative (see `normalizeFileViewerPath`); the computer
/// still owns containment. Failures throw [FileViewerException].
abstract interface class FileViewerSource {
  /// The file as text. A file that cannot be shown as text throws
  /// [FileViewerProblem.unsupported].
  Future<FileViewerText> readText(String path);

  /// The file's raw bytes, for images and the assets a page links to.
  Future<Uint8List> readBytes(String path);
}
