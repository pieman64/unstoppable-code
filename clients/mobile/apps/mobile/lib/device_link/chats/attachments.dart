import 'dart:typed_data';

import '../desktop/ipc.dart';
import '../protocol.dart';
import 'dto.dart';
import 'models.dart';

/// A file stored in a chat scope's attachments folder on the computer.
final class DeviceChatAttachment {
  const DeviceChatAttachment({
    required this.filename,
    required this.path,
    required this.size,
  });

  /// The name the computer stored the file under, unique in its folder.
  final String filename;

  /// The computer's absolute path, which a send names in `attachmentPaths`.
  final String path;
  final int size;
}

/// Files a phone attaches, stored on the computer the way a remote desktop
/// window's dropped files are: bytes travel through the tunneled
/// workspace-items import, which picks the worktree or Cowork folder.
final class DeviceChatAttachments {
  DeviceChatAttachments(this.ipc);

  final DesktopIpc ipc;

  /// A whole file is one request; give slow links time to carry it.
  static const uploadTimeout = Duration(minutes: 5);

  Future<DeviceChatAttachment> import(
    DeviceChatRef scope,
    String filename,
    Uint8List bytes,
  ) async {
    // An import without files opens a file chooser on the computer, so a
    // request always carries exactly one file.
    final result = deviceLinkObject(
      deviceChatDto(
        await ipc.invoke('workspace-items:import-attachments', [
          {
            ...scope.scope,
            'filePaths': <String>[],
            'clipboardItems': [
              {'filename': filename, 'data': bytes},
            ],
          },
        ], uploadTimeout),
      ),
    );
    final stored = (result['attachments'] as List? ?? [])
        .whereType<Map<String, dynamic>>()
        .firstOrNull;
    final path = stored?['absolutePath'];
    final name = stored?['filename'];
    if (path is! String || name is! String) {
      throw const DeviceLinkException('Your computer did not store the file.');
    }
    final size = stored?['sizeBytes'];
    return DeviceChatAttachment(
      filename: name,
      path: path,
      size: size is num ? size.toInt() : bytes.length,
    );
  }

  Future<void> delete(DeviceChatRef scope, String filename) =>
      ipc.invoke('workspace-items:delete-attachment', [
        {...scope.scope, 'filename': filename},
      ]);
}
