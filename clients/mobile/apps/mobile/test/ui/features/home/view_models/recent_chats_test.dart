import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/home/view_models/recent_chats.dart';

const _worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-code',
  branch: 'feature/oauth',
  label: 'otter',
);

CloudChatSummary _cloud(String id, String title, {required int createdAtMs}) =>
    CloudChatSummary(
      externalId: id,
      title: title,
      taskChatExternalId: null,
      modelDefinitionId: null,
      thinkingLevel: null,
      coreAgentSessionId: 'session-$id',
      createdAtMs: createdAtMs,
    );

CloudWorkspaceSummary _workspace(List<CloudChatSummary> chats) =>
    CloudWorkspaceSummary(
      retainedChatCount: 0,
      deletionRetentionDays: 30,
      externalId: 'cloud-ws',
      name: 'Mobile App',
      description: null,
      color: null,
      coreSandboxId: null,
      createdAtMs: 0,
      chats: chats,
    );

RemoteChatSummary _summary(
  String chatId,
  String title, {
  String? lastMessageAt,
  String? createdAt,
  bool? hasUnread,
  List<AskUserQuestionState>? pendingQuestions,
  String worktreeLocalId = 'wt-1',
}) => RemoteChatSummary(
  chatId: chatId,
  scope: RemoteChatScope.worktree,
  title: title,
  workspaceLocalId: 'ws-code',
  worktreeLocalId: worktreeLocalId,
  createdAt: createdAt,
  lastMessageAt: lastMessageAt,
  hasUnread: hasUnread,
  pendingQuestions: pendingQuestions,
);

RemoteStandaloneChat _standalone(
  String id,
  String title, {
  String? lastMessageAt,
  bool? hasUnread,
  bool? archived,
}) => RemoteStandaloneChat(
  localId: id,
  projectLocalId: 'ws-notes',
  title: title,
  lastMessageAt: lastMessageAt,
  hasUnread: hasUnread,
  archived: archived,
);

void main() {
  group('buildRecentChats', () {
    test('interweaves cloud and Remote Control chats by latest activity', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            _cloud(
              'c-old',
              'Old cloud chat',
              createdAtMs: DateTime.utc(2026, 9, 1).millisecondsSinceEpoch,
            ),
            _cloud(
              'c-new',
              'New cloud chat',
              createdAtMs: DateTime.utc(2026, 9, 20).millisecondsSinceEpoch,
            ),
          ]),
        ],
        remoteWorktrees: const [_worktree],
        remoteChatSummaries: [
          _summary(
            'r-mid',
            'Fix the OAuth redirect',
            lastMessageAt: '2026-09-10T10:00:00Z',
          ),
        ],
        remoteStandaloneChats: [
          _standalone(
            's-newest',
            'Research notes',
            lastMessageAt: '2026-09-25T10:00:00Z',
          ),
        ],
      );

      expect(entries.map((e) => e.title), [
        'Research notes',
        'New cloud chat',
        'Fix the OAuth redirect',
        'Old cloud chat',
      ]);
      expect(entries.map((e) => e.location), [
        RecentChatLocation.computer,
        RecentChatLocation.cloud,
        RecentChatLocation.computer,
        RecentChatLocation.cloud,
      ]);
    });

    test('a cloud chat sorts by the latest user message this device saw', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            _cloud(
              'c-old',
              'Old cloud chat',
              createdAtMs: DateTime.utc(2026, 9, 1).millisecondsSinceEpoch,
            ),
            _cloud(
              'c-new',
              'New cloud chat',
              createdAtMs: DateTime.utc(2026, 9, 20).millisecondsSinceEpoch,
            ),
          ]),
        ],
        cloudActivityAt: (chatId) =>
            chatId == 'c-old' ? DateTime.utc(2026, 9, 26) : null,
      );

      expect(entries.map((e) => e.title), ['Old cloud chat', 'New cloud chat']);
      expect(entries.first.activityAt, DateTime.utc(2026, 9, 26));
    });

    test('an observed time older than creation does not move a chat back', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            _cloud(
              'c-new',
              'New cloud chat',
              createdAtMs: DateTime.utc(2026, 9, 20).millisecondsSinceEpoch,
            ),
          ]),
        ],
        cloudActivityAt: (_) => DateTime.utc(2026, 9, 1),
      );

      expect(entries.single.activityAt, DateTime.utc(2026, 9, 20));
    });

    test('standalone chats use a newer summary time for recency', () {
      final entries = buildRecentChats(
        cloudWorkspaces: const [],
        remoteStandaloneChats: [
          _standalone(
            's-updated',
            'Updated notes',
            lastMessageAt: '2026-09-10T10:00:00Z',
          ),
          _standalone(
            's-other',
            'Other notes',
            lastMessageAt: '2026-09-20T10:00:00Z',
          ),
        ],
        remoteChatSummaries: const [
          RemoteChatSummary(
            chatId: 's-updated',
            scope: RemoteChatScope.standalone,
            title: 'Updated notes',
            lastMessageAt: '2026-09-25T10:00:00Z',
          ),
        ],
      );

      expect(entries.map((entry) => entry.title), [
        'Updated notes',
        'Other notes',
      ]);
      expect(entries.first.activityAt, DateTime.utc(2026, 9, 25, 10));
    });

    test('flags unread and awaiting-answer chats', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            _cloud('c-ask', 'Cloud asks', createdAtMs: 4),
            _cloud('c-quiet', 'Cloud quiet', createdAtMs: 3),
          ]),
        ],
        cloudChatsAwaitingAnswer: const {'c-ask'},
        remoteWorktrees: const [_worktree],
        remoteChatSummaries: [
          _summary(
            'r-unread',
            'Unread remote',
            lastMessageAt: '1970-01-01T00:00:02Z',
            hasUnread: true,
          ),
          _summary(
            'r-ask',
            'Remote asks',
            lastMessageAt: '1970-01-01T00:00:01Z',
            pendingQuestions: const [AskUserQuestionState(requestId: 'q-1')],
          ),
          _summary(
            'r-answered',
            'Remote answered',
            lastMessageAt: '1970-01-01T00:00:00Z',
            pendingQuestions: const [
              AskUserQuestionState(requestId: 'q-2', answered: true),
            ],
          ),
        ],
        remoteStandaloneChats: [
          _standalone(
            's-unread',
            'Unread notes',
            lastMessageAt: '1969-12-31T00:00:00Z',
            hasUnread: true,
          ),
        ],
      );

      expect(
        {for (final e in entries) e.title: e.attention},
        {
          'Cloud asks': RecentChatAttention.awaitingAnswer,
          'Cloud quiet': RecentChatAttention.none,
          'Unread remote': RecentChatAttention.unread,
          'Remote asks': RecentChatAttention.awaitingAnswer,
          'Remote answered': RecentChatAttention.none,
          'Unread notes': RecentChatAttention.unread,
        },
      );
    });

    test('drops archived, hidden, and orphaned Remote Control chats', () {
      final entries = buildRecentChats(
        cloudWorkspaces: const [],
        remoteWorktrees: const [
          _worktree,
          RemoteWorktree(
            localId: 'wt-hidden',
            workspaceLocalId: 'ws-code',
            branch: 'hidden',
            hidden: true,
          ),
        ],
        remoteChatSummaries: [
          _summary('r-ok', 'Visible'),
          _summary('r-hidden', 'Hidden worktree', worktreeLocalId: 'wt-hidden'),
          _summary('r-orphan', 'No worktree', worktreeLocalId: 'wt-gone'),
        ],
        remoteStandaloneChats: [
          _standalone('s-ok', 'Active notes'),
          _standalone('s-archived', 'Archived notes', archived: true),
        ],
      );

      expect(entries.map((e) => e.title), ['Visible', 'Active notes']);
    });

    test('drops chats owned by explicitly hidden workspaces', () {
      final entries = buildRecentChats(
        cloudWorkspaces: const [],
        remoteWorkspaces: const [
          RemoteWorkspace(
            localId: 'ws-code',
            name: 'Hidden code',
            type: RemoteWorkspaceType.singleRepo,
            hidden: true,
          ),
          RemoteWorkspace(
            localId: 'ws-notes',
            name: 'Hidden notes',
            type: RemoteWorkspaceType.cowork,
            hidden: true,
          ),
        ],
        remoteWorktrees: const [_worktree],
        remoteChatSummaries: [_summary('r-hidden', 'Hidden workspace chat')],
        remoteStandaloneChats: [_standalone('s-hidden', 'Hidden notes chat')],
      );

      expect(entries, isEmpty);
    });

    test('chats without any timestamp sort last, in a stable order', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([_cloud('c-1', 'Cloud', createdAtMs: 5)]),
        ],
        remoteWorktrees: const [_worktree],
        remoteChatSummaries: [
          _summary('r-b', 'Remote B'),
          _summary('r-a', 'Remote A'),
        ],
      );

      expect(entries.map((e) => e.title), ['Cloud', 'Remote B', 'Remote A']);
    });

    test('caps the list at the recents limit', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            for (var i = 0; i < 40; i++)
              _cloud('c-$i', 'Cloud $i', createdAtMs: i),
          ]),
        ],
      );

      expect(recentChatsLimit, 30);
      expect(entries, hasLength(30));
      expect(entries.first.title, 'Cloud 39');
      expect(entries.last.title, 'Cloud 10');
    });

    test('untitled chats fall back to the shared placeholders', () {
      final entries = buildRecentChats(
        cloudWorkspaces: [
          _workspace([
            CloudChatSummary(
              externalId: 'c-untitled',
              title: '  ',
              taskChatExternalId: null,
              modelDefinitionId: null,
              thinkingLevel: null,
              coreAgentSessionId: 's',
              createdAtMs: 1,
            ),
          ]),
        ],
        remoteStandaloneChats: const [
          RemoteStandaloneChat(
            localId: 's-entry',
            projectLocalId: 'ws-notes',
            title: 'Chat title',
            workEntryTitle: 'Work entry title',
          ),
        ],
      );

      expect(entries.map((e) => e.title), ['New chat', 'Work entry title']);
    });
  });
}
