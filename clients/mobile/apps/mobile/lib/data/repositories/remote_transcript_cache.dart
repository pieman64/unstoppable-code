/// The recent Remote Control chat tails kept on this device (CAN-3373), so a
/// chat reopened after a cold start paints its last messages at once instead
/// of waiting on the network.
///
/// Pure Dart: storage is a port, so the Remote Control engine can use the
/// cache without Flutter or platform plugins. Every row it returns is stale
/// until the server cache or the desktop's snapshot replaces it.
library;

import 'dart:async';

import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';

/// Most chats kept, by most recent open.
const int kRemoteTranscriptCacheMaxChats = 20;

/// Newest projected messages kept per chat.
const int kRemoteTranscriptCacheMaxMessages = 50;

/// How long changes collect before one write. Streaming turns change a row
/// many times a second; the final revision still lands within this delay.
const Duration kRemoteTranscriptCacheWriteDelay = Duration(milliseconds: 500);

/// Starts a one-shot timer; injected so tests control the write delay.
typedef RemoteTranscriptTimerFactory =
    Timer Function(Duration delay, void Function() callback);

/// Bounded, recency-ordered chat tails for one account's paired session.
///
/// [restoreSession] loads the session's tails into memory, so [openTail]
/// can answer synchronously while a chat screen builds. Changes to opened
/// chats are written after [writeDelay]; [clearSession] forgets and deletes
/// everything, and fences writes and reads that are still in flight.
final class RemoteTranscriptCache {
  RemoteTranscriptCache({
    required this.storage,
    required this.accountScope,
    this.maxChats = kRemoteTranscriptCacheMaxChats,
    this.maxMessages = kRemoteTranscriptCacheMaxMessages,
    this.writeDelay = kRemoteTranscriptCacheWriteDelay,
    RemoteTranscriptTimerFactory? timer,
  }) : assert(maxChats > 0 && maxMessages > 0),
       _timer = timer ?? Timer.new;

  final RemoteTranscriptStorage storage;

  /// The signed-in account, `<environment>:<userId>`.
  final String accountScope;
  final int maxChats;
  final int maxMessages;
  final Duration writeDelay;
  final RemoteTranscriptTimerFactory _timer;

  RemoteTranscriptOwner? _owner;

  /// Advanced whenever the cached session changes, so a late load cannot
  /// fill memory for a session that is gone.
  int _generation = 0;
  bool _closed = false;
  final Map<RemoteTranscriptChat, _CachedChat> _chats = {};
  int _lastOpened = 0;

  /// Chats to write when [_writeTimer] fires, each with a reader for its
  /// current rows, or null when only its recency changed.
  final Map<RemoteTranscriptChat, List<RemoteChatMessage> Function()?>
  _pending = {};
  Timer? _writeTimer;

  /// The load for the current session, while it runs.
  Future<void>? _restoring;

  /// Scopes the cache to [sessionId] and loads its stored tails. A null
  /// session means the server has none, so everything stored is deleted.
  Future<void> restoreSession(String? sessionId) {
    if (_closed) return Future.value();
    if (sessionId != null &&
        sessionId.isNotEmpty &&
        _owner?.sessionId == sessionId) {
      return _restoring ?? Future.value();
    }
    final generation = _forget();
    if (sessionId == null || sessionId.isEmpty) return storage.clear();
    final owner = (accountScope: accountScope, sessionId: sessionId);
    _owner = owner;
    final restoring = _load(owner, generation);
    _restoring = restoring;
    return restoring.whenComplete(() {
      if (identical(_restoring, restoring)) _restoring = null;
    });
  }

  Future<void> _load(RemoteTranscriptOwner owner, int generation) async {
    List<PersistedTranscript> stored;
    try {
      stored = await storage.load(owner);
    } catch (_) {
      stored = const [];
    }
    if (generation != _generation) return;
    final openedDuringLoad = _chats.entries.toList()
      ..sort((a, b) => a.value.openedAt.compareTo(b.value.openedAt));
    var newest = 0;
    for (final transcript in stored) {
      if (transcript.rows.isEmpty) continue;
      final rows = _newestTail(transcript.rows);
      final opened = _chats[transcript.chat];
      if (opened == null) {
        _chats[transcript.chat] = _CachedChat(
          rows,
          transcript.openedAt,
          storedAt: transcript.openedAt,
          kept: rows,
        );
      } else {
        // Opened before its tail was in memory: its live rows may be a
        // partial view, like those of a chat opened afterwards. Nothing was
        // written meanwhile; authoritative data that arrived still replaces
        // the stored rows once written.
        opened.kept = rows;
      }
      if (transcript.openedAt > newest) newest = transcript.openedAt;
    }
    // Chats opened while the load ran are newer than every stored one.
    for (final MapEntry(key: chat, value: cached) in openedDuringLoad) {
      cached.openedAt = ++newest;
      if (cached.rows.isNotEmpty || cached.kept.isNotEmpty) {
        _schedule(
          chat,
          _pending[chat] ?? () => _withKeptRows(cached.kept, cached.rows),
        );
      }
    }
    _lastOpened = newest;
    _evict(owner);
    // Changes held back while the load ran.
    if (_pending.isNotEmpty) _writeTimer ??= _timer(writeDelay, _writePending);
  }

  /// Records that [chat] was opened and returns its stored tail, or an empty
  /// list. Synchronous, so a chat screen can paint the tail on its first
  /// frame.
  ///
  /// [rows] reads the transcript the chat already shows, if any. Unless the
  /// chat is already the open one, that transcript is written as
  /// [markChanged] would write it: a chat evicted while it stayed loaded
  /// may see no further change to write it again.
  List<RemoteChatMessage> openTail(
    RemoteTranscriptChat chat, {
    List<RemoteChatMessage> Function()? rows,
    bool Function()? authoritative,
  }) {
    final owner = _owner;
    if (_closed || owner == null) return const [];
    var cached = _chats[chat];
    if (cached == null) {
      cached = _chats[chat] = _CachedChat(const [], ++_lastOpened);
      _evict(owner);
    } else if (cached.openedAt != _lastOpened) {
      cached.openedAt = ++_lastOpened;
    } else if (cached.opened) {
      // Still the open chat, e.g. rebuilding its screen.
      return cached.rows;
    }
    cached.opened = true;
    if (rows != null && rows().isNotEmpty) {
      markChanged(chat, rows, authoritative: authoritative);
    } else if (cached.rows.isNotEmpty) {
      _schedule(chat, _pending[chat]);
    }
    return cached.rows;
  }

  /// Reads a tail for hydration without claiming that its screen is in front.
  List<RemoteChatMessage> readTail(RemoteTranscriptChat chat) =>
      _closed ? const [] : _chats[chat]?.rows ?? const [];

  /// Notes that [chat]'s transcript changed; [rows] reads it when the write
  /// runs. Only chats opened in this session are written: live traffic for
  /// any other chat is a partial view, which must not replace its stored
  /// tail.
  ///
  /// Until [authoritative] reports that the desktop's snapshot or a server
  /// history page arrived for [chat], [rows] may be partial too, so a write
  /// keeps every stored row they lack: the union, newest
  /// [maxMessages] rows.
  void markChanged(
    RemoteTranscriptChat chat,
    List<RemoteChatMessage> Function() rows, {
    bool Function()? authoritative,
  }) {
    if (_closed || _owner == null || _chats[chat]?.opened != true) return;
    _schedule(chat, () {
      final current = rows();
      final cached = _chats[chat];
      if (cached == null) return current;
      if (authoritative?.call() ?? false) {
        // Kept from here on, e.g. across a reconnect that starts the
        // transcript over.
        cached.kept = _newestTail(current);
        return current;
      }
      return _withKeptRows(cached.kept, current);
    });
  }

  void _schedule(
    RemoteTranscriptChat chat,
    List<RemoteChatMessage> Function()? rows,
  ) {
    _pending[chat] = rows;
    // Not restarted by later changes: a long streaming turn is still written
    // every [writeDelay] rather than only once it ends.
    _writeTimer ??= _timer(writeDelay, _writePending);
  }

  void _writePending() {
    _writeTimer?.cancel();
    _writeTimer = null;
    final owner = _owner;
    if (_closed || owner == null) {
      _pending.clear();
      return;
    }
    // Until the stored tails are in memory, a write could replace one with
    // a partial view; the load writes what collected once it ends.
    if (_restoring != null) return;
    final pending = Map.of(_pending);
    _pending.clear();
    for (final MapEntry(key: chat, value: read) in pending.entries) {
      final cached = _chats[chat];
      if (cached == null) continue;
      final tail = read == null ? cached.rows : _newestTail(read());
      // Rows are immutable: the same objects at the stored recency mean
      // nothing to write.
      if (_sameRows(cached.rows, tail) && cached.storedAt == cached.openedAt) {
        continue;
      }
      cached.rows = tail;
      cached.storedAt = cached.openedAt;
      if (cached.rows.isEmpty) {
        storage.delete(owner, chat);
      } else {
        storage.write(
          owner,
          PersistedTranscript(
            chat: chat,
            openedAt: cached.openedAt,
            rows: cached.rows,
          ),
        );
      }
    }
  }

  /// Writes pending changes now, e.g. when the app is backgrounded.
  Future<void> flush() {
    if (_pending.isNotEmpty) _writePending();
    return storage.flush();
  }

  /// Forgets the paired session and deletes everything stored. Writes and
  /// loads still in flight cannot bring it back.
  Future<void> clearSession() {
    _forget();
    return storage.clear();
  }

  /// Stops using this cache without deleting what it stored. Used when the
  /// account it belongs to is no longer the signed-in one; the owner of the
  /// account lifetime deletes the files.
  void close() {
    _closed = true;
    _forget();
  }

  int _forget() {
    _writeTimer?.cancel();
    _writeTimer = null;
    _pending.clear();
    _chats.clear();
    _lastOpened = 0;
    _owner = null;
    _restoring = null;
    return ++_generation;
  }

  /// Drops the least recently opened chats beyond [maxChats].
  void _evict(RemoteTranscriptOwner owner) {
    while (_chats.length > maxChats) {
      final oldest = _chats.entries
          .reduce((a, b) => a.value.openedAt <= b.value.openedAt ? a : b)
          .key;
      _chats.remove(oldest);
      _pending.remove(oldest);
      storage.delete(owner, oldest);
    }
  }

  /// The [kept] rows with [rows] merged in by message id. A shared row keeps
  /// its kept place and position, and takes its content and revision from
  /// [rows], as `ChatTranscriptStore.upsert` updates a row: a timer revision
  /// moves its creation time, not its place. A row only in [rows] lands as
  /// that store inserts a new live row: before the first row positioned
  /// after it, otherwise last. [rows] keep their order.
  static List<RemoteChatMessage> _withKeptRows(
    List<RemoteChatMessage> kept,
    List<RemoteChatMessage> rows,
  ) {
    if (kept.isEmpty) return rows;
    final current = {for (final row in rows) row.messageId: row};
    final merged = [
      for (final row in kept)
        switch (current.remove(row.messageId)) {
          null => row,
          final revision => _anchored(revision, row.positionAt),
        },
    ];
    if (current.isEmpty) return merged;
    // Rows from here on precede no earlier row of [rows].
    var floor = 0;
    for (final row in rows) {
      if (!identical(current[row.messageId], row)) {
        final index = merged.indexWhere(
          (other) => other.messageId == row.messageId,
          floor,
        );
        if (index >= 0) floor = index + 1;
        continue;
      }
      final at = row.positionAt;
      var index = at == null
          ? -1
          : merged.indexWhere(
              (other) => other.positionAt?.isAfter(at) == true,
              floor,
            );
      if (index < 0) {
        merged.add(row);
      } else {
        merged.insert(index, row);
        floor = index + 1;
      }
    }
    return merged;
  }

  /// [revision] positioned at [at], the place its row already holds; the
  /// same object when it already is, so an unchanged tail is not rewritten.
  static RemoteChatMessage _anchored(
    RemoteChatMessage revision,
    DateTime? at,
  ) => at == null || at == revision.positionAt
      ? revision
      : revision.withOrderingAt(at);

  List<RemoteChatMessage> _newestTail(List<RemoteChatMessage> rows) =>
      List.unmodifiable(
        rows.length > maxMessages
            ? rows.sublist(rows.length - maxMessages)
            : rows,
      );

  static bool _sameRows(List<RemoteChatMessage> a, List<RemoteChatMessage> b) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!identical(a[i], b[i])) return false;
    }
    return true;
  }
}

final class _CachedChat {
  _CachedChat(
    this.rows,
    this.openedAt, {
    this.storedAt = 0,
    this.kept = const [],
  });

  List<RemoteChatMessage> rows;
  int openedAt;

  /// The recency last written with [rows]; 0 before the first write.
  int storedAt;

  /// Rows no write may drop before the chat's authoritative data arrives:
  /// the stored tail, or the last tail written once that data had arrived.
  List<RemoteChatMessage> kept;

  /// Opened in this session, so the in-memory transcript is the chat's own
  /// rather than background traffic on top of a stored tail.
  bool opened = false;
}
