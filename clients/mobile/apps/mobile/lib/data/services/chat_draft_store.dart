/// File persistence for [ChatDraftStore] (CAN-3556).
///
/// One versioned JSON file per account, written to a temp file and renamed so
/// a crash mid-write never leaves a torn file. Pure Dart: the directory is
/// injected (main.dart resolves it with path_provider) so the Remote Control
/// engine boundary stays free of Flutter and platform plugins.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:mobile/data/models/chat_drafts.dart';

typedef ChatDraftTimerFactory =
    Timer Function(Duration duration, void Function() callback);

/// The file name for [accountScope] (`<env>:<userId>`). Hashed so the user id
/// never appears in a path.
String chatDraftFileName(String accountScope) =>
    '${sha256.convert(utf8.encode(accountScope))}.json';

final class FileChatDraftStore extends ChatDraftStateStore {
  FileChatDraftStore._({
    required this._file,
    required super.state,
    required super.now,
    required this._debounce,
    required this._timer,
  });

  final File _file;
  final Duration _debounce;
  final ChatDraftTimerFactory _timer;
  Timer? _pending;
  bool _dirty = false;
  Future<void> _writes = Future.value();
  Object? _lastWriteError;

  Object? get lastWriteError => _lastWriteError;

  static Future<FileChatDraftStore> open({
    required Directory directory,
    required String accountScope,
    DateTime Function()? now,
    Duration debounce = const Duration(milliseconds: 500),
    ChatDraftTimerFactory? timer,
  }) async {
    final clock = now ?? DateTime.now;
    final file = File(
      '${directory.path}${Platform.pathSeparator}chat-drafts'
      '${Platform.pathSeparator}${chatDraftFileName(accountScope)}',
    );
    final state = await _read(file) ?? ChatDraftState();
    state.prune(clock());
    return FileChatDraftStore._(
      file: file,
      state: state,
      now: clock,
      debounce: debounce,
      timer: timer ?? Timer.new,
    );
  }

  /// Null when there is no file or it is set aside as corrupt. A file that
  /// exists but cannot be read throws, so the caller falls back to a store
  /// that never overwrites it.
  static Future<ChatDraftState?> _read(File file) async {
    switch (await FileSystemEntity.type(file.path, followLinks: true)) {
      case FileSystemEntityType.notFound:
        return null;
      case FileSystemEntityType.file:
        break;
      default:
        throw FileSystemException('Not a file', file.path);
    }
    final bytes = await file.readAsBytes();
    try {
      final state = ChatDraftState.fromJson(jsonDecode(utf8.decode(bytes)));
      if (state != null) return state;
    } on FormatException {
      // Falls through to set the file aside.
    }
    try {
      await file.rename('${file.path}.corrupt');
    } on FileSystemException {
      // Best effort; the next write replaces it.
    }
    return null;
  }

  @override
  void onDraftsChanged() {
    _dirty = true;
    _pending?.cancel();
    _pending = _timer(_debounce, () {
      _pending = null;
      unawaited(_writeIfDirty());
    });
  }

  @override
  void onUnsentChanged() {
    _dirty = true;
    _pending?.cancel();
    _pending = null;
    unawaited(_writeIfDirty());
  }

  @override
  Future<bool> flush() {
    _pending?.cancel();
    _pending = null;
    return _writeIfDirty().then((_) => _lastWriteError == null);
  }

  Future<void> _writeIfDirty() {
    _writes = _writes.then((_) async {
      if (!_dirty) return;
      _dirty = false;
      try {
        state.prune(now());
        final encoded = jsonEncode(state.toJson());
        await _file.parent.create(recursive: true);
        final temp = File('${_file.path}.tmp');
        await temp.writeAsString(encoded, flush: true);
        await temp.rename(_file.path);
        _lastWriteError = null;
      } catch (error) {
        // Keep the in-memory state and retry on the next change or flush.
        _lastWriteError = error;
        _dirty = true;
      }
    });
    return _writes;
  }
}
