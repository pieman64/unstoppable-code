// CAN-3373: random interleavings of opens, live revisions, rows the app
// missed, server tails, history pages, authoritative data, slow loads,
// restarts, evictions and reopens, and clears over the transcript cache, the
// real file storage, and the transcript store that feeds it. Row times are
// not monotonic, and timer revisions move a row's creation time. In every
// order the stored tails stay duplicate-free, keep their order and ordering
// anchors, lose no row before authoritative data arrives, paint in stored
// order, only a snapshot moves a shown row, nothing is
// written after a clear, a history page never leaves an older cached row
// after a newer history row, and every open chat that shows rows has a
// stored tail after a flush. Every stored and shown row also keeps the
// watcher marker of its revision (CAN-4432).
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/ui/features/remote/view_models/chat_transcript_store.dart';

const _accountScope = 'production:7';
const _chatIds = ['a', 'b', 'c'];
const _maxChats = 2;
const _maxMessages = 6;
const _scenarios = 1000;
const _steps = 80;
final _start = DateTime.utc(2026, 10, 4, 12);

RemoteTranscriptChat _chat(String id) =>
    (scope: RemoteChatScope.worktree, chatId: id);

RemoteChatTarget _target(String id) => RemoteWorktreeChatTarget(
  workspaceLocalId: 'workspace',
  worktreeLocalId: 'worktree',
  chatId: id,
);

/// One desktop row: its creation time moves when a timer revision lands.
final class _DesktopRow {
  _DesktopRow(this.createdAt, this.updatedAt);

  int revision = 0;
  int createdAt;
  int updatedAt;
}

RemoteChatMessage _row(String chatId, int index, _DesktopRow row) =>
    RemoteChatMessage(
      messageId: '$chatId-$index',
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: '${row.revision}',
      occurredAt: _start.add(Duration(seconds: row.createdAt)),
      updatedAt: _start.add(Duration(seconds: row.updatedAt)),
      watcherFired: _marker('$chatId-$index', index, '${row.revision}'),
    );

/// The watcher marker a row carries at a revision: even rows have one, and
/// every fourth merges watchers, so the stored file covers both shapes.
ChatWatcherFiredInfo? _marker(String messageId, int index, String revision) =>
    index.isOdd
    ? null
    : ChatWatcherFiredInfo(
        kind: '$messageId@$revision',
        combinedWatchers: index % 4 == 0
            ? [ChatWatcherFiredEntry(kind: messageId, text: revision)]
            : null,
      );

List<String> _ids(Iterable<RemoteChatMessage> rows) => [
  for (final row in rows) row.messageId,
];

/// [ids] in the order [order] lists them.
List<String> _inOrderOf(List<String> order, Iterable<String> ids) {
  final wanted = ids.toSet();
  return [
    for (final id in order)
      if (wanted.contains(id)) id,
  ];
}

Future<R> _inline<R>(FutureOr<R> Function() computation) async => computation();

/// Issues each load in order but answers it only once [gate] opens, like a
/// load that outlasts the session's readiness budget.
final class _SlowLoads implements RemoteTranscriptStorage {
  _SlowLoads(this.inner, this.onWrite);

  final RemoteTranscriptStorage inner;
  final void Function(String chatId) onWrite;
  Completer<void>? gate;

  @override
  Future<List<PersistedTranscript>> load(RemoteTranscriptOwner owner) async {
    final stored = inner.load(owner);
    if (gate case final gate?) await gate.future;
    return stored;
  }

  @override
  void write(RemoteTranscriptOwner owner, PersistedTranscript transcript) {
    onWrite(transcript.chat.chatId);
    inner.write(owner, transcript);
  }

  @override
  void delete(RemoteTranscriptOwner owner, RemoteTranscriptChat chat) =>
      inner.delete(owner, chat);

  @override
  Future<void> clear() => inner.clear();

  @override
  Future<void> flush() => inner.flush();
}

final class _Scenario {
  _Scenario(this.seed, this.directory, this.async) : random = Random(seed);

  final int seed;
  final Directory directory;
  final FakeAsync async;
  final Random random;
  final List<String> trace = [];

  var session = 1;
  RemoteTranscriptOwner get owner =>
      (accountScope: _accountScope, sessionId: 'session-$session');

  /// The desktop: each chat's rows in desktop order.
  final Map<String, List<_DesktopRow>> desktop = {
    for (final id in _chatIds) id: [],
  };

  /// Seconds on the desktop clock; every revision is newer than the last.
  var clock = 100;

  late _SlowLoads storage;
  late RemoteTranscriptCache cache;

  /// This app run's transcripts, wired to the cache as the engine wires them.
  late ChatTranscriptStore transcripts;

  /// Chats from least to most recently opened, as the cache ranks them.
  List<String> recency = [];
  bool clearedSinceOpen = false;
  Map<String, PersistedTranscript> lastStored = {};

  /// Chats opened in this app run and session.
  final Set<String> opened = {};

  /// Chats whose file was written since their last authoritative snapshot.
  final Set<String> writtenSinceSnapshot = {};

  /// Each chat's rows as the app showed them at the last check, and the
  /// chats a snapshot may have reordered since.
  Map<String, List<RemoteChatMessage>> lastShown = {};
  final Set<String> snapshotSinceCheck = {};

  /// The rows each chat's stored or server tail painted, by identity, while
  /// they are still only provisional cached rows.
  final Map<String, Set<RemoteChatMessage>> cachedRows = {};

  /// Each chat's history request awaiting its page, with its cursor.
  final Map<String, ({String? before, Completer<RemoteChatHistoryChunk> page})>
  historyRequests = {};

  void run() {
    launch();
    for (var step = 0; step < _steps; step++) {
      final chat = _chatIds[random.nextInt(_chatIds.length)];
      final action = random.nextInt(100);
      if (action < 16) {
        open(chat);
      } else if (action < 19) {
        evictAndReopen(chat);
      } else if (action < 40) {
        live(chat);
      } else if (action < 44) {
        missed(chat);
      } else if (action < 50) {
        snapshot(chat);
      } else if (action < 54) {
        server(chat);
      } else if (action < 62) {
        history(chat);
      } else if (action < 73) {
        final ms = random.nextInt(800);
        trace.add('elapse $ms');
        async.elapse(Duration(milliseconds: ms));
      } else if (action < 78) {
        trace.add('flush');
        unawaited(cache.flush());
        async.flushMicrotasks();
        checkFlushed();
      } else if (action < 86) {
        trace.add('answer load');
        storage.gate?.complete();
        storage.gate = null;
      } else if (action < 95) {
        restart();
      } else {
        clear();
      }
      async.flushMicrotasks();
      check();
    }
    cache.close();
    storage.gate?.complete();
    async.flushMicrotasks();
  }

  void launch() {
    storage = _SlowLoads(
      FileRemoteTranscriptStorage(
        directory: () async => directory,
        worker: _inline,
      ),
      writtenSinceSnapshot.add,
    );
    if (random.nextBool()) storage.gate = Completer();
    trace.add(storage.gate == null ? 'launch' : 'launch, load slow');
    cache = RemoteTranscriptCache(
      storage: storage,
      accountScope: _accountScope,
      maxChats: _maxChats,
      maxMessages: _maxMessages,
    );
    historyRequests.clear();
    final transcripts = ChatTranscriptStore(
      notify: () {},
      isConnected: () => true,
      fetchHistory: (target, {before}) {
        final page = Completer<RemoteChatHistoryChunk>();
        historyRequests[target.chatId!] = (before: before, page: page);
        return page.future;
      },
      onEvidence: (_, _) {},
      onTranscriptChanged: (chat) => cache.markChanged(
        chat,
        () => this.transcripts.projectedRows(chat),
        authoritative: () => this.transcripts.hasAuthoritativeRows(chat),
      ),
    );
    this.transcripts = transcripts;
    lastShown = {};
    opened.clear();
    cachedRows.clear();
    recency = [
      for (final transcript
          in stored().values.toList()
            ..sort((a, b) => a.openedAt.compareTo(b.openedAt)))
        transcript.chat.chatId,
    ];
    unawaited(cache.restoreSession(owner.sessionId));
  }

  bool authoritative(String chat) =>
      transcripts.hasAuthoritativeRows(_chat(chat));

  /// Opens [chat] as `ensureChatTranscript` does: its stored tail seeds the
  /// transcript, under any rows already shown.
  void open(String chat) {
    trace.add('open $chat');
    final tail = cache.openTail(
      _chat(chat),
      rows: () => transcripts.projectedRows(_chat(chat)),
      authoritative: () => authoritative(chat),
    );
    recency
      ..remove(chat)
      ..add(chat);
    clearedSinceOpen = false;
    opened.add(chat);
    final before = _ids(transcripts.projectedRows(_chat(chat)));
    if (!transcripts.seedFromCache(
      _chat(chat),
      tail,
      source: RemoteCachedTailSource.device,
    )) {
      return;
    }
    final shown = transcripts.projectedRows(_chat(chat));
    cachedRows[chat] = Set.identity()
      ..addAll(
        tail.where((row) => shown.any((other) => identical(other, row))),
      );
    final after = _ids(shown);
    final stored = _ids(tail);
    if (before.isEmpty) {
      expect(after, stored, reason: _reason('$chat seeded out of order'));
      return;
    }
    // Rows shown first keep their places. When they agree with the stored
    // order, the whole tail paints in it; otherwise the rows it adds do.
    final shared = _inOrderOf(stored, before);
    final expected = _listEquals(shared, _inOrderOf(before, shared))
        ? stored
        : [
            for (final id in stored)
              if (!before.contains(id)) id,
          ];
    expect(
      _inOrderOf(after, expected),
      expected,
      reason: _reason('$chat seeded under live rows out of order'),
    );
  }

  void live(String chat) {
    final rows = desktop[chat]!;
    clock += 1;
    final int index;
    if (rows.isEmpty || random.nextBool()) {
      // Creation times are not monotonic.
      rows.add(_DesktopRow(random.nextInt(clock), clock));
      index = rows.length - 1;
    } else {
      index = random.nextInt(rows.length);
      final row = rows[index]
        ..revision += 1
        ..updatedAt = clock;
      // A timer revision moves the row's creation time.
      if (random.nextBool()) row.createdAt = clock;
    }
    final row = rows[index];
    trace.add('live $chat-$index r${row.revision} at ${row.createdAt}');
    transcripts.ingest(_chat(chat), _row(chat, index, row));
  }

  /// Opens the other chats, so [chat] is evicted while it stays loaded, and
  /// opens it again.
  void evictAndReopen(String chat) {
    if (!opened.contains(chat)) return;
    trace.add('evict $chat');
    for (final other in _chatIds) {
      if (other == chat) continue;
      open(other);
      async.flushMicrotasks();
      check();
    }
    open(chat);
  }

  /// Desktop rows the app missed, e.g. while it was not running: sometimes
  /// more than a history page, so the cached tail and the newest page share
  /// no row.
  void missed(String chat) {
    final rows = desktop[chat]!;
    final first = rows.length;
    for (var i = random.nextInt(_maxMessages + 2); i >= 0; i--) {
      clock += 1;
      rows.add(_DesktopRow(random.nextInt(clock), clock));
    }
    trace.add('missed $chat-$first to $chat-${rows.length - 1}');
  }

  /// Requests [chat]'s next history page, or answers the request in flight
  /// with the desktop's rows before its cursor. The newest page can lag the
  /// live tail by a row or two.
  void history(String chat) {
    final request = historyRequests.remove(chat);
    if (request == null) {
      if (!opened.contains(chat)) return;
      trace.add('request history $chat');
      unawaited(transcripts.loadOlderMessages(_target(chat)));
      return;
    }
    final rows = desktop[chat]!;
    final before = request.before;
    final end = before == null
        ? max(0, rows.length - random.nextInt(3))
        : int.parse(before);
    final first = max(0, end - 1 - random.nextInt(_maxMessages + 2));
    trace.add('history $chat from $first to $end');
    final shownBefore = _ids(transcripts.projectedRows(_chat(chat)));
    request.page.complete(
      RemoteChatHistoryChunk(
        messages: [for (var i = first; i < end; i++) _row(chat, i, rows[i])],
        nextCursor: first > 0 ? '$first' : null,
      ),
    );
    async.flushMicrotasks();
    checkHistoryOrder(chat, shownBefore, {
      for (var i = first; i < end; i++) '$chat-$i',
    });
  }

  /// A history page never leaves a cached row it does not carry after one
  /// of its rows the desktop wrote later, unless a row as new already showed
  /// before that cached row.
  void checkHistoryOrder(
    String chat,
    List<String> shownBefore,
    Set<String> page,
  ) {
    final cached = cachedRows[chat];
    if (cached == null) return;
    final shown = transcripts.projectedRows(_chat(chat));
    int index(String id) => int.parse(id.split('-').last);
    for (final (j, row) in shown.indexed) {
      if (!cached.contains(row) || page.contains(row.messageId)) continue;
      final at = index(row.messageId);
      final before = shownBefore.indexOf(row.messageId);
      final newestBefore = shownBefore
          .take(max(0, before))
          .map(index)
          .fold(-1, max);
      for (final paged in shown.take(j)) {
        if (!page.contains(paged.messageId)) continue;
        final pagedAt = index(paged.messageId);
        expect(
          pagedAt < at || newestBefore >= pagedAt,
          isTrue,
          reason: _reason(
            'older cached ${row.messageId} after newer ${paged.messageId}',
          ),
        );
      }
    }
  }

  void snapshot(String chat) {
    final rows = desktop[chat]!;
    if (rows.isEmpty || !opened.contains(chat)) return;
    final window = 1 + random.nextInt(_maxMessages + 2);
    final first = max(0, rows.length - window);
    trace.add('snapshot $chat from $first');
    writtenSinceSnapshot.remove(chat);
    snapshotSinceCheck.add(chat);
    cachedRows.remove(chat);
    transcripts.replaceAuthoritative(_chat(chat), [
      for (var i = first; i < rows.length; i++) _row(chat, i, rows[i]),
    ], truncated: first > 0);
  }

  /// The server's cached tail, read when an open's transcript request
  /// starts: a recent window ordered by creation time, with no ordering
  /// anchors.
  void server(String chat) {
    final rows = desktop[chat]!;
    if (rows.isEmpty || !opened.contains(chat)) return;
    final window = 1 + random.nextInt(_maxMessages + 2);
    final first = max(0, rows.length - window);
    final tail = [
      for (var i = first; i < rows.length; i++) _row(chat, i, rows[i]),
    ]..sort((a, b) => a.occurredAt!.compareTo(b.occurredAt!));
    trace.add('server $chat from $first');
    if (!transcripts.seedFromCache(_chat(chat), tail)) return;
    // The server's rows take over the stored ones and stay provisional.
    cachedRows[chat] = Set.identity()
      ..addAll(transcripts.projectedRows(_chat(chat)));
  }

  void restart() {
    final flushed = random.nextBool();
    trace.add(flushed ? 'restart after flush' : 'restart');
    if (flushed) unawaited(cache.flush());
    cache.close();
    async.flushMicrotasks();
    // What the closing run wrote, judged by what that run knew.
    check();
    launch();
  }

  void clear() {
    trace.add('clear');
    unawaited(cache.clearSession());
    transcripts.reset();
    opened.clear();
    session += 1;
    historyRequests.clear();
    cachedRows.clear();
    recency.clear();
    lastStored = {};
    lastShown = {};
    clearedSinceOpen = true;
    unawaited(cache.restoreSession(owner.sessionId));
  }

  Map<String, PersistedTranscript> stored() {
    final transcripts = <String, PersistedTranscript>{};
    for (final entity in directory.listSync()) {
      final name = entity.uri.pathSegments.last;
      final transcript = entity is File && name.endsWith('.json')
          ? decodeRemoteTranscript(
              entity.readAsStringSync(),
              owner: owner,
              fileName: name,
            )
          : null;
      expect(transcript, isNotNull, reason: _reason('unexpected file $name'));
      transcripts[transcript!.chat.chatId] = transcript;
    }
    return transcripts;
  }

  /// A row's marker matches its revision through every rebuild and file.
  void checkMarker(RemoteChatMessage row, String where) {
    String describe(ChatWatcherFiredInfo? marker) => [
      ?marker?.kind,
      for (final entry in marker?.combinedWatchers ?? const [])
        '${entry.kind}:${entry.text}',
    ].join(' | ');
    final index = int.parse(row.messageId.split('-').last);
    expect(
      describe(row.watcherFired),
      describe(_marker(row.messageId, index, row.text)),
      reason: _reason('$where ${row.messageId} lost its watcher marker'),
    );
  }

  void check() {
    final now = stored();
    if (clearedSinceOpen) {
      expect(now, isEmpty, reason: _reason('written after a clear'));
    }
    for (final MapEntry(key: chat, value: transcript) in now.entries) {
      for (final row in transcript.rows) {
        checkMarker(row, 'stored');
      }
      final rows = _ids(transcript.rows);
      expect(
        rows.toSet(),
        hasLength(rows.length),
        reason: _reason('duplicate rows in $chat'),
      );
      // Once authoritative data arrived, a write stores the transcript as
      // the app shows it; nothing but a snapshot moves a shown row.
      if (authoritative(chat) && writtenSinceSnapshot.contains(chat)) {
        final shown = _ids(transcripts.projectedRows(_chat(chat)));
        expect(
          _inOrderOf(shown, rows),
          _inOrderOf(rows, shown),
          reason: _reason('$chat stored out of the shown order'),
        );
      }
    }
    for (final MapEntry(key: chat, value: before) in lastStored.entries) {
      if (authoritative(chat)) continue;
      final after = now[chat];
      if (after == null) {
        // Only an evicted chat loses its file.
        expect(
          recency.reversed.take(_maxChats),
          isNot(contains(chat)),
          reason: _reason('$chat deleted before authoritative data'),
        );
        continue;
      }
      final beforeIds = _ids(before.rows);
      final afterIds = _ids(after.rows);
      // Before authoritative data, stored rows keep their order.
      expect(
        _inOrderOf(afterIds, beforeIds),
        _inOrderOf(beforeIds, afterIds),
        reason: _reason('$chat reordered before authoritative data'),
      );
      final kept = {for (final row in after.rows) row.messageId: row};
      var dropping = true;
      for (final row in before.rows) {
        final current = kept[row.messageId];
        if (current == null) {
          // Only the bound on stored rows drops one: the oldest.
          expect(
            dropping && after.rows.length == _maxMessages,
            isTrue,
            reason: _reason('$chat lost ${row.messageId}'),
          );
          continue;
        }
        dropping = false;
        expect(
          int.parse(current.text) >= int.parse(row.text),
          isTrue,
          reason: _reason('${row.messageId} rewound'),
        );
        expect(
          current.positionAt,
          row.positionAt,
          reason: _reason('${row.messageId} lost its stored position'),
        );
      }
    }
    lastStored = now;
    checkShown();
  }

  /// After a flush with the stored tails loaded, every chat opened in this
  /// run that shows rows and was not evicted since has a stored tail.
  void checkFlushed() {
    if (storage.gate != null) return;
    final now = stored();
    for (final chat in recency.reversed.take(_maxChats)) {
      if (!opened.contains(chat)) continue;
      if (transcripts.projectedRows(_chat(chat)).isEmpty) continue;
      expect(
        now.containsKey(chat),
        isTrue,
        reason: _reason('open $chat shows rows but has no stored tail'),
      );
    }
  }

  /// Only a snapshot moves a shown row or its ordering anchor.
  void checkShown() {
    final shown = {
      for (final chat in _chatIds) chat: transcripts.projectedRows(_chat(chat)),
    };
    for (final rows in shown.values) {
      for (final row in rows) {
        checkMarker(row, 'shown');
      }
    }
    for (final MapEntry(key: chat, value: before) in lastShown.entries) {
      if (snapshotSinceCheck.contains(chat)) continue;
      final after = shown[chat]!;
      final beforeIds = _ids(before);
      final afterIds = _ids(after);
      expect(
        _inOrderOf(afterIds, beforeIds),
        _inOrderOf(beforeIds, afterIds),
        reason: _reason('$chat moved a shown row'),
      );
      final anchors = {for (final row in after) row.messageId: row.positionAt};
      for (final row in before) {
        if (!anchors.containsKey(row.messageId)) continue;
        expect(
          anchors[row.messageId],
          row.positionAt,
          reason: _reason('shown ${row.messageId} lost its ordering anchor'),
        );
      }
    }
    snapshotSinceCheck.clear();
    lastShown = shown;
  }

  String _reason(String failure) =>
      '$failure; seed $seed after: ${trace.join(', ')}';
}

bool _listEquals(List<String> a, List<String> b) =>
    a.length == b.length &&
    [for (var i = 0; i < a.length; i++) i].every((i) => a[i] == b[i]);

void main() {
  test('random interleavings with moving row times keep stored tails in '
      'order, complete until authoritative data arrives, painted in stored '
      'order, written for every open chat, and gone after a clear, '
      'history pages never leave older cached rows after newer ones, and '
      'every row keeps its watcher marker', () {
    for (var seed = 0; seed < _scenarios; seed++) {
      final directory = Directory.systemTemp.createTempSync('can3373-random');
      try {
        fakeAsync((async) => _Scenario(seed, directory, async).run());
      } finally {
        directory.deleteSync(recursive: true);
      }
    }
  });
}
