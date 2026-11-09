import 'dart:typed_data';

import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';

/// Reads one Portal file root through the paired Remote control session.
final class RemoteFileViewerSource implements FileViewerSource {
  const RemoteFileViewerSource({
    required this.repository,
    required this.request,
  });

  final RemoteControlRepository repository;

  /// The opened file. Reads use its project, worktree and root.
  final RemoteFileRequest request;

  @override
  Future<FileViewerText> readText(String path) => _guard(() async {
    final contents = await repository.readFile(_requestFor(path));
    if (contents.unsupported) {
      throw const FileViewerException(FileViewerProblem.unsupported);
    }
    return FileViewerText(
      contents: contents.contents,
      truncated: contents.truncated,
    );
  }, text: true);

  @override
  Future<Uint8List> readBytes(String path) => _guard(
    () async => (await repository.readAsset(_requestFor(path))).bytes,
    text: false,
  );

  RemoteFileRequest _requestFor(String path) => RemoteFileRequest(
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    repoId: request.repoId,
    fileRootLocalId: request.fileRootLocalId,
    relativePath: path,
  );

  Future<T> _guard<T>(Future<T> Function() read, {required bool text}) async {
    try {
      return await read();
    } on RemoteFileException catch (error) {
      throw FileViewerException(_problem(error.failure, text: text));
    } on RemoteControlException {
      // Only the missing-session check throws the base type.
      throw const FileViewerException(FileViewerProblem.offline);
    }
  }
}

FileViewerProblem _problem(RemoteFileFailure failure, {required bool text}) =>
    switch (failure) {
      RemoteFileFailure.notFound => FileViewerProblem.notFound,
      RemoteFileFailure.outsideRoot => FileViewerProblem.invalidPath,
      RemoteFileFailure.binaryFile ||
      RemoteFileFailure.tooLarge => FileViewerProblem.unsupported,
      RemoteFileFailure.permissionDenied => FileViewerProblem.permissionDenied,
      RemoteFileFailure.timeout => FileViewerProblem.timedOut,
      // Text reads predate the asset capability, so only images need it.
      RemoteFileFailure.unsupportedDesktop =>
        text ? FileViewerProblem.unavailable : FileViewerProblem.outdatedHost,
      RemoteFileFailure.invalidResponse =>
        text ? FileViewerProblem.unavailable : FileViewerProblem.unsupported,
      RemoteFileFailure.changed ||
      RemoteFileFailure.integrity ||
      RemoteFileFailure.unavailable => FileViewerProblem.unavailable,
    };
