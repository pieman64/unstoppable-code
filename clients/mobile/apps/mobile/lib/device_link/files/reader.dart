import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import '../desktop/ipc.dart';
import '../dto.dart';
import '../protocol.dart';
import '../worktree_ref.dart';

/// Why a read on the computer failed.
enum DeviceFileReadFailure { notFound, unsupported, invalidResponse }

final class DeviceFileReadException extends DeviceLinkException {
  const DeviceFileReadException(this.failure, super.message);

  final DeviceFileReadFailure failure;
}

/// One `file:read-content` result. [bytes] is set for images, [text] for
/// everything the computer reads as text (Markdown, HTML and source).
final class DeviceFileContent {
  const DeviceFileContent.text(String this.text, {required this.truncated})
    : bytes = null;
  const DeviceFileContent.image(Uint8List this.bytes)
    : text = null,
      truncated = false;

  final String? text;
  final Uint8List? bytes;
  final bool truncated;
}

/// Reads files inside one worktree's roots on the computer. The computer
/// resolves every path through realpath and refuses reads outside the
/// worktree's file roots, so nothing here grants access.
///
/// Reads use `file:read-content`, which caps text and images at 5 MiB; its
/// largest reply fits `desktopMaxMessageBytes`. The byte channel allows up
/// to 25 MiB and is not used: a reply over the mobile message limit would end
/// the whole session.
///
/// A rendered page can ask for many files at once, but the session holds
/// only a few requests in flight for the whole app. Reads therefore queue
/// behind [maxConcurrentReads], leaving room for chat traffic.
final class DeviceFileReader {
  DeviceFileReader(this.ipc, this.worktree);

  static const maxConcurrentReads = 2;

  final DesktopIpc ipc;
  final DeviceWorktreeRef worktree;
  final _waiting = Queue<Completer<void>>();
  int _reading = 0;
  bool _closed = false;

  /// The viewer closed: queued reads fail without being sent, and later
  /// reads fail at once. Reads already sent finish on their own.
  void close() {
    if (_closed) return;
    _closed = true;
    while (_waiting.isNotEmpty) {
      _waiting.removeFirst().completeError(_closedError);
    }
  }

  Map<String, Object> get _scope => {
    'projectId': worktree.projectId,
    'worktreeId': worktree.worktreeId,
  };

  /// Absolute paths of the worktree's file roots: its repositories,
  /// workspace folder and attachments.
  Future<List<String>> roots() async {
    final response = _object(await ipc.invoke('file-tree:roots', [_scope]));
    final roots = response['roots'];
    if (roots is! List) throw _invalid;
    return [
      for (final root in roots)
        if (root is Map && root['absolutePath'] is String)
          root['absolutePath'] as String,
    ];
  }

  Future<DeviceFileContent> read(String absolutePath) async {
    if (_closed) throw _closedError;
    if (_reading < maxConcurrentReads) {
      _reading++;
    } else {
      // A finishing read hands its slot straight to the next waiter.
      final turn = Completer<void>();
      _waiting.add(turn);
      await turn.future;
    }
    final Object? raw;
    try {
      raw = await ipc.invoke('file:read-content', [
        {'absolutePath': absolutePath, 'workspaceTarget': _scope},
      ]);
    } finally {
      if (_waiting.isNotEmpty) {
        _waiting.removeFirst().complete();
      } else {
        _reading--;
      }
    }
    final response = _object(raw);
    final content = response['content'];
    if (content is! String) throw _invalid;
    switch (response['kind']) {
      case 'missing':
        throw const DeviceFileReadException(
          DeviceFileReadFailure.notFound,
          'The file does not exist.',
        );
      case 'unsupported':
        throw const DeviceFileReadException(
          DeviceFileReadFailure.unsupported,
          'The file cannot be shown.',
        );
      case 'image':
        return DeviceFileContent.image(_dataUrlBytes(content));
      case 'text' || 'markdown' || 'html':
        return DeviceFileContent.text(
          content,
          truncated: response['truncated'] == true,
        );
      default:
        throw _invalid;
    }
  }

  Map<String, dynamic> _object(Object? value) {
    final dto = deviceChatDto(value);
    if (dto is! Map<String, dynamic>) throw _invalid;
    return dto;
  }
}

const _closedError = DesktopIpcNotSent('The file viewer closed.');

const _invalid = DeviceFileReadException(
  DeviceFileReadFailure.invalidResponse,
  'The computer sent an unreadable file.',
);

/// The computer sends images as `data:<type>;base64,<data>`.
Uint8List _dataUrlBytes(String value) {
  final comma = value.indexOf(',');
  if (!value.startsWith('data:') ||
      comma < 0 ||
      !value.substring(0, comma).endsWith(';base64')) {
    throw _invalid;
  }
  try {
    return base64.decode(value.substring(comma + 1));
  } on FormatException {
    throw _invalid;
  }
}
