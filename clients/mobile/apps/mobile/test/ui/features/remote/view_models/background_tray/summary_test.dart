import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_background_process.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/items.dart';
import 'package:mobile/ui/features/remote/view_models/background_tray/summary.dart';

import 'fixtures.dart';

void main() {
  test('empty or settled tasks hide the tray with an empty summary', () {
    final summary = summarizeBackgroundTray(
      tasks: [
        for (final status in [
          RemoteBackgroundProcessStatus.completed,
          RemoteBackgroundProcessStatus.failed,
          RemoteBackgroundProcessStatus.stopped,
        ])
          task(status.name, status: status),
      ],
    );
    expect(summary.text, '');
    expect(summary.isHidden, isTrue);
    expect(summary.indicator, isNull);
    expect(summary.groups, isEmpty);
    expect(summary.kinds, isEmpty);
  });

  test('summary pluralisation and status priority match the drawer', () {
    final summary = summarizeBackgroundTray(
      tasks: [task('shell')],
      agents: [
        agent('live'),
        agent('approval', status: BackgroundTrayAgentStatus.approval),
      ],
      unlistedDelegations: 2,
      runs: [
        run('live', BackgroundTrayRunStatus.running),
        run('question', BackgroundTrayRunStatus.needsInput),
        run('pause', BackgroundTrayRunStatus.paused),
        run('failure', BackgroundTrayRunStatus.failed),
      ],
    );
    expect(
      summary.text,
      '5 running in the background · 2 need input · 1 paused · 1 finished',
    );
    expect(summary.running, 5);
    expect(summary.indicator, BackgroundTrayIndicator.spinner);
    expect(
      summarizeBackgroundTray(
        runs: [run('one', BackgroundTrayRunStatus.needsInput)],
      ).text,
      '1 needs input',
    );
  });

  test('group ordering preserves host order within each category', () {
    final summary = summarizeBackgroundTray(
      tasks: [task('shell-b'), task('shell-a')],
      agents: [
        agent('queued', status: BackgroundTrayAgentStatus.queued),
        agent('approval', status: BackgroundTrayAgentStatus.approval),
        agent('running'),
      ],
      unlistedDelegations: 1,
      runs: [
        run('done', BackgroundTrayRunStatus.succeeded),
        run('live', BackgroundTrayRunStatus.running),
        run('paused', BackgroundTrayRunStatus.paused),
        run('input', BackgroundTrayRunStatus.needsInput),
      ],
    );
    expect(summary.groups.map((group) => group.kind.label), [
      'Needs you',
      'Running',
      'Finished',
    ]);
    expect(
      summary.groups.map(
        (group) => group.items.map((item) => item.id).toList(),
      ),
      [
        ['approval', 'input', 'paused'],
        [
          'queued',
          'running',
          'unlisted-delegates',
          'shell-b',
          'shell-a',
          'live',
        ],
        ['done'],
      ],
    );
    expect(summary.showsGroupLabels, isTrue);
    expect(
      summarizeBackgroundTray(tasks: [task('only')]).showsGroupLabels,
      isFalse,
    );
  });

  test('a Claude task is counted and listed once, as its agent', () {
    final summary = summarizeBackgroundTray(
      tasks: [
        task('native', kind: RemoteBackgroundProcessKind.agent),
        task('shell'),
      ],
      agents: [
        agent('claude', kind: BackgroundTrayAgentKind.claude, taskId: 'native'),
      ],
    );
    expect(summary.running, 2);
    expect(summary.groups.single.items.map((item) => item.id), [
      'claude',
      'shell',
    ]);
    expect(summary.kinds.map((kind) => (kind.kind, kind.count)), [
      (BackgroundTrayKind.agent, 1),
      (BackgroundTrayKind.bash, 1),
    ]);
  });

  test(
    'collapsed kinds follow desktop order with per-run-kind corner dots',
    () {
      final summary = summarizeBackgroundTray(
        tasks: [
          task('task', kind: RemoteBackgroundProcessKind.task),
          task('workflow', kind: RemoteBackgroundProcessKind.workflow),
          task('shell'),
        ],
        agents: [agent('delegate')],
        unlistedDelegations: 2,
        runs: [
          run(
            'pr',
            BackgroundTrayRunStatus.succeeded,
            kind: BackgroundTrayRunKind.githubPr,
          ),
          run(
            'gh',
            BackgroundTrayRunStatus.failed,
            kind: BackgroundTrayRunKind.github,
          ),
          run('failed', BackgroundTrayRunStatus.failed),
          run('paused', BackgroundTrayRunStatus.paused),
        ],
      );
      expect(summary.kinds.map((kind) => kind.kind), BackgroundTrayKind.values);
      expect(summary.kinds.map((kind) => kind.count), [3, 1, 1, 1, 2, 1, 1]);
      expect(summary.kinds.map((kind) => kind.cornerDot), [
        null,
        null,
        null,
        null,
        BackgroundTrayIndicator.needsInput,
        BackgroundTrayIndicator.failed,
        null,
      ]);
      expect(summary.kinds.first.showsCount, isTrue);
      expect(summary.kinds.last.showsCount, isFalse);
    },
  );

  test(
    'idle indicator priority is input, failed, cancelled, finished, succeeded',
    () {
      final statuses = [
        BackgroundTrayRunStatus.needsInput,
        BackgroundTrayRunStatus.failed,
        BackgroundTrayRunStatus.cancelled,
        BackgroundTrayRunStatus.completed,
        BackgroundTrayRunStatus.succeeded,
      ];
      final expected = [
        BackgroundTrayIndicator.needsInput,
        BackgroundTrayIndicator.failed,
        BackgroundTrayIndicator.cancelled,
        BackgroundTrayIndicator.finished,
        BackgroundTrayIndicator.succeeded,
      ];
      for (var index = 0; index < statuses.length; index++) {
        final summary = summarizeBackgroundTray(
          runs: [
            for (final status in statuses.skip(index)) run(status.name, status),
          ],
        );
        expect(summary.indicator, expected[index]);
      }
      expect(
        summarizeBackgroundTray(
          runs: [run('pause', BackgroundTrayRunStatus.paused)],
        ).indicator,
        BackgroundTrayIndicator.needsInput,
      );
    },
  );

  test('unlisted count labels handle singular and listed delegates', () {
    expect(
      const BackgroundTrayUnlistedDelegates(1, listed: 0).title,
      '1 delegate',
    );
    expect(
      const BackgroundTrayUnlistedDelegates(2, listed: 0).title,
      '2 delegates',
    );
    expect(
      const BackgroundTrayUnlistedDelegates(1, listed: 2).title,
      '1 more delegate',
    );
    expect(
      const BackgroundTrayUnlistedDelegates(2, listed: 1).title,
      '2 more delegates',
    );
    expect(summarizeBackgroundTray(unlistedDelegations: -1).isHidden, isTrue);
  });
}
