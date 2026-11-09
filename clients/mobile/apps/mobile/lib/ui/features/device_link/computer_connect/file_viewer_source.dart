import 'dart:convert';
import 'dart:typed_data';

import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/files/reader.dart';
import 'package:mobile/device_link/files/rooted_path.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';

/// Reads one worktree root on the connected computer for the file viewer.
final class DeviceFileViewerSource implements FileViewerSource {
  const DeviceFileViewerSource({required this.reader, required this.location});

  final DeviceFileReader reader;

  /// The opened file's root; viewer paths are relative to it.
  final DeviceRootedPath location;

  @override
  Future<FileViewerText> readText(String path) async {
    final content = await _read(path);
    final text = content.text;
    if (text == null) {
      throw const FileViewerException(FileViewerProblem.unsupported);
    }
    return FileViewerText(contents: text, truncated: content.truncated);
  }

  @override
  Future<Uint8List> readBytes(String path) async {
    final content = await _read(path);
    if (content.bytes case final bytes?) return bytes;
    // A cut-off script or stylesheet would fail in confusing ways.
    if (content.truncated) {
      throw const FileViewerException(FileViewerProblem.unsupported);
    }
    return utf8.encode(content.text!);
  }

  Future<DeviceFileContent> _read(String path) async {
    try {
      return await reader.read(location.absolute(path));
    } on DeviceFileReadException catch (error) {
      throw FileViewerException(switch (error.failure) {
        DeviceFileReadFailure.notFound => FileViewerProblem.notFound,
        DeviceFileReadFailure.unsupported => FileViewerProblem.unsupported,
        DeviceFileReadFailure.invalidResponse => FileViewerProblem.unavailable,
      });
    } on DesktopIpcRefusal catch (error) {
      // A host that does not pass the channel through answers this code.
      throw FileViewerException(
        error.code == 'remote_channel_unavailable'
            ? FileViewerProblem.outdatedHost
            : FileViewerProblem.unavailable,
      );
    } on DeviceLinkException {
      // Includes an unanswered request, which a retry can recover.
      throw const FileViewerException(FileViewerProblem.unavailable);
    }
  }
}
