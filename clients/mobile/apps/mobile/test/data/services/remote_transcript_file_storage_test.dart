// CAN-3373: the file format and I/O behind the on-device Remote Control
// transcript cache, against real temporary directories.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/chat_turn_liveness.dart';
import 'package:mobile/data/services/remote_transcript_file_storage.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';

const _owner = (accountScope: 'production:7', sessionId: 'session-1');
const _chat = (scope: RemoteChatScope.standalone, chatId: 'chat-1');

RemoteChatMessage _row(String id, {String text = 'hello'}) => RemoteChatMessage(
  messageId: id,
  chatId: 'chat-1',
  scope: RemoteChatScope.standalone,
  role: ChatRole.assistant,
  status: ChatMessageStatus.complete,
  text: text,
);

PersistedTranscript _transcript(
  List<RemoteChatMessage> rows, {
  RemoteTranscriptChat chat = _chat,
  int openedAt = 1,
}) => PersistedTranscript(chat: chat, openedAt: openedAt, rows: rows);

Future<R> _inline<R>(FutureOr<R> Function() computation) async => computation();

void main() {
  late Directory directory;
  var workerCalls = 0;

  setUp(() {
    directory = Directory.systemTemp.createTempSync('can3373-transcripts');
    workerCalls = 0;
  });
  tearDown(() {
    if (directory.existsSync()) directory.deleteSync(recursive: true);
  });

  FileRemoteTranscriptStorage storage({int? maxFileBytes}) =>
      FileRemoteTranscriptStorage(
        directory: () async => directory,
        worker: <R>(computation) {
          workerCalls += 1;
          return _inline(computation);
        },
        maxFileBytes: maxFileBytes ?? kRemoteTranscriptMaxFileBytes,
      );

  List<String> fileNames() =>
      [for (final entity in directory.listSync()) entity.uri.pathSegments.last]
        ..sort();

  test('cached continuation retains running timer evidence', () async {
    final files = storage();
    files.write(
      _owner,
      _transcript([
        const RemoteChatMessage(
          messageId: 'timer',
          chatId: 'chat-1',
          role: ChatRole.system,
          status: ChatMessageStatus.complete,
          text: '',
          parts: [
            ChatPart(kind: 'turn_timer', data: {'startedAt': 1000}),
          ],
        ),
        RemoteChatMessage.fromWireJson({
          'messageId': 'steering',
          'chatId': 'chat-1',
          'role': 'user',
          'status': 'complete',
          'text': 'Keep checking',
          'continuesTurn': true,
        }),
        _row('interim'),
      ]),
    );
    await files.flush();
    expect(isChatTurnRunning((await files.load(_owner)).single.rows), isTrue);
  });

  test('round-trips every persisted field', () async {
    final rich = RemoteChatMessage(
      messageId: 'm1',
      chatId: 'chat-1',
      scope: RemoteChatScope.standalone,
      role: ChatRole.user,
      status: ChatMessageStatus.streaming,
      text: 'Ünïcode ✓ and "quotes"',
      parts: const [
        ChatPart(
          kind: 'tool_use',
          toolFamily: 'bash',
          data: {
            'toolName': 'Bash',
            'input': {
              'command': 'ls',
              'flags': [1, 2.5, true, null],
            },
          },
        ),
        ChatPart(kind: 'thinking'),
      ],
      occurredAt: DateTime.utc(2026, 10, 4, 12, 30, 1, 2, 3),
      updatedAt: DateTime(2026, 10, 4, 12, 31),
      orderingAt: DateTime.utc(2026, 10, 4, 12, 29),
      attachments: const [
        ChatMessageAttachment(
          attachmentId: 'att-1',
          filename: 'shot.png',
          mediaType: 'image/png',
          size: 1234,
        ),
      ],
    );
    const bare = RemoteChatMessage(
      messageId: 'm2',
      chatId: 'chat-1',
      role: null,
      status: null,
      text: '',
    );
    final files = storage();
    files.write(_owner, _transcript([rich, bare], openedAt: 7));
    await files.flush();

    final loaded = (await files.load(_owner)).single;
    expect(loaded.chat, _chat);
    expect(loaded.openedAt, 7);
    final [m1, m2] = loaded.rows;
    expect(m1.messageId, 'm1');
    expect(m1.scope, RemoteChatScope.standalone);
    expect(m1.role, ChatRole.user);
    expect(m1.status, ChatMessageStatus.streaming);
    expect(m1.text, rich.text);
    expect(m1.parts.map((p) => (p.kind, p.toolFamily)), [
      ('tool_use', 'bash'),
      ('thinking', null),
    ]);
    expect(m1.parts.first.data, equals(rich.parts.first.data));
    expect(m1.parts.last.data, isNull);
    expect(m1.occurredAt, rich.occurredAt);
    expect(m1.occurredAt!.isUtc, isTrue);
    expect(m1.updatedAt, rich.updatedAt);
    expect(m1.updatedAt!.isUtc, isFalse);
    expect(m1.orderingAt, rich.orderingAt);
    expect(m1.positionAt, rich.positionAt);
    expect(
      m1.attachments.map(
        (a) => (a.attachmentId, a.filename, a.mediaType, a.size),
      ),
      [('att-1', 'shot.png', 'image/png', 1234)],
    );
    expect(m2.scope, isNull);
    expect(m2.role, isNull);
    expect(m2.status, isNull);
    expect(m2.occurredAt, isNull);
  });

  test('round-trips the watcher marker and reads rows stored before it '
      '(CAN-4432)', () async {
    RemoteChatMessage user(
      String id, {
      ChatWatcherFiredInfo? watcherFired,
      List<ChatPart> parts = const [],
    }) => RemoteChatMessage(
      messageId: id,
      chatId: 'chat-1',
      role: ChatRole.user,
      status: ChatMessageStatus.complete,
      text: 'Canopy watcher fired.',
      parts: parts,
      watcherFired: watcherFired,
    );
    final rows = [
      user(
        'merged',
        watcherFired: const ChatWatcherFiredInfo(
          kind: 'Multiple watchers fired (2)',
          combinedWatchers: [
            ChatWatcherFiredEntry(kind: 'Deploy', text: 'one'),
            ChatWatcherFiredEntry(kind: 'Notes', text: 'two'),
          ],
        ),
      ),
      // An older app wrote only the parts; the marker is in prompt_source.
      user(
        'part-only',
        parts: const [
          ChatPart(
            kind: 'prompt_source',
            data: {
              'source': 'automated',
              'watcherFired': {'kind': 'Pipeline completion (Lint)'},
            },
          ),
        ],
      ),
      user('plain'),
    ];
    final files = storage();
    files.write(_owner, _transcript(rows));
    await files.flush();

    final [merged, partOnly, plain] = (await files.load(_owner)).single.rows;
    expect(merged.watcherFired?.kind, 'Multiple watchers fired (2)');
    expect(
      [
        for (final entry in merged.watcherFired!.combinedWatchers!)
          (entry.kind, entry.text),
      ],
      [('Deploy', 'one'), ('Notes', 'two')],
    );
    expect(partOnly.watcherFired?.kind, 'Pipeline completion (Lint)');
    expect(plain.watcherFired, isNull);
    final stored = jsonDecode(
      File('${directory.path}/${fileNames().single}').readAsStringSync(),
    );
    final storedRows = (stored as Map<String, dynamic>)['rows'] as List;
    expect(
      [for (final row in storedRows) (row as Map).containsKey('watcherFired')],
      [true, false, false],
    );
  });
  test('runs on a worker isolate by default', () async {
    final files = FileRemoteTranscriptStorage(directory: () async => directory);
    files.write(_owner, _transcript([_row('m1')]));
    final loaded = await files.load(_owner);
    expect(loaded.single.rows.single.messageId, 'm1');
  });

  test('file names reveal neither the account, the session, nor the chat', () {
    final name = remoteTranscriptFileName(_owner, _chat);
    expect(name, matches(RegExp(r'^[0-9a-f]{64}\.json$')));
    expect(
      remoteTranscriptFileName((
        accountScope: 'staging:7',
        sessionId: 'session-1',
      ), _chat),
      isNot(name),
    );
  });

  test('stores nothing that identifies a cursor or credential', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('m1')]));
    await files.flush();
    final json =
        jsonDecode(
              File(
                '${directory.path}/${fileNames().single}',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    expect(json.keys.toSet(), {
      'version',
      'account',
      'session',
      'scope',
      'chatId',
      'openedAt',
      'rows',
    });
  });

  test('another owner, a corrupt file, an old version, a renamed file, an '
      'empty tail, and interrupted temp files are deleted on load', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('mine')]));
    files.write((
      accountScope: 'production:8',
      sessionId: 'session-1',
    ), _transcript([_row('other account')]));
    files.write((
      accountScope: 'production:7',
      sessionId: 'session-0',
    ), _transcript([_row('old session')]));
    await files.flush();
    final mine = remoteTranscriptFileName(_owner, _chat);
    final mineJson =
        jsonDecode(File('${directory.path}/$mine').readAsStringSync())
            as Map<String, dynamic>;
    void put(String name, String contents) =>
        File('${directory.path}/$name').writeAsStringSync(contents);
    put('corrupt.json', '{"version":1,');
    put(
      remoteTranscriptFileName(_owner, (
        scope: RemoteChatScope.worktree,
        chatId: 'v0',
      )),
      jsonEncode({...mineJson, 'version': 0, 'chatId': 'v0'}),
    );
    put('renamed.json', jsonEncode(mineJson));
    put(
      remoteTranscriptFileName(_owner, (
        scope: RemoteChatScope.standalone,
        chatId: 'empty',
      )),
      jsonEncode({...mineJson, 'chatId': 'empty', 'rows': []}),
    );
    put('$mine.tmp', '{"partial');

    final loaded = await files.load(_owner);
    expect(loaded.map((t) => t.rows.single.messageId), ['mine']);
    expect(fileNames(), [mine]);
  });

  test('a file that cannot be read now is kept for later', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('m1')]));
    await files.flush();
    final file = File('${directory.path}/${fileNames().single}');
    // Stands in for a protected file while the device is locked.
    Process.runSync('chmod', ['000', file.path]);
    addTearDown(() => Process.runSync('chmod', ['644', file.path]));

    expect(await files.load(_owner), isEmpty);
    expect(file.existsSync(), isTrue);
    Process.runSync('chmod', ['644', file.path]);
    expect((await files.load(_owner)).single.rows.single.messageId, 'm1');
  });

  test('a row that cannot be read invalidates the whole file', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('m1'), _row('m2')]));
    await files.flush();
    final file = File('${directory.path}/${fileNames().single}');
    final json = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    (json['rows'] as List)[0] = {'messageId': 'm1'};
    file.writeAsStringSync(jsonEncode(json));

    expect(await files.load(_owner), isEmpty);
    expect(fileNames(), isEmpty);
  });

  test('keeps the newest messages that fit the byte limit', () async {
    final rows = [for (var i = 0; i < 5; i++) _row('m$i', text: 'x' * 300)];
    // Exactly the two newest rows fit.
    final limit = encodeRemoteTranscript(
      _owner,
      _transcript(rows.sublist(3)),
    )!.length;
    final files = storage(maxFileBytes: limit);
    files.write(_owner, _transcript(rows));
    await files.flush();
    final loaded = (await files.load(_owner)).single.rows;
    expect(loaded.map((m) => m.messageId), ['m3', 'm4']);
    expect(File('${directory.path}/${fileNames().single}').lengthSync(), limit);
  });

  test('a single message larger than the limit stores nothing', () async {
    final files = storage(maxFileBytes: 1000);
    files.write(_owner, _transcript([_row('small')]));
    await files.flush();
    expect(fileNames(), hasLength(1));
    files.write(_owner, _transcript([_row('huge', text: 'x' * 2000)]));
    await files.flush();
    expect(fileNames(), isEmpty);
    expect(await files.load(_owner), isEmpty);
  });

  test('writes issued before the queue runs coalesce to the latest', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('first')]));
    files.write(_owner, _transcript([_row('second')]));
    files.write(_owner, _transcript([_row('third')]));
    await files.flush();
    expect(workerCalls, 1);
    final loaded = await files.load(_owner);
    expect(loaded.single.rows.single.messageId, 'third');
  });

  test('delete and clear land after earlier writes, and clear keeps the '
      'protected directory', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('m1')]));
    files.delete(_owner, _chat);
    await files.flush();
    expect(fileNames(), isEmpty);

    files.write(_owner, _transcript([_row('m1')]));
    await files.flush();
    files.write(_owner, _transcript([_row('m2')]));
    await files.clear();
    expect(directory.existsSync(), isTrue);
    expect(fileNames(), isEmpty);

    files.write(_owner, _transcript([_row('m3')]));
    await files.flush();
    expect(fileNames(), hasLength(1));
  });

  test(
    'a write after a delete is not absorbed by the write before it',
    () async {
      // CAN-3373 R11: coalescing never crosses a delete.
      final files = storage();
      files.write(_owner, _transcript([_row('a')]));
      files.delete(_owner, _chat);
      files.write(_owner, _transcript([_row('b')]));
      await files.flush();
      expect((await files.load(_owner)).single.rows.single.messageId, 'b');
    },
  );

  test('a write after a clear is not absorbed by the write before it, and '
      'the earlier write never lands', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('a')]));
    unawaited(files.clear());
    files.write(_owner, _transcript([_row('b')]));
    await files.flush();
    // The clear and the write of `b`; `a` was cleared before it ran.
    expect(workerCalls, 2);
    expect((await files.load(_owner)).single.rows.single.messageId, 'b');
  });

  test('a load reads the writes issued before it, not those after', () async {
    final files = storage();
    files.write(_owner, _transcript([_row('a')]));
    final loading = files.load(_owner);
    files.write(_owner, _transcript([_row('b')]));
    expect((await loading).single.rows.single.messageId, 'a');
    await files.flush();
    expect((await files.load(_owner)).single.rows.single.messageId, 'b');
  });

  test('a write dropped while the directory is unavailable leaves later '
      'writes queued', () async {
    var attempts = 0;
    final files = FileRemoteTranscriptStorage(
      directory: () async {
        attempts += 1;
        if (attempts == 1) throw const FileSystemException('protection');
        return directory;
      },
      worker: _inline,
    );
    files.write(_owner, _transcript([_row('a')]));
    files.delete(_owner, _chat);
    files.write(_owner, _transcript([_row('b')]));
    await files.flush();
    expect((await files.load(_owner)).single.rows.single.messageId, 'b');
  });

  test('an unavailable directory stores nothing and never throws', () async {
    final files = FileRemoteTranscriptStorage(
      directory: () async => throw const FileSystemException('protection'),
      worker: _inline,
    );
    files.write(_owner, _transcript([_row('m1')]));
    await files.flush();
    expect(await files.load(_owner), isEmpty);
    await files.clear();
    expect(fileNames(), isEmpty);
  });

  test(
    'a directory unavailable once does not hold back later writes',
    () async {
      var attempts = 0;
      final files = FileRemoteTranscriptStorage(
        directory: () async {
          attempts += 1;
          if (attempts == 1) throw const FileSystemException('protection');
          return directory;
        },
        worker: _inline,
      );
      files.write(_owner, _transcript([_row('m1')]));
      await files.flush();
      expect(fileNames(), isEmpty);

      files.write(_owner, _transcript([_row('m2')]));
      await files.flush();
      expect((await files.load(_owner)).single.rows.single.messageId, 'm2');
    },
  );

  test('a failing worker is a cache miss', () async {
    final files = FileRemoteTranscriptStorage(
      directory: () async => directory,
      worker: <R>(computation) async => throw StateError('isolate'),
    );
    files.write(_owner, _transcript([_row('m1')]));
    expect(await files.load(_owner), isEmpty);
  });
}
