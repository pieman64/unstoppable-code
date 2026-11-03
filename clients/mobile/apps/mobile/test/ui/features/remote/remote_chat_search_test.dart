import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_search.dart';

const _wsCode = RemoteWorkspace(
  localId: 'ws-code',
  name: 'acme-web',
  type: RemoteWorkspaceType.singleRepo,
);

const _wsNotes = RemoteWorkspace(
  localId: 'ws-notes',
  name: 'Research notes',
  type: RemoteWorkspaceType.cowork,
);

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-code',
  branch: 'feature/oauth',
  label: 'otter',
);

RemoteChatSummary _summary(
  String chatId,
  String title, {
  int? order,
  String? createdAt,
  RemoteChatScope scope = RemoteChatScope.worktree,
  String? worktreeLocalId = 'wt-1',
}) => RemoteChatSummary(
  chatId: chatId,
  scope: scope,
  title: title,
  workspaceLocalId: 'ws-code',
  worktreeLocalId: worktreeLocalId,
  order: order,
  createdAt: createdAt,
);

RemoteStandaloneChat _chat(
  String id,
  String title, {
  String? projectLocalId,
  bool? archived,
}) => RemoteStandaloneChat(
  localId: id,
  projectLocalId: projectLocalId ?? '',
  title: title,
  archived: archived,
);

void main() {
  group('buildRemoteChatSearchCandidates', () {
    test('flattens worktree chats in tab order under tree workspaces', () {
      final candidates = buildRemoteChatSearchCandidates(
        workspaces: const [_wsCode],
        worktrees: const [_worktree],
        standaloneChats: const [],
        chatSummaries: [
          // Ordered tabs sort before order-less ones; ties break on
          // createdAt then chatId (desktop tab-bar order).
          _summary('chat-c', 'Late tab', createdAt: '2026-08-02T00:00:00Z'),
          _summary('chat-b', 'Second tab', order: 2),
          _summary('chat-a', 'First tab', order: 1),
          _summary('chat-d', 'Early tab', createdAt: '2026-08-01T00:00:00Z'),
        ],
      );

      expect(candidates, hasLength(4));
      expect(candidates.map((c) => c.chatId).toList(), [
        'chat-a',
        'chat-b',
        'chat-d',
        'chat-c',
      ]);
      final first = candidates.first;
      first as RemoteWorktreeChatSearchResult;
      expect(first.workspaceName, 'acme-web');
      // The worktree label wins over the branch for the row subtitle.
      expect(first.worktreeName, 'otter');
    });

    test('flat workspaces take their own and unparented active chats', () {
      final candidates = buildRemoteChatSearchCandidates(
        workspaces: const [_wsNotes, _wsCode],
        worktrees: const [],
        standaloneChats: [
          _chat('chat-own', 'Owned chat', projectLocalId: 'ws-notes'),
          _chat('chat-orphan', 'Orphan chat'),
          _chat('chat-archived', 'Old chat', archived: true),
          _chat('chat-other', 'Other project', projectLocalId: 'ws-else'),
        ],
        chatSummaries: const [],
      );

      expect(candidates.map((c) => c.chatId).toList(), [
        'chat-own',
        'chat-orphan',
      ]);
      expect(candidates.first.workspaceName, 'Research notes');
    });

    test('without a flat workspace every active chat lands in the default '
        'bucket', () {
      final candidates = buildRemoteChatSearchCandidates(
        workspaces: const [_wsCode],
        worktrees: const [],
        standaloneChats: [
          _chat('chat-own', 'Owned chat', projectLocalId: 'ws-else'),
          _chat('chat-orphan', 'Orphan chat'),
        ],
        chatSummaries: const [],
      );

      expect(candidates.map((c) => c.chatId).toList(), [
        'chat-own',
        'chat-orphan',
      ]);
      expect(candidates.first.workspaceName, 'Chats');
    });

    test(
      'tree workspaces take their own active chats after worktree chats',
      () {
        final candidates = buildRemoteChatSearchCandidates(
          workspaces: const [_wsCode, _wsNotes],
          worktrees: const [_worktree],
          standaloneChats: [
            _chat('chat-notes', 'Notes chat', projectLocalId: 'ws-notes'),
            _chat('chat-code', 'Code chat', projectLocalId: 'ws-code'),
            _chat(
              'chat-code-old',
              'Old chat',
              projectLocalId: 'ws-code',
              archived: true,
            ),
            _chat('chat-orphan', 'Orphan chat'),
          ],
          chatSummaries: [_summary('chat-tab', 'Tab chat', order: 1)],
        );

        expect(candidates.map((c) => c.chatId).toList(), [
          'chat-tab',
          'chat-code',
          'chat-notes',
          'chat-orphan',
        ]);
        final code = candidates[1];
        code as RemoteStandaloneChatSearchResult;
        expect(code.workspaceLocalId, 'ws-code');
        expect(code.workspaceName, 'acme-web');
      },
    );

    test('without a flat workspace a tree-bound chat is listed once under '
        'its workspace', () {
      final candidates = buildRemoteChatSearchCandidates(
        workspaces: const [_wsCode],
        worktrees: const [],
        standaloneChats: [
          _chat('chat-code', 'Code chat', projectLocalId: 'ws-code'),
          _chat('chat-orphan', 'Orphan chat'),
        ],
        chatSummaries: const [],
      );

      expect(candidates.map((c) => c.chatId).toList(), [
        'chat-code',
        'chat-orphan',
      ]);
      final code = candidates.first;
      code as RemoteStandaloneChatSearchResult;
      expect(code.workspaceLocalId, 'ws-code');
      expect(code.workspaceName, 'acme-web');
      expect(candidates.last.workspaceName, 'Chats');
    });

    test('standalone-scope summaries are not duplicated as worktree rows', () {
      final candidates = buildRemoteChatSearchCandidates(
        workspaces: const [_wsCode],
        worktrees: const [_worktree],
        standaloneChats: const [],
        chatSummaries: [
          _summary(
            'chat-standalone',
            'Standalone summary',
            scope: RemoteChatScope.standalone,
            worktreeLocalId: null,
          ),
        ],
      );

      expect(candidates, isEmpty);
    });
  });

  group('filterRemoteChatSearchResults', () {
    final candidates = buildRemoteChatSearchCandidates(
      workspaces: const [_wsCode],
      worktrees: const [_worktree],
      standaloneChats: const [],
      chatSummaries: [
        _summary('chat-a', 'Fix the OAuth redirect', order: 1),
        _summary('chat-b', 'Ship dark mode', order: 2),
      ],
    );

    test('is title-only and case-insensitive', () {
      final results = filterRemoteChatSearchResults(candidates, 'oauth');
      expect(results.single.chatId, 'chat-a');
    });

    test('a blank query means search-inactive and returns nothing', () {
      expect(filterRemoteChatSearchResults(candidates, ''), isEmpty);
      expect(filterRemoteChatSearchResults(candidates, '   '), isEmpty);
    });
  });
}
