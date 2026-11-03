import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/chat_drafts.dart';
import 'package:mobile/data/services/chat_draft_store.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory root;
  final now = DateTime.utc(2026, 10, 3, 12);
  const target = CloudChatDraftTarget('c1');

  setUp(() async {
    root = await Directory.systemTemp.createTemp('chat-draft-store-test-');
  });
  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  Future<FileChatDraftStore> open({String scope = 'production:7'}) =>
      FileChatDraftStore.open(
        directory: root,
        accountScope: scope,
        now: () => now,
      );

  File fileFor(String scope) =>
      File(p.join(root.path, 'chat-drafts', chatDraftFileName(scope)));

  UnsentRecord record(String id) => UnsentRecord(
    id: id,
    surface: 'rc',
    targetKey: 'rc:sa:chat-1',
    text: 'hello',
    createdAt: now,
    status: UnsentStatus.sending,
  );

  test(
    'adoption saves drafts and unsent metadata before clearing guest',
    () async {
      final guest = await open(scope: 'guest');
      final account = await open(scope: 'account');
      guest.setDraft(target, 'guest text');
      final unsent = UnsentRecord(
        id: 'request-1',
        surface: 'cloud',
        targetKey: target.key,
        text: 'failed prompt',
        createdAt: now,
        status: UnsentStatus.notSent,
        error: 'offline',
        extra: {'requestId': 'request-1', 'workspaceId': 'ws'},
      );
      guest.putUnsent(unsent);
      await guest.flush();
      final adoption = account.adoptGuestDrafts(guest);
      final source = await open(scope: 'guest');
      final destination = await open(scope: 'account');
      expect([
        source.draftFor(target),
        destination.draftFor(target),
      ], contains('guest text'));
      await adoption;
      final reopened = await open(scope: 'account');
      expect(reopened.draftFor(target), 'guest text');
      expect(reopened.unsentById('request-1')?.toJson(), unsent.toJson());
      expect((await open(scope: 'guest')).draftFor(target), '');
      expect((await open(scope: 'guest')).unsentById('request-1'), isNull);
      await guest.flush();
    },
  );

  test('failed destination writes retain the durable guest copy', () async {
    final guest = await open(scope: 'guest');
    final account = await open(scope: 'account');
    guest.setDraft(target, 'keep me');
    await guest.flush();
    await Directory(fileFor('account').path).create();
    await account.adoptGuestDrafts(guest);
    await account.flush();
    await guest.flush();
    expect((await open(scope: 'guest')).draftFor(target), 'keep me');
  });

  test(
    'failed destination open retains guest drafts during fallback adoption',
    () async {
      final guest = await open(scope: 'guest');
      guest.setDraft(target, 'keep me');
      await guest.flush();
      await Directory(fileFor('account').path).create();
      await expectLater(
        open(scope: 'account'),
        throwsA(isA<FileSystemException>()),
      );
      final fallback = InMemoryChatDraftStore();
      await fallback.adoptGuestDrafts(guest);
      await guest.flush();
      expect(fallback.draftFor(target), 'keep me');
      expect((await open(scope: 'guest')).draftFor(target), 'keep me');
    },
  );

  test('a reopened store restores drafts and unsent records', () async {
    final store = await open();
    store.setDraft(target, 'typed text');
    store.putUnsent(record('r1'));
    await store.flush();

    final reopened = await open();
    expect(reopened.draftFor(target), 'typed text');
    expect(reopened.unsentById('r1')?.text, 'hello');
  });

  test('draft writes are debounced and flush writes them now', () async {
    final timers = <void Function()>[];
    final store = await FileChatDraftStore.open(
      directory: root,
      accountScope: 'production:7',
      now: () => now,
      timer: (_, callback) {
        timers.add(callback);
        return Timer(const Duration(days: 1), () {});
      },
    );
    store.setDraft(target, 'a');
    store.setDraft(target, 'ab');
    expect(fileFor('production:7').existsSync(), isFalse);
    expect(timers, isNotEmpty);
    await store.flush();
    final json = jsonDecode(fileFor('production:7').readAsStringSync());
    expect(json['drafts']['cloud:chat:c1']['text'], 'ab');
  });

  test('unsent writes are immediate', () async {
    final timers = <void Function()>[];
    final store = await FileChatDraftStore.open(
      directory: root,
      accountScope: 'production:7',
      now: () => now,
      timer: (_, callback) {
        timers.add(callback);
        return Timer(const Duration(days: 1), () {});
      },
    );
    store.putUnsent(record('r1'));
    // Wait for the file to be written without calling flush().
    for (int attempt = 0; attempt < 100; attempt++) {
      if (fileFor('production:7').existsSync()) break;
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(fileFor('production:7').existsSync(), isTrue);
    final json = jsonDecode(fileFor('production:7').readAsStringSync());
    expect(json['unsent'], isNotEmpty);
  });

  test('accounts are isolated', () async {
    final a = await open(scope: 'production:7');
    a.setDraft(target, 'mine');
    await a.flush();
    final b = await open(scope: 'staging:7');
    expect(b.draftFor(target), '');
  });

  test('a corrupt file is set aside and the store starts empty', () async {
    final file = fileFor('production:7');
    await file.parent.create(recursive: true);
    await file.writeAsString('{not json');
    final store = await open();
    expect(store.draftFor(target), '');
    expect(File('${file.path}.corrupt').existsSync(), isTrue);
  });

  test('an unknown version is set aside', () async {
    final file = fileFor('production:7');
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode({'v': 99}));
    final store = await open();
    expect(store.state.drafts, isEmpty);
    expect(File('${file.path}.corrupt').existsSync(), isTrue);
  });

  test(
    'an unreadable file fails open and is left untouched',
    () async {
      final file = fileFor('production:7');
      await file.parent.create(recursive: true);
      const saved = '{"v":1,"drafts":{},"unsent":{}}';
      await file.writeAsString(saved);
      await Process.run('chmod', ['000', file.path]);
      addTearDown(() => Process.run('chmod', ['600', file.path]));

      await expectLater(open(), throwsA(isA<FileSystemException>()));

      await Process.run('chmod', ['600', file.path]);
      expect(file.readAsStringSync(), saved);
      expect(File('${file.path}.corrupt').existsSync(), isFalse);
    },
    skip: Platform.isWindows ? 'chmod is POSIX only' : false,
  );

  test('a directory at the file path fails open', () async {
    final file = fileFor('production:7');
    await Directory(file.path).create(recursive: true);

    await expectLater(open(), throwsA(isA<FileSystemException>()));
    expect(Directory(file.path).existsSync(), isTrue);
  });

  test('a file that is not UTF-8 is set aside as corrupt', () async {
    final file = fileFor('production:7');
    await file.parent.create(recursive: true);
    await file.writeAsBytes([0xff, 0xfe, 0x00, 0x7b]);
    final store = await open();
    expect(store.state.drafts, isEmpty);
    expect(File('${file.path}.corrupt').existsSync(), isTrue);
  });

  test('large draft round-trips', () async {
    final big = 'x' * 200 * 1024;
    final store = await open();
    store.setDraft(target, big);
    await store.flush();
    final reopened = await open();
    expect(reopened.draftFor(target).length, big.length);
  });

  test('write failure keeps state and retries', () async {
    final store = await open();
    // Replace the directory with a file so writes fail.
    final dir = Directory(p.join(root.path, 'chat-drafts'));
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
    await File(dir.path).writeAsString('blocker');
    store.setDraft(target, 'kept');
    expect(await store.flush(), isFalse);
    expect(store.lastWriteError, isNotNull);
    expect(store.draftFor(target), 'kept');

    await File(dir.path).delete();
    store.setDraft(target, 'kept again');
    expect(await store.flush(), isTrue);
    expect(store.lastWriteError, isNull);
    final reopened = await open();
    expect(reopened.draftFor(target), 'kept again');
  });

  test('flush() completes normally after write failure', () async {
    final store = await open();
    store.setDraft(target, 'text1');
    // Create a blocker file to cause the first flush to fail
    final dir = Directory(p.join(root.path, 'chat-drafts'));
    if (await dir.exists()) {
      await dir.delete(recursive: true);
    }
    await File(dir.path).writeAsString('blocker');
    // flush() should complete normally even though the write fails
    expect(await store.flush(), isFalse);
    expect(store.lastWriteError, isNotNull);
    // Remove the blocker and flush again
    await File(dir.path).delete();
    expect(await store.flush(), isTrue);
    expect(store.lastWriteError, isNull);
    // Verify the data was written
    final reopened = await open();
    expect(reopened.draftFor(target), 'text1');
  });
}
