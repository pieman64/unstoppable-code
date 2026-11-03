import 'dart:typed_data';

import 'package:mobile/data/models/remote_control_exception.dart';

/// Root-scoped PortalFileReadPayload. The desktop remains responsible for
/// containment, including symlinks and gitignored files.
final class RemoteFileRequest {
  const RemoteFileRequest({
    required this.projectId,
    required this.worktreeId,
    required this.relativePath,
    this.repoId,
    this.fileRootLocalId,
  }) : assert(repoId != null || fileRootLocalId != null);

  final String projectId;
  final String worktreeId;
  final String relativePath;
  final String? repoId;
  final String? fileRootLocalId;

  Map<String, Object> toJson() {
    if (repoId == null && fileRootLocalId == null) {
      throw ArgumentError('A file root is required.');
    }
    return {
      'projectId': projectId,
      'worktreeId': worktreeId,
      'relativePath': relativePath,
      'repoId': ?repoId,
      'fileRootLocalId': ?fileRootLocalId,
    };
  }
}

final class RemoteFileContents {
  const RemoteFileContents({
    required this.contents,
    required this.truncated,
    required this.unsupported,
  });

  final String contents;
  final bool truncated;
  final bool unsupported;
}

final class RemoteFileLink {
  const RemoteFileLink({
    required this.fileRootLocalId,
    required this.relativePath,
  });

  final String fileRootLocalId;
  final String relativePath;
}

final class RemoteFileAsset {
  const RemoteFileAsset({
    required this.bytes,
    required this.filename,
    required this.mediaType,
    required this.version,
  });

  final Uint8List bytes;
  final String filename;
  final String mediaType;
  final String version;
}

enum RemoteFileFailure {
  unsupportedDesktop,
  permissionDenied,
  outsideRoot,
  notFound,
  binaryFile,
  timeout,
  tooLarge,
  changed,
  integrity,
  invalidResponse,
  unavailable,
}

final class RemoteFileException extends RemoteControlException {
  const RemoteFileException(this.failure, super.message);

  final RemoteFileFailure failure;
}
