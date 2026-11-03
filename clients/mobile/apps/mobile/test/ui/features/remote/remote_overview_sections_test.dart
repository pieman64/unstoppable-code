import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/remote_overview_sections.dart';

RemoteWorkspace workspace(String id, String name) => RemoteWorkspace(
  localId: id,
  name: name,
  type: RemoteWorkspaceType.singleRepo,
);

RemoteWorktree worktree(
  String id,
  String workspaceId, {
  bool? hasUnread,
  bool? isStreaming,
  bool? busy,
  bool? awaitingApproval,
  bool? hidden,
  RemoteWorktreePipelineStatus? pipelineStatus,
}) => RemoteWorktree(
  localId: id,
  workspaceLocalId: workspaceId,
  branch: 'branch/$id',
  hasUnread: hasUnread,
  isStreaming: isStreaming,
  busy: busy,
  awaitingApproval: awaitingApproval,
  hidden: hidden,
  pipelineStatus: pipelineStatus,
);

void main() {
  group('indexWorktreesByWorkspace', () {
    test('uses locale tailoring and refreshes the cached collator', () {
      final rows = [
        for (final title in ['z', 'ä', 'a'])
          RemoteWorktree(localId: title, workspaceLocalId: 'ws', branch: title),
      ];
      for (final locale in ['de', 'sv', 'de']) {
        final sorted = [...rows]
          ..sort((a, b) => compareRemoteWorktrees(a, b, locale: locale));
        expect(
          sorted.map((w) => w.localId),
          locale == 'sv' ? ['a', 'z', 'ä'] : ['a', 'ä', 'z'],
        );
      }
    });

    test('treats canonically equivalent labels as ties and collates IDs', () {
      final left = RemoteWorktree(
        localId: 'alpha',
        workspaceLocalId: 'ws',
        branch: 'é',
      );
      final right = RemoteWorktree(
        localId: 'Beta',
        workspaceLocalId: 'ws',
        branch: 'e\u0301',
      );
      expect(compareRemoteWorktrees(left, right), lessThan(0));
      expect(compareRemoteWorktrees(right, left), greaterThan(0));
    });

    test(
      'collates mixed case, accents and identities with absent or tied orders',
      () {
        // Expected order from the canonical desktop compareWorktrees under en-US.
        final rows = [
          for (final row in [
            {'localId': 'last', 'branch': 'a', 'order': 1},
            {'localId': 'Beta', 'branch': 'same'},
            {'localId': 'alpha', 'branch': 'same', 'order': 0},
            {'localId': 'accent', 'branch': 'unused', 'label': ' éclair '},
            {'localId': 'base', 'branch': 'eclair', 'label': '  ', 'order': 0},
            {'localId': 'upper', 'branch': 'Beta'},
            {'localId': 'lower', 'branch': 'alpha', 'order': 0},
            {'localId': 'first', 'branch': 'z', 'order': -1},
          ])
            RemoteWorktree.fromJson({...row, 'workspaceLocalId': 'ws'}),
        ];
        for (final input in [rows, rows.reversed]) {
          expect(orderedRemoteWorktrees(input).map((w) => w.localId), [
            'first',
            'lower',
            'upper',
            'base',
            'accent',
            'alpha',
            'Beta',
            'last',
          ]);
        }
      },
    );

    test(
      'orders by saved position, trimmed label or branch, then identity',
      () {
        final rows = [
          for (final row in [
            {'localId': 'last', 'branch': 'aaa', 'order': 1.5},
            {'localId': 'b', 'branch': 'unused', 'label': ' same ', 'order': 0},
            {'localId': 'a', 'branch': 'same'},
            {'localId': 'branch', 'branch': 'alpha', 'label': '   '},
            {'localId': 'first', 'branch': 'zzz', 'order': -1},
          ])
            RemoteWorktree.fromJson({...row, 'workspaceLocalId': 'ws'}),
        ];
        final original = rows.map((w) => w.localId).toList();
        for (final input in [rows, rows.reversed.toList()]) {
          final sorted = indexWorktreesByWorkspace(
            workspaces: [workspace('ws', 'Repository')],
            worktrees: input,
          )['ws']!;
          expect(sorted.map((w) => w.localId), [
            'first',
            'branch',
            'a',
            'b',
            'last',
          ]);
          expect(() => sorted.clear(), throwsUnsupportedError);
        }
        expect(rows.map((w) => w.localId), original);
      },
    );

    test('groups by workspace in deterministic sidebar order', () {
      final indexed = indexWorktreesByWorkspace(
        workspaces: [workspace('ws-b', 'beta'), workspace('ws-a', 'alpha')],
        worktrees: [
          worktree('wt-a1', 'ws-a'),
          worktree('wt-b2', 'ws-b'),
          worktree('wt-unknown', 'ws-unknown'),
          worktree('wt-b1', 'ws-b'),
        ],
      );

      expect(indexed.keys, ['ws-b', 'ws-a']);
      expect(indexed['ws-b']!.map((w) => w.localId), ['wt-b1', 'wt-b2']);
      expect(indexed['ws-a']!.map((w) => w.localId), ['wt-a1']);
      expect(indexed.containsKey('ws-unknown'), isFalse);
    });
  });

  group('visibleRemoteWorkspaces', () {
    RemoteWorkspace workspace(
      String id, {
      bool hidden = false,
      bool alwaysShow = true,
    }) => RemoteWorkspace(
      localId: id,
      name: id,
      type: RemoteWorkspaceType.multiRepo,
      hidden: hidden,
      alwaysShow: alwaysShow,
    );

    RemoteWorktree worktree(String ws, {bool hidden = false}) => RemoteWorktree(
      localId: 'wt-$ws',
      workspaceLocalId: ws,
      branch: 'main',
      hidden: hidden ? true : null,
    );

    test('drops explicitly hidden workspaces', () {
      final visible = visibleRemoteWorkspaces(
        workspaces: [workspace('a'), workspace('b', hidden: true)],
        worktreesFor: (_) => const [],
      );
      expect(visible.map((w) => w.localId), ['a']);
    });

    test('an empty alwaysShow-false (temporary) workspace is not rendered '
        'as a ghost header', () {
      final visible = visibleRemoteWorkspaces(
        workspaces: [
          workspace('empty-temp', alwaysShow: false),
          workspace('live-temp', alwaysShow: false),
        ],
        worktreesFor: (id) => id == 'live-temp' ? [worktree(id)] : const [],
      );
      expect(visible.map((w) => w.localId), ['live-temp']);
    });

    test('hidden worktrees do not rescue an alwaysShow-false workspace', () {
      final visible = visibleRemoteWorkspaces(
        workspaces: [workspace('temp', alwaysShow: false)],
        worktreesFor: (id) => [worktree(id, hidden: true)],
      );
      expect(visible, isEmpty);
    });

    test('visibleRemoteWorktrees drops hidden rows', () {
      final rows = visibleRemoteWorktrees([
        worktree('a'),
        worktree('a', hidden: true),
      ]);
      expect(rows.length, 1);
      expect(rows.single.hidden, isNull);
    });
  });

  group('computeAttentionSections', () {
    test('is empty for no workspaces and for quiet worktrees', () {
      final none = computeAttentionSections(
        workspaces: [],
        worktreesFor: (_) => [],
      );
      expect(none.isEmpty, isTrue);

      final quiet = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [worktree('wt-1', 'ws-1')],
      );
      expect(quiet.isEmpty, isTrue);
    });

    test('only the unread section excludes hidden worktrees', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [
          worktree('wt-unread-hidden', 'ws-1', hasUnread: true, hidden: true),
          worktree(
            'wt-busy-hidden',
            'ws-1',
            isStreaming: true,
            awaitingApproval: true,
            hidden: true,
          ),
        ],
      );
      expect(sections.unreadChats, isEmpty);
      expect(sections.inProgress.map((e) => e.worktree.localId), [
        'wt-busy-hidden',
      ]);
      expect(sections.awaitingApproval.map((e) => e.worktree.localId), [
        'wt-busy-hidden',
      ]);
    });

    test('in progress reads isStreaming only, never the legacy busy flag', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [worktree('wt-legacy', 'ws-1', busy: true)],
      );
      expect(sections.inProgress, isEmpty);
    });

    test(
      'maps pipeline badges to running vs finished (paused is finished)',
      () {
        final sections = computeAttentionSections(
          workspaces: [workspace('ws-1', 'acme')],
          worktreesFor: (_) => [
            worktree(
              'wt-running',
              'ws-1',
              pipelineStatus: RemoteWorktreePipelineStatus.running,
            ),
            worktree(
              'wt-unseen',
              'ws-1',
              pipelineStatus: RemoteWorktreePipelineStatus.unseen,
            ),
            worktree(
              'wt-failed',
              'ws-1',
              pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
            ),
            worktree(
              'wt-paused',
              'ws-1',
              pipelineStatus: RemoteWorktreePipelineStatus.paused,
            ),
          ],
        );
        expect(sections.pipelinesRunning.map((e) => e.worktree.localId), [
          'wt-running',
        ]);
        expect(sections.pipelinesFinished.map((e) => e.worktree.localId), [
          'wt-unseen',
          'wt-failed',
          'wt-paused',
        ]);
      },
    );

    test('keeps snapshot order and attaches workspace names', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-b', 'beta'), workspace('ws-a', 'alpha')],
        worktreesFor: (id) => switch (id) {
          'ws-b' => [
            worktree('wt-b2', 'ws-b', hasUnread: true),
            worktree('wt-b1', 'ws-b', hasUnread: true),
          ],
          _ => [worktree('wt-a1', 'ws-a', hasUnread: true)],
        },
      );
      expect(sections.unreadChats.map((e) => e.worktree.localId), [
        'wt-b2',
        'wt-b1',
        'wt-a1',
      ]);
      expect(sections.unreadChats.map((e) => e.workspaceName), [
        'beta',
        'beta',
        'alpha',
      ]);
    });

    test('a worktree can appear in several sections at once', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [
          worktree(
            'wt-multi',
            'ws-1',
            hasUnread: true,
            pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
          ),
        ],
      );
      expect(sections.unreadChats, hasLength(1));
      expect(sections.pipelinesFinished, hasLength(1));
    });

    test(
      'attention entries preserve priority order without repeating worktrees',
      () {
        final sections = computeAttentionSections(
          workspaces: [workspace('ws-1', 'acme')],
          worktreesFor: (_) => [
            worktree(
              'wt-multi',
              'ws-1',
              hasUnread: true,
              awaitingApproval: true,
              pipelineStatus: RemoteWorktreePipelineStatus.unseenFailure,
            ),
            worktree('wt-unread', 'ws-1', hasUnread: true),
          ],
        );

        expect(sections.attentionEntries.map((e) => e.worktree.localId), [
          'wt-multi',
          'wt-unread',
        ]);
      },
    );

    // The In progress group these fed is gone, but the exclusion it existed to
    // enforce is not: a running agent or pipeline must never be pinned as an
    // ask. The raw lists stay as the shared web/desktop selector mirror.
    test('merely-running worktrees are not attention', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [
          worktree('wt-streaming', 'ws-1', isStreaming: true),
          worktree(
            'wt-pipeline',
            'ws-1',
            pipelineStatus: RemoteWorktreePipelineStatus.running,
          ),
          worktree('wt-approval', 'ws-1', awaitingApproval: true),
        ],
      );

      expect(sections.attentionEntries.map((e) => e.worktree.localId), [
        'wt-approval',
      ]);
      expect(sections.inProgress.map((e) => e.worktree.localId), [
        'wt-streaming',
      ]);
      expect(sections.pipelinesRunning.map((e) => e.worktree.localId), [
        'wt-pipeline',
      ]);
    });

    test('a worktree carrying every signal pins exactly one row', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [
          worktree(
            'wt-both',
            'ws-1',
            hasUnread: true,
            isStreaming: true,
            pipelineStatus: RemoteWorktreePipelineStatus.running,
          ),
        ],
      );

      // One row with every signal on it, not one row per signal.
      expect(sections.attentionEntries.map((e) => e.worktree.localId), [
        'wt-both',
      ]);
    });

    test('finished pipelines (including paused) count as attention', () {
      final sections = computeAttentionSections(
        workspaces: [workspace('ws-1', 'acme')],
        worktreesFor: (_) => [
          worktree(
            'wt-paused',
            'ws-1',
            pipelineStatus: RemoteWorktreePipelineStatus.paused,
          ),
        ],
      );

      expect(sections.attentionEntries.map((e) => e.worktree.localId), [
        'wt-paused',
      ]);
      // `paused` is terminal, so it is not a running pipeline.
      expect(sections.pipelinesRunning, isEmpty);
    });
  });
}
