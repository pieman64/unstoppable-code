import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/services/push_deep_link.dart';

void main() {
  final workspace = RemoteWorkspace(
    localId: 'ws-1',
    name: 'workspace',
    type: RemoteWorkspaceType.singleRepo,
  );

  final worktree = RemoteWorktree(
    localId: 'wt-1',
    workspaceLocalId: 'ws-1',
    branch: 'feature/x',
  );

  PushDeepLinkTarget resolve(
    Map<String, String> data, {
    RemoteWorktree? Function(String chatId)? worktreeForChatId,
  }) => resolvePushDeepLink(
    data: data,
    workspaces: [workspace],
    worktreesFor: (id) => id == 'ws-1' ? [worktree] : const [],
    worktreeForChatId: worktreeForChatId ?? (id) => null,
    standaloneChatById: (id) => id == 'chat-s'
        ? RemoteStandaloneChat(
            localId: 'chat-s',
            projectLocalId: 'p1',
            title: 'Chat',
          )
        : null,
  );

  test('worktree id resolves to a worktree chat target with chat id', () {
    final target = resolve({'worktreeId': 'wt-1', 'clientChatId': 'chat-9'});
    expect(target, isA<PushWorktreeChatTarget>());
    final worktreeTarget = target as PushWorktreeChatTarget;
    expect(worktreeTarget.worktree.localId, 'wt-1');
    expect(worktreeTarget.chatId, 'chat-9');
  });

  test('empty clientChatId maps to null chat id', () {
    final target = resolve({'worktreeId': 'wt-1', 'clientChatId': ''});
    expect((target as PushWorktreeChatTarget).chatId, isNull);
  });

  test('unknown worktree falls through to standalone chat lookup', () {
    final target = resolve({'worktreeId': 'nope', 'clientChatId': 'chat-s'});
    expect(target, isA<PushStandaloneChatTarget>());
  });

  test('nothing resolvable falls back to feed', () {
    expect(resolve({}), isA<PushFeedFallback>());
    expect(
      resolve({'worktreeId': 'nope', 'clientChatId': 'nope'}),
      isA<PushFeedFallback>(),
    );
  });

  test('production shape: server-UUID worktreeId never matches a local id, '
      'resolution succeeds via worktreeForChatId', () {
    // This mirrors the real payload the web push sender produces
    // (apps/web/src/lib/push/run-lifecycle-notifier.ts): `worktreeId` is
    // the server-minted `Worktree.externalId` (a UUID), which lives in a
    // completely different namespace than the desktop's local worktree
    // ids (`RemoteWorktree.localId`, e.g. `wt-1`). The direct worktreeId
    // match must NOT fire for this payload — resolution has to go through
    // `clientChatId` -> worktreeForChatId instead, which is keyed by the
    // client's own hydrated chat-summary projection and never touches the
    // server UUID at all.
    const serverWorktreeUuid = '3fa2b1c4-9e7d-4a6b-8f1c-2d5e6a7b8c9d';
    final target = resolve({
      'worktreeId': serverWorktreeUuid,
      'clientChatId': 'chat-9',
    }, worktreeForChatId: (id) => id == 'chat-9' ? worktree : null);
    expect(target, isA<PushWorktreeChatTarget>());
    final worktreeTarget = target as PushWorktreeChatTarget;
    // Resolved worktree is the client's own local worktree, not anything
    // derived from the server UUID above.
    expect(worktreeTarget.worktree.localId, 'wt-1');
    expect(worktreeTarget.chatId, 'chat-9');
  });

  test('worktreeForChatId only matches its own chat id, unrelated chats still '
      'fall through to feed', () {
    final target = resolve({
      'worktreeId': 'nope',
      'clientChatId': 'chat-other',
    }, worktreeForChatId: (id) => id == 'chat-9' ? worktree : null);
    expect(target, isA<PushFeedFallback>());
  });

  test('unknown push type is ignored: routing still uses ids only', () {
    // The server composes the whole notification and rides the category on
    // `type` purely for logging and any future client treatment. Phase 1 adds
    // categories mobile has never seen (`needs_input`, `blocked`), so an
    // unrecognized `type` must change nothing about resolution — a client that
    // routed on `type` would silently stop deep-linking the most urgent
    // notifications the system can send.
    final target = resolve({
      'type': 'needs_input',
      'worktreeId': 'wt-1',
      'clientChatId': 'chat-9',
    });
    expect(target, isA<PushWorktreeChatTarget>());
    final worktreeTarget = target as PushWorktreeChatTarget;
    expect(worktreeTarget.worktree.localId, 'wt-1');
    expect(worktreeTarget.chatId, 'chat-9');
  });

  test('unknown push type with unresolvable ids still falls back to feed', () {
    expect(
      resolve({'type': 'some_future_category', 'worktreeId': 'nope'}),
      isA<PushFeedFallback>(),
    );
  });
}
