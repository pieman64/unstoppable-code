import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/remote_file.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/services/portal_file_client.dart'
    show remoteImageMaxBytes;
import 'package:mobile/ui/core/widgets/message_markdown_image.dart';
import 'package:mobile/ui/features/remote/view_models/remote_file_image_path.dart';

const _markdownExtensions = {'md', 'markdown', 'mdx'};

enum RemoteFileMode { formatted, source }

/// Why the file body cannot show text. Each maps to one safe message.
enum RemoteFileProblem {
  invalidPath,
  notFound,
  unsupported,
  permissionDenied,
  offline,
  timedOut,
  unavailable,
  sessionEnded,
}

/// Reads one root-scoped worktree file and the images its Markdown links
/// to (CAN-5130). Images are kept in memory only, under an encoded-byte
/// budget, and only for this screen's session: [endSession] and [dispose]
/// drop them and make every pending read answer with a failure.
class RemoteFileViewModel extends ChangeNotifier {
  RemoteFileViewModel({
    required this.repository,
    required this.request,
    required this._desktopOnline,
    this.imageCacheBytes = remoteImageMaxBytes,
  }) : _path = normalizeRemoteFilePath(request.relativePath);

  final RemoteControlRepository repository;
  final RemoteFileRequest request;

  /// Upper bound on retained encoded image bytes. Defaults to the largest
  /// image one read may return.
  final int imageCacheBytes;

  /// Null when the requested path is unsafe; nothing is read then.
  final String? _path;

  bool _desktopOnline;
  RemoteFileMode _mode = RemoteFileMode.formatted;
  bool _loading = false;
  RemoteFileContents? _contents;
  RemoteFileProblem? _problem;
  bool _imagesUnavailable = false;
  int _loadSeq = 0;

  /// Bumped by [endSession] and [dispose]; reads from an older epoch are
  /// discarded.
  int _epoch = 0;
  bool _ended = false;
  bool _disposed = false;

  /// Least recently used first.
  final _images = <String, Uint8List>{};
  int _retainedBytes = 0;
  final _pendingImages = <String, Future<Uint8List>>{};

  List<String> get _segments => request.relativePath
      .split('/')
      .where((segment) => segment.isNotEmpty && segment != '.')
      .toList();

  String get fileName => _segments.lastOrNull ?? request.relativePath;

  /// Folder names from the root to the file, for the breadcrumb.
  List<String> get folders {
    final segments = _segments;
    return segments.isEmpty
        ? const []
        : segments.sublist(0, segments.length - 1);
  }

  bool get isMarkdown {
    final name = fileName;
    final dot = name.lastIndexOf('.');
    return dot > 0 &&
        _markdownExtensions.contains(name.substring(dot + 1).toLowerCase());
  }

  /// Markdown opens formatted; other text is always source.
  RemoteFileMode get mode => isMarkdown ? _mode : RemoteFileMode.source;
  bool get loading => _loading;
  RemoteFileContents? get contents => _contents;
  RemoteFileProblem? get problem => _problem;

  /// The desktop cannot serve images; Markdown shows alt text instead.
  bool get imagesUnavailable => _imagesUnavailable;

  @visibleForTesting
  int get retainedImageBytes => _retainedBytes;

  void showMode(RemoteFileMode mode) {
    if (!isMarkdown || mode == _mode) return;
    _mode = mode;
    notifyListeners();
  }

  /// Reading again when the desktop returns replaces the offline notice.
  void setDesktopOnline(bool online) {
    final returned = online && !_desktopOnline;
    _desktopOnline = online;
    if (returned && _problem == RemoteFileProblem.offline) unawaited(load());
  }

  /// Loads the file, or reloads it after a failure.
  Future<void> load() async {
    if (_ended || _disposed) return;
    final seq = ++_loadSeq;
    final epoch = _epoch;
    final path = _path;
    if (path == null || !_desktopOnline) {
      _settle(
        problem: path == null
            ? RemoteFileProblem.invalidPath
            : RemoteFileProblem.offline,
      );
      return;
    }
    // A failure stays visible while it is retried, so nothing blanks.
    _loading = true;
    notifyListeners();
    RemoteFileContents? contents;
    RemoteFileProblem? problem;
    try {
      contents = await repository.readFile(_requestFor(path));
      if (contents.unsupported) {
        contents = null;
        problem = RemoteFileProblem.unsupported;
      }
    } on RemoteFileException catch (error) {
      problem = _fileProblem(error.failure);
    } on RemoteControlException {
      // Only the missing-session check throws the base type.
      problem = RemoteFileProblem.offline;
    } catch (_) {
      problem = RemoteFileProblem.unavailable;
    }
    if (_disposed || epoch != _epoch || seq != _loadSeq) return;
    _settle(contents: contents, problem: problem);
  }

  void _settle({RemoteFileContents? contents, RemoteFileProblem? problem}) {
    _loading = false;
    _contents = contents;
    _problem = problem;
    notifyListeners();
  }

  /// The paired session changed; nothing read under it may stay visible.
  void endSession() {
    if (_ended || _disposed) return;
    _ended = true;
    _discardSession();
    _settle(problem: RemoteFileProblem.sessionEnded);
  }

  @override
  void dispose() {
    _disposed = true;
    _discardSession();
    super.dispose();
  }

  void _discardSession() {
    _epoch++;
    _images.clear();
    _retainedBytes = 0;
    _pendingImages.clear();
  }

  /// [MessageImageResolver] for the formatted Markdown. Rejected sources,
  /// remote URLs and failures throw a [MessageImageFailure] without I/O.
  Future<Uint8List> readImage(String source) {
    if (_ended || _disposed) {
      return Future.error(MessageImageFailure.unavailable);
    }
    final document = _path;
    final path = document == null
        ? null
        : resolveRemoteFileImagePath(documentPath: document, source: source);
    if (path == null || _imagesUnavailable) {
      return Future.error(MessageImageFailure.unsupported);
    }
    final cached = _images.remove(path);
    if (cached != null) {
      _images[path] = cached;
      return Future.value(cached);
    }
    if (_pendingImages[path] case final pending?) return pending;
    final read = _readImage(path, _epoch);
    _pendingImages[path] = read;
    read.whenComplete(() {
      if (identical(_pendingImages[path], read)) {
        _pendingImages.remove(path);
      }
    }).ignore();
    return read;
  }

  Future<Uint8List> _readImage(String path, int epoch) async {
    final Uint8List bytes;
    try {
      bytes = (await repository.readAsset(_requestFor(path))).bytes;
    } on RemoteFileException catch (error) {
      if (epoch != _epoch) throw MessageImageFailure.unavailable;
      if (error.failure == RemoteFileFailure.unsupportedDesktop) {
        if (!_imagesUnavailable) {
          _imagesUnavailable = true;
          notifyListeners();
        }
        throw MessageImageFailure.unsupported;
      }
      throw _imageFailure(error.failure);
    } on RemoteControlException {
      throw MessageImageFailure.unavailable;
    }
    if (epoch != _epoch) throw MessageImageFailure.unavailable;
    _retain(path, bytes);
    return bytes;
  }

  void _retain(String path, Uint8List bytes) {
    if (bytes.length > imageCacheBytes) return;
    _images[path] = bytes;
    _retainedBytes += bytes.length;
    while (_retainedBytes > imageCacheBytes) {
      final oldest = _images.keys.first;
      _retainedBytes -= _images.remove(oldest)!.length;
    }
  }

  RemoteFileRequest _requestFor(String path) => RemoteFileRequest(
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    repoId: request.repoId,
    fileRootLocalId: request.fileRootLocalId,
    relativePath: path,
  );
}

RemoteFileProblem _fileProblem(RemoteFileFailure failure) => switch (failure) {
  RemoteFileFailure.notFound => RemoteFileProblem.notFound,
  RemoteFileFailure.outsideRoot => RemoteFileProblem.invalidPath,
  RemoteFileFailure.binaryFile ||
  RemoteFileFailure.tooLarge => RemoteFileProblem.unsupported,
  RemoteFileFailure.permissionDenied => RemoteFileProblem.permissionDenied,
  RemoteFileFailure.timeout => RemoteFileProblem.timedOut,
  RemoteFileFailure.unsupportedDesktop ||
  RemoteFileFailure.changed ||
  RemoteFileFailure.integrity ||
  RemoteFileFailure.invalidResponse ||
  RemoteFileFailure.unavailable => RemoteFileProblem.unavailable,
};

MessageImageFailure _imageFailure(RemoteFileFailure failure) =>
    switch (failure) {
      RemoteFileFailure.notFound ||
      RemoteFileFailure.outsideRoot => MessageImageFailure.notFound,
      RemoteFileFailure.binaryFile ||
      RemoteFileFailure.tooLarge ||
      RemoteFileFailure.invalidResponse => MessageImageFailure.unsupported,
      _ => MessageImageFailure.unavailable,
    };
