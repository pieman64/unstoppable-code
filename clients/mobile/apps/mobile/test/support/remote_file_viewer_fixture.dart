import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_control_exception.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/services/portal_file_client.dart'
    show remoteImageMaxBytes;
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_file_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

/// A synthetic report with images in table cells, a top-level image, and
/// sources the viewer must never read (CAN-5130).
const remoteFileFixtureReport = '''# Mobile capture report

Synthetic fixture for the worktree file viewer.

| State | Before | After |
| --- | --- | --- |
| Light | ![Before light](./before-light.png) | ![After light](./after-light.png) |
| Dark | ![Before dark](./before-dark.png) | ![After dark](images/after-dark.png) |

![Overview](../overview.png)

Remote and unsafe images stay inert:

![Remote](https://example.com/remote.png) ![Escape](../../../secret.png)

## Notes

- Each row compares one theme.
- Tap an image to zoom.
''';

const remoteFileFixturePath = 'reports/can-5130/report.md';

const remoteFileFixtureRequest = RemoteFileRequest(
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  fileRootLocalId: 'root-1',
  relativePath: remoteFileFixturePath,
);

/// Image paths the fixture report may read, relative to the root.
const remoteFileFixtureImagePaths = [
  'reports/can-5130/before-light.png',
  'reports/can-5130/after-light.png',
  'reports/can-5130/before-dark.png',
  'reports/can-5130/images/after-dark.png',
  'reports/overview.png',
];

/// Test-only entry point: one button that pushes the production viewer for
/// [request]. Real entry points belong to the screens that list files.
Widget remoteFileViewerHost(
  RemoteControlViewModel viewModel, {
  required ThemeData theme,
  RemoteFileRequest request = remoteFileFixtureRequest,
  int imageCacheBytes = remoteImageMaxBytes,
}) => ChangeNotifierProvider<RemoteControlViewModel>.value(
  value: viewModel,
  child: MaterialApp(
    theme: theme,
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: TextButton(
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => RemoteFileScreen(
                  request: request,
                  imageCacheBytes: imageCacheBytes,
                ),
              ),
            ),
            child: const Text('Open file'),
          ),
        ),
      ),
    ),
  ),
);

/// Encodes a solid [width]x[height] PNG. Widget tests call it inside
/// `tester.runAsync`.
Future<Uint8List> remoteFileFixturePng(
  ui.Color color, {
  int width = 240,
  int height = 160,
}) async {
  final recorder = ui.PictureRecorder();
  ui.Canvas(recorder).drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = color,
  );
  final image = await recorder.endRecording().toImage(width, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  return data!.buffer.asUint8List();
}

/// Records every file and asset read. Reads answer from the maps unless
/// [holdFiles] or [holdAssets] is set; held reads wait for a release or
/// failure call for their path.
final class RemoteFileViewerRepository extends FakeRemoteControlRepository {
  final files = <String, RemoteFileContents>{};
  final assets = <String, Uint8List>{};

  /// Thrown by every read of that path instead of answering.
  final fileErrors = <String, Object>{};
  final assetErrors = <String, Object>{};

  final fileReads = <RemoteFileRequest>[];
  final assetReads = <RemoteFileRequest>[];

  bool holdFiles = false;
  bool holdAssets = false;

  /// Held reads per path, oldest first.
  final heldFiles = <String, List<Completer<RemoteFileContents>>>{};
  final heldAssets = <String, List<Completer<RemoteFileAsset>>>{};

  void releaseAsset(String path, Uint8List bytes) {
    for (final read in heldAssets.remove(path) ?? const []) {
      read.complete(_asset(path, bytes));
    }
  }

  void failAsset(String path, Object error) {
    for (final read in heldAssets.remove(path) ?? const []) {
      read.completeError(error);
    }
  }

  @override
  Future<RemoteFileContents> readFile(RemoteFileRequest request) async {
    fileReads.add(request);
    final path = request.relativePath;
    if (holdFiles) {
      final read = Completer<RemoteFileContents>();
      (heldFiles[path] ??= []).add(read);
      return read.future;
    }
    if (fileErrors[path] case final error?) throw error;
    return files[path] ??
        (throw const RemoteFileException(
          RemoteFileFailure.notFound,
          'The file is no longer available.',
        ));
  }

  @override
  Future<RemoteFileAsset> readAsset(RemoteFileRequest request) async {
    assetReads.add(request);
    final path = request.relativePath;
    if (holdAssets) {
      final read = Completer<RemoteFileAsset>();
      (heldAssets[path] ??= []).add(read);
      return read.future;
    }
    if (assetErrors[path] case final error?) throw error;
    final bytes = assets[path];
    if (bytes == null) {
      throw const RemoteFileException(
        RemoteFileFailure.notFound,
        'The file is no longer available.',
      );
    }
    return _asset(path, bytes);
  }

  RemoteFileAsset _asset(String path, Uint8List bytes) => RemoteFileAsset(
    bytes: bytes,
    filename: path.split('/').last,
    mediaType: 'image/png',
    version: 'v1',
  );
}

/// The typed result `readAsset` returns for a desktop without
/// `chat_assets_v1`.
const remoteFileUnsupportedDesktop = RemoteFileException(
  RemoteFileFailure.unsupportedDesktop,
  'Update the connected desktop to read images.',
);

/// What the repository throws before any read when no session is paired.
const remoteFileNotConnected = RemoteControlException(
  'Not connected to a desktop.',
);
