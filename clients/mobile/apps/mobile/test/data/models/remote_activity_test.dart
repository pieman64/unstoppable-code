import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_activity.dart';
import 'package:mobile/data/models/remote_background_process.dart';

import '../../support/fake_remote_control_repository.dart';

void main() {
  group('RemoteWorktreeActivity.fromState', () {
    test('parses the activity slices for a worktree from shell state', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: const {
          'worktreeSummaries': [
            {
              'worktreeLocalId': 'wt-1',
              'title': 'Auth refactor',
              'description': 'Reworked the OAuth flow.',
              'generatedAt': '2026-07-16T10:00:00Z',
            },
            {
              'worktreeLocalId': 'wt-other',
              'title': 'Other',
              'description': '',
            },
          ],
          'plans': [
            {
              'worktreeLocalId': 'wt-1',
              'title': 'Migration plan',
              'status': 'approved',
            },
            {'worktreeLocalId': 'wt-2', 'title': 'Nope', 'status': 'draft'},
          ],
          'scriptRuns': [
            {'worktreeLocalId': 'wt-1', 'name': 'test', 'status': 'running'},
          ],
          'pipelineRuns': [
            {
              'worktreeLocalId': 'wt-1',
              'localId': 'run-1',
              'pipelineName': 'CI',
              'status': 'success',
            },
          ],
          'hookRuns': [
            {
              'worktreeLocalId': 'wt-1',
              'name': 'pre-commit',
              'status': 'failure',
            },
          ],
          'changedFiles': {
            'wt-1': {
              'worktreeLocalId': 'wt-1',
              'uncommitted': [
                {
                  'filePath': 'lib/a.dart',
                  'status': 'modified',
                  'repoId': 'r-api',
                  'repoName': 'api',
                },
              ],
              'committed': [
                {'filePath': 'lib/b.dart', 'status': 'added'},
              ],
            },
          },
        },
      );

      expect(activity.summary?.title, 'Auth refactor');
      expect(activity.plans.single.title, 'Migration plan');
      expect(activity.scriptRuns.single.status, 'running');
      expect(activity.pipelineRuns.single.pipelineName, 'CI');
      expect(activity.hookRuns.single.name, 'pre-commit');
      expect(activity.changedFiles.map((f) => f.filePath), [
        'lib/a.dart',
        'lib/b.dart',
      ]);
      expect(activity.changedFiles.first.status, 'modified');
      // Multi-repo identity (CAN-2XXX repo-scoped changed files): carried
      // when the desktop projects it, absent otherwise.
      expect(activity.changedFiles.first.repoId, 'r-api');
      expect(activity.changedFiles.first.repoName, 'api');
      expect(activity.changedFiles.last.repoName, isNull);
      expect(activity.hasAnyActivity, isTrue);
    });

    test('is empty for a worktree with no projected activity', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: const {},
      );
      expect(activity.summary, isNull);
      expect(activity.plans, isEmpty);
      expect(activity.changedFiles, isEmpty);
      expect(activity.hasAnyActivity, isFalse);
    });

    test('parses todoLists for the worktree', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: const {
          'todoLists': [
            {
              'localId': 'chat-1',
              'workspaceLocalId': 'ws-1',
              'worktreeLocalId': 'wt-1',
              'chatId': 'chat-1',
              'items': [
                {
                  'id': 't-1',
                  'content': 'Write tests',
                  'status': 'in_progress',
                },
                {'id': 't-2', 'content': 'Ship', 'status': 'pending'},
              ],
            },
            {
              'localId': 'chat-9',
              'worktreeLocalId': 'wt-other',
              'chatId': 'chat-9',
              'items': [
                {'id': 't-9', 'content': 'Elsewhere', 'status': 'pending'},
              ],
            },
          ],
        },
      );
      final todoList = activity.todoLists.single;
      expect(todoList.chatId, 'chat-1');
      expect(todoList.items, hasLength(2));
      expect(todoList.items.first.status, 'in_progress');
      expect(activity.hasAnyActivity, isTrue);
    });

    test('parses hookDescriptors with pause/runDisabled state', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: const {
          'hookDescriptors': [
            {
              'name': 'Lint on save',
              'hookKey': 'hook-lint',
              'triggerName': 'file_saved',
              'worktreeLocalId': 'wt-1',
              'paused': true,
              'runDisabled': true,
              'runDisabledReason': 'Agent is busy',
            },
            {'name': 'Elsewhere', 'hookKey': 'x', 'worktreeLocalId': 'wt-2'},
          ],
        },
      );
      final hook = activity.hookDescriptors.single;
      expect(hook.name, 'Lint on save');
      expect(hook.hookKey, 'hook-lint');
      expect(hook.triggerName, 'file_saved');
      expect(hook.paused, isTrue);
      expect(hook.runDisabled, isTrue);
      expect(hook.runDisabledReason, 'Agent is busy');
      expect(activity.hasAnyActivity, isTrue);
    });

    group('scripts', () {
      Map<String, dynamic> descriptor(
        String scriptKey,
        String name, {
        String worktree = 'wt-1',
        String? scriptName,
        String target = 'project',
      }) => {
        'localId': 'desc-$scriptKey',
        'worktreeLocalId': worktree,
        'scriptKey': scriptKey,
        'scriptName': ?scriptName,
        'name': name,
        'target': target,
      };

      Map<String, dynamic> run(
        String scriptKey,
        String status, {
        String? startedAt,
        String? name,
      }) => {
        'localId': 'run-$scriptKey-$status-$startedAt',
        'worktreeLocalId': 'wt-1',
        'scriptKey': scriptKey,
        'name': name ?? scriptKey,
        'status': status,
        'startedAt': ?startedAt,
      };

      List<(String, String)> rows(Map<String, dynamic> state) => [
        for (final row in RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: state,
        ).scriptRows)
          (row.name, row.status),
      ];

      test(
        'lists configured scripts, with status only on scripts that ran',
        () {
          final activity = RemoteWorktreeActivity.fromState(
            worktreeLocalId: 'wt-1',
            state: {
              'scriptDescriptors': [
                descriptor('project:setup', 'Setup', scriptName: 'setup'),
                descriptor('project:launch', 'Launch', scriptName: 'launch'),
                descriptor('project:storybook', 'Storybook'),
                descriptor('project:other', 'Elsewhere', worktree: 'wt-2'),
              ],
              'scriptRuns': [
                run(
                  'project:setup',
                  'completed',
                  startedAt: '2026-10-17T10:00Z',
                ),
              ],
            },
          );

          expect(activity.scriptDescriptors.map((d) => d.scriptKey), [
            'project:setup',
            'project:launch',
            'project:storybook',
          ]);
          expect(
            [for (final row in activity.scriptRows) (row.name, row.status)],
            [('Setup', 'completed'), ('Launch', ''), ('Storybook', '')],
          );
        },
      );

      test('keys a descriptor by scriptId, then localId', () {
        final activity = RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: const {
            'scriptDescriptors': [
              {'worktreeLocalId': 'wt-1', 'scriptId': 'by-id', 'name': 'A'},
              {'worktreeLocalId': 'wt-1', 'localId': 'by-local', 'name': 'B'},
            ],
          },
        );
        expect(activity.scriptDescriptors.map((d) => d.scriptKey), [
          'by-id',
          'by-local',
        ]);
      });

      test('shows the latest run of a script that ran several times', () {
        expect(
          rows({
            'scriptDescriptors': [descriptor('project:test', 'Test')],
            'scriptRuns': [
              run('project:test', 'failed', startedAt: '2026-10-17T10:00Z'),
              run('project:test', 'completed', startedAt: '2026-10-17T12:00Z'),
              run('project:test', 'failed', startedAt: '2026-10-17T11:00Z'),
            ],
          }),
          [('Test', 'completed')],
        );
      });

      test('prefers an active run when start times tie', () {
        expect(
          rows({
            'scriptDescriptors': [descriptor('project:test', 'Test')],
            'scriptRuns': [
              run('project:test', 'failed', startedAt: '2026-10-17T10:00Z'),
              run('project:test', 'running', startedAt: '2026-10-17T10:00Z'),
              run('project:test', 'completed', startedAt: '2026-10-17T10:00Z'),
            ],
          }),
          [('Test', 'running')],
        );
      });

      test('appends runs with no descriptor, once per script', () {
        expect(
          rows({
            'scriptDescriptors': [descriptor('project:test', 'Test')],
            'scriptRuns': [
              run(
                'project:gone',
                'failed',
                name: 'Removed script',
                startedAt: '2026-10-17T10:00Z',
              ),
              run(
                'project:gone',
                'completed',
                name: 'Removed script',
                startedAt: '2026-10-17T11:00Z',
              ),
            ],
          }),
          [('Test', ''), ('Removed script', 'completed')],
        );
      });

      test('orders workspace setup, launch and teardown first', () {
        expect(
          rows({
            'scriptDescriptors': [
              descriptor('project:storybook', 'Storybook'),
              descriptor(
                'project:teardown',
                'Teardown',
                scriptName: 'teardown',
              ),
              descriptor(
                'workspace-launch',
                'Launch',
                scriptName: 'launch',
                target: 'workspace-root',
              ),
              descriptor('project:lint', 'Lint'),
              descriptor('project:setup', 'Setup', scriptName: 'setup'),
              // A repo script named setup is not the workspace lifecycle one.
              descriptor(
                'repo:api:setup',
                'API setup',
                scriptName: 'setup',
                target: 'workspace-repo',
              ),
            ],
          }),
          [
            ('Setup', ''),
            ('Launch', ''),
            ('Teardown', ''),
            ('Storybook', ''),
            ('Lint', ''),
            ('API setup', ''),
          ],
        );
      });

      test('derives the lifecycle name from the script key', () {
        expect(
          rows({
            'scriptDescriptors': [
              descriptor('project:storybook', 'Storybook'),
              descriptor('project:setup', 'Setup'),
            ],
          }),
          [('Setup', ''), ('Storybook', '')],
        );
      });

      test('counts configured scripts as activity', () {
        final activity = RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: {
            'scriptDescriptors': [descriptor('project:test', 'Test')],
          },
        );
        expect(activity.scriptRuns, isEmpty);
        expect(activity.hasAnyActivity, isTrue);
      });
    });

    test(
      'fromState keeps this worktree pipelines and filters dispatchable',
      () {
        final activity = RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: {
            'pipelines': [
              {
                'pipelineId': 'deploy',
                'name': 'Deploy',
                'worktreeLocalId': 'wt-1',
                'triggerTypes': ['dispatch'],
              },
              {
                'pipelineId': 'plan',
                'name': 'Plan',
                'worktreeLocalId': 'wt-1',
                'triggerTypes': ['plan_ready'],
              },
              {
                'pipelineId': 'other',
                'name': 'Other',
                'worktreeLocalId': 'wt-2',
                'triggerTypes': ['dispatch'],
              },
            ],
          },
        );
        expect(activity.pipelines.map((p) => p.pipelineId), ['deploy', 'plan']);
        expect(activity.dispatchablePipelines.map((p) => p.pipelineId), [
          'deploy',
        ]);
      },
    );
  });

  group('RemoteWorktreeActivity background processes (CAN-5253)', () {
    final state = {
      'backgroundProcesses': [
        backgroundProcessJson(localId: 'bg-a'),
        backgroundProcessJson(localId: 'bg-b', chatId: 'chat-2'),
        backgroundProcessJson(localId: 'bg-c', worktreeLocalId: 'wt-2'),
        // The same worktree id under another workspace.
        backgroundProcessJson(localId: 'bg-d', workspaceLocalId: 'ws-2'),
        backgroundProcessJson(localId: 'bg-e', kind: 'monitor'),
        {'localId': 'bg-bad', 'worktreeLocalId': 'wt-1'},
      ],
    };

    test('fromState keeps the worktree rows, unknown kinds included', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: state,
      );

      expect(
        [for (final row in activity.backgroundProcesses) row.localId],
        ['bg-a', 'bg-b', 'bg-d', 'bg-e'],
      );
      expect(
        activity.backgroundProcesses.last.kind,
        RemoteBackgroundProcessKind.unknown,
      );
    });

    test('a read without the slice has none', () {
      expect(
        RemoteWorktreeActivity.fromState(
          worktreeLocalId: 'wt-1',
          state: const {},
        ).backgroundProcesses,
        isEmpty,
      );
    });

    test('backgroundProcessesForChat filters by chat and workspace', () {
      final activity = RemoteWorktreeActivity.fromState(
        worktreeLocalId: 'wt-1',
        state: state,
      );

      List<String> ids(String workspaceLocalId, String chatId) => [
        for (final row in activity.backgroundProcessesForChat(
          workspaceLocalId: workspaceLocalId,
          chatId: chatId,
        ))
          row.localId,
      ];

      expect(ids('ws-1', 'chat-1'), ['bg-a', 'bg-e']);
      expect(ids('ws-1', 'chat-2'), ['bg-b']);
      expect(ids('ws-2', 'chat-1'), ['bg-d']);
      expect(ids('ws-1', 'chat-3'), isEmpty);
    });
  });
}
