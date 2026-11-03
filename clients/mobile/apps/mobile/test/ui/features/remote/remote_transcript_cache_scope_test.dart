// CAN-3373: persisted Remote Control chat tails belong to one signed-in
// account and are deleted when it stops being the signed-in one.
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/repositories/remote_transcript_cache.dart';
import 'package:mobile/data/services/remote_transcript_storage.dart';
import 'package:mobile/ui/features/remote/views/remote_transcript_cache_scope.dart';

import '../../../support/memory_remote_transcript_storage.dart';

final class _Account extends ChangeNotifier {
  String? scope;
  bool signedOut = false;

  void set({String? scope, bool signedOut = false}) {
    this.scope = scope;
    this.signedOut = signedOut;
    notifyListeners();
  }
}

void main() {
  late MemoryRemoteTranscriptStorage storage;
  late _Account account;
  late int purges;
  BuildContext? below;

  setUp(() {
    storage = MemoryRemoteTranscriptStorage();
    account = _Account();
    purges = 0;
    below = null;
  });

  Widget scope() => RemoteTranscriptCacheScope(
    account: account,
    accountScope: () => account.scope,
    signedOut: () => account.signedOut,
    create: (accountScope) =>
        RemoteTranscriptCache(storage: storage, accountScope: accountScope),
    purge: () {
      purges += 1;
      return storage.clear();
    },
    child: Builder(
      builder: (context) {
        below = context;
        return const SizedBox();
      },
    ),
  );

  RemoteTranscriptCache? cache() => maybeRemoteTranscriptCache(below!);

  /// Stores one tail for [accountScope] the way an earlier launch did.
  void storeTail(String accountScope) {
    final chat = (scope: RemoteChatScope.standalone, chatId: 'chat-1');
    storage.files[(accountScope: accountScope, sessionId: 'session-1')] = {
      chat: PersistedTranscript(
        chat: chat,
        openedAt: 1,
        rows: const [
          RemoteChatMessage(
            messageId: 'm1',
            chatId: 'chat-1',
            role: ChatRole.assistant,
            status: ChatMessageStatus.complete,
            text: 'Secret',
          ),
        ],
      ),
    };
  }

  testWidgets('a restoring launch keeps the tails; the account gets a cache', (
    tester,
  ) async {
    storeTail('production:7');
    await tester.pumpWidget(scope());
    expect(cache(), isNull);
    expect(purges, 0);

    account.set(scope: 'production:7');
    expect(cache()?.accountScope, 'production:7');
    // Every auth notification reaches the scope; the same account keeps it.
    final first = cache();
    account.set(scope: 'production:7');
    expect(cache(), same(first));
    expect(purges, 0);
    expect(storage.files, isNotEmpty);
  });

  testWidgets('signing out deletes every tail, once', (tester) async {
    account.scope = 'production:7';
    storeTail('production:7');
    await tester.pumpWidget(scope());
    final previous = cache()!;

    account.set(signedOut: true);
    expect(cache(), isNull);
    expect(purges, 1);
    expect(storage.files, isEmpty);
    account.set(signedOut: true);
    expect(purges, 1);

    // The released cache no longer serves or writes anything.
    await previous.restoreSession('session-1');
    expect(storage.log, isNot(contains('load session-1')));
  });

  testWidgets('another account replaces the first without a sign-out', (
    tester,
  ) async {
    account.scope = 'production:7';
    storeTail('production:7');
    await tester.pumpWidget(scope());

    account.set(scope: 'production:8');
    expect(cache()?.accountScope, 'production:8');
    expect(purges, 1);
    expect(storage.files, isEmpty);
  });

  testWidgets('a launch that finds nobody signed in deletes stale tails', (
    tester,
  ) async {
    storeTail('production:7');
    account.signedOut = true;
    await tester.pumpWidget(scope());
    expect(purges, 1);
    expect(storage.files, isEmpty);
  });

  testWidgets('tearing the scope down for a new environment deletes them', (
    tester,
  ) async {
    account.scope = 'production:7';
    storeTail('production:7');
    await tester.pumpWidget(scope());
    await tester.pumpWidget(const SizedBox());
    expect(purges, 1);
    expect(storage.files, isEmpty);
  });
}
