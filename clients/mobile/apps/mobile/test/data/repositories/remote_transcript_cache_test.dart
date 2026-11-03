// CAN-3373: the bounded, recency-ordered chat tails Remote Control keeps on
// this device, against an in-memory storage port and a fake clock.
import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';

import '../../support/memory_remote_transcript_storage.dart';

const _owner = (accountScope: 'production:7', sessionId: 'session-1');

RemoteTranscriptChat _chat(String id) =>
    (scope: RemoteChatScope.worktree, chatId: id);

RemoteChatMessage _row(String id, {String chatId = 'chat-1'}) =>
    RemoteChatMessage(
      messageId: id,
      chatId: chatId,
      scope: RemoteChatScope.worktree,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: id,
    );

/// A row positioned [second]s into the chat; a [text] marks a newer revision
/// that keeps the original position, like a live update.
RemoteChatMessage _dated(String id, int second, {String? text}) =>
    RemoteChatMessage(
      messageId: id,
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      role: ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text: text ?? id,
      occurredAt: _second(second),
    );

DateTime _second(int second) =>
    DateTime.utc(2026, 10, 4, 12).add(Duration(seconds: second));

/// A newer revision of [id] that moves its creation time to [second], like a
/// runtime timer, and carries no ordering anchor of its own.
RemoteChatMessage _revised(String id, int second) => RemoteChatMessage(
  messageId: id,
  chatId: 'chat-1',
  scope: RemoteChatScope.worktree,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: '$id at ${second}s',
  occurredAt: _second(second),
  updatedAt: _second(second),
);

List<RemoteChatMessage> _rows(int count, {String chatId = 'chat-1'}) => [
  for (var i = 0; i < count; i++) _row('m$i', chatId: chatId),
];

List<String> _ids(List<RemoteChatMessage> rows) => [
  for (final row in rows) row.messageId,
];

void main() {
  late MemoryRemoteTranscriptStorage storage;

  RemoteTranscriptCache cache({int maxChats = 20}) => RemoteTranscriptCache(
    storage: storage,
    accountScope: _owner.accountScope,
    maxChats: maxChats,
  );

  void store(String chatId, int openedAt, List<RemoteChatMessage> rows) {
    (storage.files[_owner] ??= {})[_chat(chatId)] = PersistedTranscript(
      chat: _chat(chatId),
      openedAt: openedAt,
      rows: rows,
    );
  }

  setUp(() => storage = MemoryRemoteTranscriptStorage());

  test('a restored session answers opens synchronously', () async {
    store('chat-1', 3, [_row('a'), _row('b')]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');

    expect(_ids(transcripts.openTail(_chat('chat-1'))), ['a', 'b']);
    expect(transcripts.openTail(_chat('unknown')), isEmpty);
  });

  test('nothing is answered before a session is restored', () {
    store('chat-1', 1, [_row('a')]);
    expect(cache().openTail(_chat('chat-1')), isEmpty);
  });

  test('another session sees none of the previous session', () async {
    store('chat-1', 1, [_row('a')]);
    final transcripts = cache();
    await transcripts.restoreSession('session-2');
    expect(transcripts.openTail(_chat('chat-1')), isEmpty);
    expect(storage.files.keys, isNot(contains(_owner)));
  });

  test('a missing session deletes every stored transcript', () async {
    store('chat-1', 1, [_row('a')]);
    final transcripts = cache();
    await transcripts.restoreSession(null);
    expect(storage.log, ['clear']);
    expect(storage.files, isEmpty);
    expect(transcripts.openTail(_chat('chat-1')), isEmpty);
  });

  test('a failed load is a cache miss', () async {
    storage.loadError = StateError('disk');
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    expect(transcripts.openTail(_chat('chat-1')), isEmpty);
  });

  test('only opened chats are written, after the write delay, newest 50 '
      'messages', () {
    fakeAsync((async) {
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();

      transcripts.markChanged(_chat('background'), () => _rows(3));
      transcripts.openTail(_chat('chat-1'));
      transcripts.markChanged(_chat('chat-1'), () => _rows(51));
      async.elapse(const Duration(milliseconds: 499));
      expect(storage.log, ['load session-1']);

      async.elapse(const Duration(milliseconds: 1));
      expect(storage.log, ['load session-1', 'write chat-1']);
      final stored = storage.storedIds(_owner, 'chat-1')!;
      expect(stored, hasLength(50));
      expect(stored.first, 'm1');
      expect(stored.last, 'm50');
      expect(storage.storedIds(_owner, 'background'), isNull);
    });
  });

  test('a streaming turn coalesces into periodic writes and keeps the final '
      'revision', () {
    fakeAsync((async) {
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));

      var rows = [_row('q')];
      // 4 Hz for 2 seconds: every change re-reads the latest rows.
      for (var tick = 0; tick < 8; tick++) {
        rows = [...rows.take(1), _row('answer-$tick')];
        transcripts.markChanged(_chat('chat-1'), () => rows);
        async.elapse(const Duration(milliseconds: 250));
      }
      final writes = storage.log.where((op) => op.startsWith('write')).length;
      expect(writes, 4);
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['q', 'answer-7']);
    });
  });

  test('unchanged rows are not rewritten and an emptied chat is deleted', () {
    fakeAsync((async) {
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      final rows = [_row('a')];
      transcripts.markChanged(_chat('chat-1'), () => rows);
      async.elapse(const Duration(seconds: 1));
      transcripts.markChanged(_chat('chat-1'), () => List.of(rows));
      async.elapse(const Duration(seconds: 1));
      expect(storage.log.where((op) => op.startsWith('write')), hasLength(1));

      transcripts.markChanged(_chat('chat-1'), () => const []);
      async.elapse(const Duration(seconds: 1));
      expect(storage.log.last, 'delete chat-1');
      expect(storage.storedIds(_owner, 'chat-1'), isNull);
    });
  });

  test('the 21st opened chat evicts the least recently opened', () {
    fakeAsync((async) {
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      for (var i = 0; i < 20; i++) {
        final chat = _chat('chat-$i');
        transcripts.openTail(chat);
        transcripts.markChanged(chat, () => [_row('m', chatId: 'chat-$i')]);
      }
      async.elapse(const Duration(seconds: 1));
      // Reopening chat-0 makes chat-1 the least recently opened.
      transcripts.openTail(_chat('chat-0'));
      transcripts.openTail(_chat('chat-20'));
      expect(storage.log, contains('delete chat-1'));
      expect(storage.log, isNot(contains('delete chat-0')));
      async.elapse(const Duration(seconds: 1));
      expect(storage.files[_owner]!.keys, hasLength(19));
      expect(storage.files[_owner]!.containsKey(_chat('chat-0')), isTrue);
    });
  });

  test('recency survives a restart, and background traffic neither changes '
      'nor rewrites a stored chat that was not opened', () async {
    store('old', 1, [_row('o', chatId: 'old'), _row('o1', chatId: 'old')]);
    store('newer', 2, [_row('n', chatId: 'newer')]);
    final transcripts = cache(maxChats: 2);
    await transcripts.restoreSession('session-1');
    // Live rows of an unopened chat are only part of its stored tail.
    transcripts.markChanged(_chat('old'), () => [_row('o2', chatId: 'old')]);
    await transcripts.flush();
    expect(storage.log, isNot(contains('write old')));
    expect(storage.storedIds(_owner, 'old'), ['o', 'o1']);
    expect(storage.files[_owner]![_chat('old')]!.openedAt, 1);

    transcripts.openTail(_chat('third'));
    expect(storage.log, contains('delete old'));
    expect(transcripts.openTail(_chat('newer')), isNotEmpty);
  });

  test('reopening a stored chat persists its new recency', () async {
    store('a', 1, [_row('a', chatId: 'a')]);
    store('b', 2, [_row('b', chatId: 'b')]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('a'));
    await transcripts.flush();
    expect(storage.files[_owner]![_chat('a')]!.openedAt, 3);

    // Once opened, its changes are written too.
    transcripts.markChanged(
      _chat('a'),
      () => [_row('a', chatId: 'a'), _row('a2', chatId: 'a')],
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'a'), ['a', 'a2']);
  });

  test('a reopened chat whose rows are unchanged still persists its new '
      'recency, so a restart evicts the older chat', () async {
    // CAN-3373 R9: the device seed reports the same rows the open returned.
    store('a', 1, [_row('a', chatId: 'a')]);
    store('b', 2, [_row('b', chatId: 'b')]);
    final transcripts = cache(maxChats: 2);
    await transcripts.restoreSession('session-1');
    final rows = transcripts.openTail(_chat('a'));
    transcripts.markChanged(_chat('a'), () => rows);
    await transcripts.flush();
    expect(storage.files[_owner]![_chat('a')]!.openedAt, 3);

    final restarted = cache(maxChats: 2);
    await restarted.restoreSession('session-1');
    restarted.openTail(_chat('third'));
    expect(storage.log, contains('delete b'));
    expect(storage.log, isNot(contains('delete a')));
    expect(restarted.openTail(_chat('a')), isNotEmpty);
  });

  test('reopening an evicted chat writes the rows it already shows', () async {
    // CAN-3373 PF5: eviction deletes the file, but the chat stays hydrated
    // in memory, so no later change may come to write it again.
    final transcripts = cache(maxChats: 1);
    await transcripts.restoreSession('session-1');
    final rows = [_row('a1', chatId: 'a'), _row('a2', chatId: 'a')];
    transcripts.openTail(_chat('a'), rows: () => rows);
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'a'), ['a1', 'a2']);

    transcripts.openTail(_chat('b'));
    expect(storage.storedIds(_owner, 'a'), isNull);
    expect(transcripts.openTail(_chat('a'), rows: () => rows), isEmpty);
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'a'), ['a1', 'a2']);

    final restarted = cache(maxChats: 1);
    await restarted.restoreSession('session-1');
    expect(_ids(restarted.openTail(_chat('a'))), ['a1', 'a2']);
  });

  test('opening a chat that shows no rows writes nothing', () async {
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('a'), rows: () => const []);
    await transcripts.flush();
    expect(storage.log.where((op) => op.startsWith('write')), isEmpty);
  });

  test('reopening a stored chat writes the rows it shows with its stored '
      'ones until authoritative data arrives', () async {
    store('a', 1, [_row('a1', chatId: 'a')]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    var authoritative = false;
    var rows = [_row('a2', chatId: 'a')];
    transcripts.openTail(
      _chat('a'),
      rows: () => rows,
      authoritative: () => authoritative,
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'a'), ['a1', 'a2']);

    // Rebuilds open the chat again without rewriting it.
    final writes = storage.log.length;
    transcripts.openTail(_chat('a'), rows: () => rows);
    await transcripts.flush();
    expect(storage.log, hasLength(writes));

    authoritative = true;
    rows = [_row('a3', chatId: 'a')];
    transcripts.openTail(_chat('b'));
    transcripts.openTail(
      _chat('a'),
      rows: () => rows,
      authoritative: () => authoritative,
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'a'), ['a3']);
  });

  test('a stored chat opened while the load runs keeps its stored rows', () {
    // CAN-3373 R8: the session's readiness budget can expire before the
    // load, so the chat opens before its stored tail is in memory.
    fakeAsync((async) {
      store('chat-1', 1, _rows(50));
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      expect(transcripts.openTail(_chat('chat-1')), isEmpty);
      storage.loadGate!.complete();
      async.flushMicrotasks();

      transcripts.markChanged(_chat('chat-1'), () => [_row('m50')]);
      async.elapse(const Duration(seconds: 1));
      final newest = [for (var i = 1; i <= 50; i++) 'm$i'];
      expect(storage.storedIds(_owner, 'chat-1'), newest);
      expect(_ids(transcripts.openTail(_chat('chat-1'))), newest);
    });
  });

  test('a stored chat opened while the load runs keeps its new recency and '
      'is rewritten with its stored rows', () {
    fakeAsync((async) {
      store('chat-1', 1, _rows(3));
      store('other', 2, [_row('o', chatId: 'other')]);
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      // A live row is a partial view: nothing is written before the stored
      // rows are in memory to keep.
      transcripts.markChanged(_chat('chat-1'), () => [_row('live')]);
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['m0', 'm1', 'm2']);
      expect(storage.log.where((op) => op.startsWith('write')), isEmpty);

      storage.loadGate!.complete();
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 1));
      final stored = storage.files[_owner]![_chat('chat-1')]!;
      expect(_ids(stored.rows), ['m0', 'm1', 'm2', 'live']);
      expect(stored.openedAt, 3);
    });
  });

  test('changes made while a load that fails runs are written once it '
      'ends', () {
    fakeAsync((async) {
      store('chat-1', 1, _rows(3));
      final transcripts = cache();
      storage
        ..loadGate = Completer()
        ..loadError = StateError('disk');
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      transcripts.markChanged(_chat('chat-1'), () => [_row('live')]);
      unawaited(transcripts.flush());
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['m0', 'm1', 'm2']);

      storage.loadGate!.complete();
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['live']);
    });
  });

  test('a live revision of a stored row keeps the stored place while the '
      'load answers late', () {
    // CAN-3373 R10: the revision arrives with its original position.
    fakeAsync((async) {
      store('chat-1', 1, [_dated('m0', 0), _dated('m1', 1), _dated('m2', 2)]);
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      storage.loadGate!.complete();
      async.flushMicrotasks();

      transcripts.markChanged(
        _chat('chat-1'),
        () => [_dated('m1', 1, text: 'm1 edited')],
      );
      async.elapse(const Duration(seconds: 1));
      final rows = storage.files[_owner]![_chat('chat-1')]!.rows;
      expect(_ids(rows), ['m0', 'm1', 'm2']);
      expect(rows[1].text, 'm1 edited');
      expect(_ids(transcripts.openTail(_chat('chat-1'))), ['m0', 'm1', 'm2']);
    });
  });

  test('an update to a row before the newest of a full stored tail keeps '
      'its place', () async {
    store('chat-1', 1, [for (var i = 0; i < 50; i++) _dated('m$i', i)]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    transcripts.markChanged(
      _chat('chat-1'),
      () => [_dated('m10', 10, text: 'm10 edited')],
    );
    await transcripts.flush();
    final rows = storage.files[_owner]![_chat('chat-1')]!.rows;
    expect(_ids(rows), [for (var i = 0; i < 50; i++) 'm$i']);
    expect(rows[10].text, 'm10 edited');
  });

  test('new rows land by position among the stored rows they update', () async {
    // Stored rows sit at even seconds, so a new row can land between two.
    store('chat-1', 1, [for (var i = 0; i < 50; i++) _dated('m$i', 2 * i)]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    transcripts.markChanged(
      _chat('chat-1'),
      () => [
        _dated('between', 11),
        _dated('m48', 96, text: 'm48 edited'),
        _dated('n1', 200),
        _dated('n2', 201),
      ],
    );
    await transcripts.flush();
    final rows = storage.files[_owner]![_chat('chat-1')]!.rows;
    expect(_ids(rows), [
      'm3',
      'm4',
      'm5',
      'between',
      for (var i = 6; i < 50; i++) 'm$i',
      'n1',
      'n2',
    ]);
    expect(rows.firstWhere((row) => row.messageId == 'm48').text, 'm48 edited');
  });

  test('a live revision that moves a stored row\'s timestamp keeps its stored '
      'place and position across a restart', () {
    // CAN-3373 R12: a timer revision changes its creation time, so the
    // stored position anchors the row, as `ChatTranscriptStore.upsert` keeps
    // it; only the content and revision fields are the new revision's.
    fakeAsync((async) {
      store('chat-1', 1, [
        _dated('m0', 0),
        _dated('timer', 1),
        _dated('m2', 2),
      ]);
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      storage.loadGate!.complete();
      async.flushMicrotasks();

      final revision = _revised('timer', 4);
      transcripts.markChanged(_chat('chat-1'), () => [revision]);
      async.elapse(const Duration(seconds: 1));
      final rows = storage.files[_owner]![_chat('chat-1')]!.rows;
      expect(_ids(rows), ['m0', 'timer', 'm2']);
      expect(rows[1].positionAt, _second(1));
      expect(rows[1].text, revision.text);
      expect(rows[1].occurredAt, revision.occurredAt);
      expect(rows[1].updatedAt, revision.updatedAt);

      // A row new to the store lands by the stored anchors.
      transcripts.markChanged(
        _chat('chat-1'),
        () => [revision, _dated('n', 3)],
      );
      async.elapse(const Duration(seconds: 1));
      expect(_ids(storage.files[_owner]![_chat('chat-1')]!.rows), [
        'm0',
        'timer',
        'm2',
        'n',
      ]);
      transcripts.close();

      storage.loadGate = null;
      final relaunched = cache();
      unawaited(relaunched.restoreSession('session-1'));
      async.flushMicrotasks();
      final tail = relaunched.openTail(_chat('chat-1'));
      expect(_ids(tail), ['m0', 'timer', 'm2', 'n']);
      expect(tail[1].positionAt, _second(1));
    });
  });

  test('an anchored watcher row keeps its marker across a restart '
      '(CAN-4432)', () {
    // `_anchored` rebuilds a revision at its stored place; the rebuilt row
    // must still render as a watcher message.
    const marker = ChatWatcherFiredInfo(kind: 'Pipeline completion (Deploy)');
    RemoteChatMessage watcher(int second, {DateTime? updatedAt}) =>
        RemoteChatMessage(
          messageId: 'watcher',
          chatId: 'chat-1',
          scope: RemoteChatScope.worktree,
          role: ChatRole.user,
          status: ChatMessageStatus.complete,
          text: 'Canopy watcher fired.',
          occurredAt: _second(second),
          updatedAt: updatedAt,
          watcherFired: marker,
        );
    fakeAsync((async) {
      store('chat-1', 1, [_dated('m0', 0), watcher(1), _dated('m2', 2)]);
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));

      final revision = watcher(4, updatedAt: _second(4));
      transcripts.markChanged(_chat('chat-1'), () => [revision]);
      async.elapse(const Duration(seconds: 1));
      final stored = storage.files[_owner]![_chat('chat-1')]!.rows;
      expect(_ids(stored), ['m0', 'watcher', 'm2']);
      expect(stored[1].positionAt, _second(1));
      expect(identical(stored[1], revision), isFalse);
      expect(stored[1].watcherFired, same(marker));
      transcripts.close();

      final relaunched = cache();
      unawaited(relaunched.restoreSession('session-1'));
      async.flushMicrotasks();
      final tail = relaunched.openTail(_chat('chat-1'));
      expect(_ids(tail), ['m0', 'watcher', 'm2']);
      expect(tail[1].watcherFired, same(marker));
      expect(tail[1].text, 'Canopy watcher fired.');
    });
  });
  test('a timestamp-moving revision in the middle of a full stored tail '
      'keeps its stored anchor', () async {
    // CAN-3373 R12, at the 50-row bound.
    store('chat-1', 1, [for (var i = 0; i < 50; i++) _dated('m$i', 2 * i)]);
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    final revision = _revised('m25', 500);
    transcripts.markChanged(
      _chat('chat-1'),
      () => [revision, _dated('between', 51), _dated('newest', 200)],
    );
    await transcripts.flush();
    final rows = storage.files[_owner]![_chat('chat-1')]!.rows;
    expect(_ids(rows), [
      for (var i = 2; i < 26; i++) 'm$i',
      'between',
      for (var i = 26; i < 50; i++) 'm$i',
      'newest',
    ]);
    final timer = rows.firstWhere((row) => row.messageId == 'm25');
    expect(timer.positionAt, _second(50));
    expect(timer.text, revision.text);
    expect(timer.occurredAt, revision.occurredAt);
  });

  test('authoritative data that arrives while the load runs outranks the '
      'stored rows of a chat opened meanwhile', () {
    fakeAsync((async) {
      store('chat-1', 1, _rows(3));
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      var authoritative = true;
      transcripts.markChanged(
        _chat('chat-1'),
        () => [_row('m2'), _row('a')],
        authoritative: () => authoritative,
      );
      async.elapse(const Duration(seconds: 1));
      storage.loadGate!.complete();
      async.flushMicrotasks();
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['m2', 'a']);

      // Rows the authoritative data dropped never come back.
      authoritative = false;
      transcripts.markChanged(
        _chat('chat-1'),
        () => [_row('b')],
        authoritative: () => authoritative,
      );
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'chat-1'), ['m2', 'a', 'b']);
    });
  });

  test('an opened chat never writes fewer of its stored rows before '
      'authoritative data arrives', () async {
    // CAN-3373 R7: live rows that arrived before the open are a partial
    // view; the stored tail survives until the desktop or server confirms.
    store('chat-1', 1, _rows(50));
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    transcripts.markChanged(_chat('chat-1'), () => [_row('m50')]);
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'chat-1'), [
      for (var i = 1; i <= 50; i++) 'm$i',
    ]);

    // Without stored rows to protect, the projection is written as is.
    transcripts.openTail(_chat('fresh'));
    transcripts.markChanged(
      _chat('fresh'),
      () => [_row('f1', chatId: 'fresh'), _row('f2', chatId: 'fresh')],
    );
    await transcripts.flush();
    transcripts.markChanged(
      _chat('fresh'),
      () => [_row('f2', chatId: 'fresh')],
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'fresh'), ['f2']);
  });

  test('once authoritative data arrived, a write replaces the stored tail '
      'and keeps that tail instead', () async {
    store('chat-1', 1, _rows(3));
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    var authoritative = true;
    transcripts.markChanged(
      _chat('chat-1'),
      () => [_row('m2'), _row('a')],
      authoritative: () => authoritative,
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'chat-1'), ['m2', 'a']);

    // A reconnect starts the transcript over: rows dropped by the snapshot
    // do not come back, and the snapshot's rows are kept.
    authoritative = false;
    transcripts.markChanged(
      _chat('chat-1'),
      () => [_row('b')],
      authoritative: () => authoritative,
    );
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'chat-1'), ['m2', 'a', 'b']);
  });

  test('a chat opened while the load runs outranks every stored chat', () {
    fakeAsync((async) {
      for (var i = 0; i < 20; i++) {
        store('stored-$i', i + 1, [_row('s', chatId: 'stored-$i')]);
      }
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('open'));
      storage.loadGate!.complete();
      async.flushMicrotasks();
      expect(storage.log, contains('delete stored-0'));
      expect(storage.log, isNot(contains('delete open')));

      transcripts.markChanged(_chat('open'), () => [_row('o', chatId: 'open')]);
      async.elapse(const Duration(seconds: 1));
      expect(storage.storedIds(_owner, 'open'), ['o']);
      expect(storage.files[_owner]![_chat('open')]!.openedAt, 21);
    });
  });

  test('clearing the session fences pending writes and late loads', () {
    fakeAsync((async) {
      store('chat-1', 1, [_row('a')]);
      final transcripts = cache();
      storage.loadGate = Completer();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();

      unawaited(transcripts.clearSession());
      storage.loadGate!.complete();
      async.flushMicrotasks();
      expect(transcripts.openTail(_chat('chat-1')), isEmpty);
      expect(storage.files, isEmpty);

      // A pending write never lands after a clear.
      storage.loadGate = null;
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.openTail(_chat('chat-1'));
      transcripts.markChanged(_chat('chat-1'), () => [_row('secret')]);
      unawaited(transcripts.clearSession());
      async.elapse(const Duration(seconds: 1));
      expect(storage.log.where((op) => op.startsWith('write')), isEmpty);
      transcripts.markChanged(_chat('chat-1'), () => [_row('secret')]);
      async.elapse(const Duration(seconds: 1));
      expect(storage.files, isEmpty);
    });
  });

  test('a closed cache keeps its files and writes nothing more', () {
    fakeAsync((async) {
      store('chat-1', 1, [_row('a')]);
      final transcripts = cache();
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();
      transcripts.markChanged(_chat('chat-1'), () => [_row('b')]);
      transcripts.close();
      async.elapse(const Duration(seconds: 1));
      unawaited(transcripts.restoreSession('session-1'));
      async.flushMicrotasks();

      expect(storage.log, ['load session-1']);
      expect(storage.storedIds(_owner, 'chat-1'), ['a']);
      expect(transcripts.openTail(_chat('chat-1')), isEmpty);
    });
  });

  test('flush writes pending changes at once', () async {
    final transcripts = cache();
    await transcripts.restoreSession('session-1');
    transcripts.openTail(_chat('chat-1'));
    transcripts.markChanged(_chat('chat-1'), () => [_row('final')]);
    await transcripts.flush();
    expect(storage.storedIds(_owner, 'chat-1'), ['final']);
  });
}
