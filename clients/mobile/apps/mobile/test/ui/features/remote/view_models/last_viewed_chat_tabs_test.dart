import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/features/remote/view_models/last_viewed_chat_tabs.dart';
import 'package:mobile/ui/features/remote/view_models/remote_identity.dart';

void main() {
  group('LastViewedChatTabs', () {
    final worktree = remoteWorktreeKey('ws-1', 'wt-1');
    final otherWorktree = remoteWorktreeKey('ws-1', 'wt-2');
    late int generation;
    late LastViewedChatTabs tabs;
    late Set<String> listed;

    String? chatIdFor(RemoteWorktreeKey key) =>
        tabs.chatIdFor(key, isListed: listed.contains);

    setUp(() {
      generation = 1;
      listed = {};
      tabs = LastViewedChatTabs(sessionGeneration: () => generation);
    });

    test('remembers nothing until a tab is recorded', () {
      expect(chatIdFor(worktree), isNull);
    });

    test('returns the recorded tab and keeps the latest one', () {
      tabs.record(worktree, 'chat-a');
      expect(chatIdFor(worktree), 'chat-a');

      tabs.record(worktree, 'chat-b');
      expect(chatIdFor(worktree), 'chat-b');
    });

    test('keeps a separate tab for each worktree', () {
      tabs.record(worktree, 'chat-a');
      tabs.record(otherWorktree, 'chat-c');

      expect(chatIdFor(worktree), 'chat-a');
      expect(chatIdFor(otherWorktree), 'chat-c');
      expect(chatIdFor(remoteWorktreeKey('ws-2', 'wt-1')), isNull);
    });

    test('a new session generation forgets every tab', () {
      tabs.record(worktree, 'chat-a');
      tabs.record(otherWorktree, 'chat-c');

      generation++;
      expect(chatIdFor(worktree), isNull);
      expect(chatIdFor(otherWorktree), isNull);

      tabs.record(worktree, 'chat-b');
      expect(chatIdFor(worktree), 'chat-b');
    });

    test('a tab recorded in an old session is not read in the new one', () {
      tabs.record(worktree, 'chat-a');
      generation++;
      tabs.record(otherWorktree, 'chat-c');

      expect(chatIdFor(worktree), isNull);
      expect(chatIdFor(otherWorktree), 'chat-c');
    });

    test('a pending tab is remembered once it is listed', () {
      tabs.record(worktree, 'chat-b');
      tabs.record(worktree, 'chat-new', pending: true);
      expect(chatIdFor(worktree), 'chat-b');

      listed = {'chat-new'};
      expect(chatIdFor(worktree), 'chat-new');

      listed = {};
      expect(chatIdFor(worktree), 'chat-new');
    });

    test('a pending tab that is never listed is not remembered', () {
      tabs.record(worktree, 'chat-b');
      tabs.record(worktree, 'chat-failed', pending: true);

      listed = {'chat-b'};
      expect(chatIdFor(worktree), 'chat-b');
    });

    test('a newer recorded tab replaces a pending tab', () {
      tabs.record(worktree, 'chat-new', pending: true);
      tabs.record(worktree, 'chat-b');

      listed = {'chat-new', 'chat-b'};
      expect(chatIdFor(worktree), 'chat-b');
    });

    test('a pending tab only affects its worktree', () {
      tabs.record(worktree, 'chat-b');
      tabs.record(otherWorktree, 'chat-new', pending: true);

      listed = {'chat-new'};
      expect(chatIdFor(worktree), 'chat-b');
      expect(chatIdFor(otherWorktree), 'chat-new');
    });

    test('a new session generation forgets a pending tab', () {
      tabs.record(worktree, 'chat-b');
      tabs.record(worktree, 'chat-new', pending: true);

      generation++;
      listed = {'chat-new'};
      expect(chatIdFor(worktree), isNull);
    });
  });
}
