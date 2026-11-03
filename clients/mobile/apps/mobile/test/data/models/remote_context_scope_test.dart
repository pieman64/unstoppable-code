import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/features/home/view_models/recent_chats.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_search.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';

import '../../support/workspace_context_fixture.dart';

const _personal = WorkspaceContext.personal();
const _orgA = WorkspaceContext.organization(workspaceContextOrgA);
const _orgB = WorkspaceContext.organization(workspaceContextOrgB);

void main() {
  final snapshot = RemoteSessionSnapshot.fromJson(workspaceContextShellState());
  final legacy = RemoteSessionSnapshot.fromJson(
    workspaceContextShellState(withOwners: false),
  );

  List<String> ids(Iterable<Object> rows) => [
    for (final row in rows)
      switch (row) {
        RemoteWorkspace(:final localId) => localId,
        RemoteWorktree(:final localId) => localId,
        RemoteStandaloneChat(:final localId) => localId,
        _ => '$row',
      },
  ];

  group('CAN-4429 RemoteContextScope', () {
    test('Personal lists missing and explicit Personal owners only', () {
      final scope = RemoteContextScope(_personal, snapshot.workspaces);

      expect(ids(scope.workspaces), workspaceContextPersonalIds);
      expect(ids(scope.worktrees(snapshot.worktrees)), ['wt-personal']);
      expect(ids(scope.standaloneChats(snapshot.standaloneChats)), [
        'chat-loose',
        'chat-notes',
      ]);
    });

    test('an organization lists its organization and cloud workspaces', () {
      final scope = RemoteContextScope(_orgA, snapshot.workspaces);

      expect(ids(scope.workspaces), workspaceContextOrgAIds);
      expect(ids(scope.worktrees(snapshot.worktrees)), ['wt-acme']);
      // The projectless chat is Personal only; the chat whose project is
      // missing belongs to no context.
      expect(ids(scope.standaloneChats(snapshot.standaloneChats)), [
        'chat-acme',
        'chat-acme-cloud',
      ]);
    });

    test('an organization with no projects is empty', () {
      final scope = RemoteContextScope(_orgB, snapshot.workspaces);

      expect(scope.workspaces, isEmpty);
      expect(scope.worktrees(snapshot.worktrees), isEmpty);
      expect(scope.standaloneChats(snapshot.standaloneChats), isEmpty);
    });

    test('a desktop without owners lists everything in Personal only', () {
      final personal = RemoteContextScope(_personal, legacy.workspaces);
      expect(personal.workspaces, hasLength(4));
      expect(personal.worktrees(legacy.worktrees), hasLength(2));
      expect(RemoteContextScope(_orgA, legacy.workspaces).workspaces, isEmpty);
    });

    test('a null context scopes nothing but still drops placeholders', () {
      final workspaces = [
        ...snapshot.workspaces,
        RemoteWorkspace.fromJson({
          'localId': 'ws-catalog',
          'name': 'Catalog only',
          'type': 'single-repo',
          'placeholder': {'projectId': 'project-9', 'state': 'available'},
        }),
      ];
      final scope = RemoteContextScope(null, workspaces);

      expect(scope.workspaces, hasLength(4));
      expect(scope.standaloneChats(snapshot.standaloneChats), hasLength(5));
      expect(
        RemoteContextScope(
          _personal,
          workspaces,
        ).workspaces.map((w) => w.localId),
        isNot(contains('ws-catalog')),
      );
    });

    test('malformed owners stay out of every context', () {
      final workspaces = [
        RemoteWorkspace.fromJson({
          'localId': 'ws-odd',
          'name': 'Odd',
          'type': 'single-repo',
          'owner': {'type': 'organization'},
        }),
      ];
      for (final context in [_personal, _orgA]) {
        expect(RemoteContextScope(context, workspaces).workspaces, isEmpty);
      }
    });

    test('attention keeps its hidden policy inside the context', () {
      final worktrees = [
        RemoteWorktree.fromJson({
          'localId': 'wt-hidden-approval',
          'workspaceLocalId': 'ws-org-a',
          'branch': 'b',
          'hidden': true,
          'awaitingApproval': true,
        }),
        ...snapshot.worktrees,
      ];
      final scope = RemoteContextScope(_orgA, snapshot.workspaces);
      final index = indexWorktreesByWorkspace(
        workspaces: scope.workspaces,
        worktrees: worktrees,
      );
      final attention = computeAttentionSections(
        workspaces: scope.workspaces,
        worktreesFor: (id) => index[id] ?? const [],
      );

      expect(
        attention.attentionEntries.map((entry) => entry.worktree.localId),
        ['wt-hidden-approval', 'wt-acme'],
      );
    });

    test('search and Recents read the same scope', () {
      final scope = RemoteContextScope(_personal, snapshot.workspaces);
      final search = buildRemoteChatSearchCandidates(
        workspaces: scope.workspaces,
        worktrees: scope.worktrees(snapshot.worktrees),
        standaloneChats: scope.standaloneChats(snapshot.standaloneChats),
        chatSummaries: snapshot.chatSummaries,
      );
      // The projectless chat falls to the first flat Personal workspace.
      expect(search.map((result) => result.title), [
        'Personal task chat',
        'Loose chat',
        'Notes chat',
      ]);

      final recents = buildRecentChats(
        cloudWorkspaces: const [],
        remoteWorkspaces: scope.workspaces,
        remoteWorktrees: scope.worktrees(snapshot.worktrees),
        remoteStandaloneChats: scope.standaloneChats(snapshot.standaloneChats),
        remoteChatSummaries: snapshot.chatSummaries,
      );
      expect(recents.map((entry) => entry.title), [
        'Personal task chat',
        'Notes chat',
        'Loose chat',
      ]);
    });

    test('a chat owner comes from the raw workspaces', () {
      expect(remoteOwnerContext(snapshot.workspaces, 'ws-org-a-cloud'), _orgA);
      expect(remoteOwnerContext(snapshot.workspaces, ''), _personal);
      expect(remoteOwnerContext(snapshot.workspaces, 'ws-missing'), isNull);
    });
  });
}
