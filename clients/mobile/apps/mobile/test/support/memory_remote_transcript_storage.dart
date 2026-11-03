/// An in-memory [RemoteTranscriptStorage] that records every operation, so
/// suites can assert what the cache persisted without touching disk.
library;

import 'dart:async';

import 'package:mobile/data/services/remote_transcript_storage.dart';

final class MemoryRemoteTranscriptStorage implements RemoteTranscriptStorage {
  /// Stored copies per owner, like files on disk.
  final Map<
    RemoteTranscriptOwner,
    Map<RemoteTranscriptChat, PersistedTranscript>
  >
  files = {};

  /// Every operation in issue order, e.g. `write chat-1`.
  final List<String> log = [];

  /// When set, [load] waits for it before answering. It still reads the
  /// files as they were when it was issued, like the file storage, which
  /// runs operations in issue order.
  Completer<void>? loadGate;
  Object? loadError;

  @override
  Future<List<PersistedTranscript>> load(RemoteTranscriptOwner owner) async {
    log.add('load ${owner.sessionId}');
    final stored = [...?files[owner]?.values];
    if (loadGate case final gate?) await gate.future;
    if (loadError case final error?) throw error;
    files.removeWhere((other, _) => other != owner);
    return stored;
  }

  @override
  void write(RemoteTranscriptOwner owner, PersistedTranscript transcript) {
    log.add('write ${transcript.chat.chatId}');
    (files[owner] ??= {})[transcript.chat] = transcript;
  }

  @override
  void delete(RemoteTranscriptOwner owner, RemoteTranscriptChat chat) {
    log.add('delete ${chat.chatId}');
    files[owner]?.remove(chat);
  }

  @override
  Future<void> clear() async {
    log.add('clear');
    files.clear();
  }

  @override
  Future<void> flush() async {}

  /// The stored rows of [chatId] for [owner], by message id.
  List<String>? storedIds(RemoteTranscriptOwner owner, String chatId) => [
    for (final transcript in files[owner]?.values ?? <PersistedTranscript>[])
      if (transcript.chat.chatId == chatId)
        for (final row in transcript.rows) row.messageId,
  ].nullIfEmpty;
}

extension on List<String> {
  List<String>? get nullIfEmpty => isEmpty ? null : this;
}
