import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/features/remote/view_models/pr_merge_queue_display.dart';

import '../../../../support/merge_queue_fixture.dart';

void main() {
  test('phase copy matches the shared desktop and web row', () {
    expect(
      {
        for (final phase in RemotePrMergeQueuePhase.values)
          phase: mergeQueuePhaseLabel(phase),
      },
      {
        RemotePrMergeQueuePhase.queued: 'Waiting in queue',
        RemotePrMergeQueuePhase.awaitingChecks: 'Awaiting queue checks',
        RemotePrMergeQueuePhase.mergeable: 'Queue checks passed',
        RemotePrMergeQueuePhase.locked: 'Locked for merge',
        RemotePrMergeQueuePhase.unmergeable: "Can't merge from queue",
        RemotePrMergeQueuePhase.unknown: null,
      },
    );
    expect(mergeQueuePhaseLabel(null), isNull);
  });

  test('labels name the position and phase only when known', () {
    const full = RemotePrMergeQueue(
      inQueue: true,
      position: 2,
      phase: RemotePrMergeQueuePhase.awaitingChecks,
    );
    const bare = RemotePrMergeQueue(inQueue: true);
    const phaseOnly = RemotePrMergeQueue(
      inQueue: true,
      phase: RemotePrMergeQueuePhase.locked,
    );
    const positionOnly = RemotePrMergeQueue(
      inQueue: true,
      position: 4,
      phase: RemotePrMergeQueuePhase.unknown,
    );
    expect(mergeQueueBadgeLabel(full), 'Queued #2');
    expect(mergeQueueBadgeLabel(bare), 'Queued');
    expect(
      mergeQueueSemanticsLabel(full),
      'In merge queue, position 2. Awaiting queue checks',
    );
    expect(mergeQueueSemanticsLabel(bare), 'In merge queue');
    expect(
      mergeQueueSemanticsLabel(phaseOnly),
      'In merge queue. Locked for merge',
    );
    expect(mergeQueueDetail(full), 'Position #2 · Awaiting queue checks');
    expect(mergeQueueDetail(phaseOnly), 'Locked for merge');
    expect(mergeQueueDetail(positionOnly), 'Position #4');
    expect(mergeQueueDetail(bare), isNull);
  });

  group('worktreeRowMergeQueue', () {
    RemoteWorktree row(List<Map<String, dynamic>> repos) =>
        mergeQueueWorktree('wt', repos);

    test('a single open PR carries its own position and phase', () {
      final queue = worktreeRowMergeQueue(
        row([
          mergeQueueRepo(1, mergeQueue: queued(position: 2, phase: 'locked')),
        ]).prStatuses,
      )!;
      expect(queue.position, 2);
      expect(queue.phase, RemotePrMergeQueuePhase.locked);
    });

    test('unknown, negative, merged and closed are not queued', () {
      for (final repo in [
        mergeQueueRepo(1),
        mergeQueueRepo(1, mergeQueue: const {'inQueue': false}),
        mergeQueueRepo(1, state: 'merged', mergeQueue: queued(position: 1)),
        mergeQueueRepo(1, state: 'closed', mergeQueue: queued(position: 1)),
        mergeQueueRepo(1, state: 'draft', mergeQueue: queued(position: 1)),
      ]) {
        expect(worktreeRowMergeQueue(row([repo]).prStatuses), isNull);
      }
    });

    test('several repositories need every open PR queued', () {
      expect(
        worktreeRowMergeQueue(
          row([
            mergeQueueRepo(1, mergeQueue: queued(position: 1)),
            mergeQueueRepo(2, repoId: 'repo-web', repo: 'web'),
          ]).prStatuses,
        ),
        isNull,
      );
      final both = worktreeRowMergeQueue(
        row([
          mergeQueueRepo(1, mergeQueue: queued(position: 1, phase: 'queued')),
          mergeQueueRepo(
            2,
            repoId: 'repo-web',
            repo: 'web',
            mergeQueue: queued(position: 3),
          ),
        ]).prStatuses,
      )!;
      expect(both.position, isNull);
      expect(both.phase, isNull);
      // A merged sibling leaves the remaining open PR's queue state.
      expect(
        worktreeRowMergeQueue(
          row([
            mergeQueueRepo(1, mergeQueue: queued(position: 1)),
            mergeQueueRepo(2, repoId: 'repo-web', repo: 'web', state: 'merged'),
          ]).prStatuses,
        )?.inQueue,
        isTrue,
      );
    });
  });

  test('action PRs read queue state from the live worktree row', () {
    final rowStatuses = mergeQueueDrawerWorktree().prStatuses;
    RemoteWorktreePr action(int number, String repo, {String state = 'open'}) =>
        RemoteWorktreePr(
          prNumber: number,
          url: mergeQueuePrUrl(number, repo: repo),
          state: state,
        );
    expect(
      mergeQueueForActionPr(action(4454, 'app'), rowStatuses)?.position,
      2,
    );
    expect(mergeQueueForActionPr(action(4455, 'web'), rowStatuses), isNull);
    expect(
      mergeQueueForActionPr(action(4454, 'app', state: 'merged'), rowStatuses),
      isNull,
    );
    expect(
      mergeQueueForActionPr(
        const RemoteWorktreePr(prNumber: 4454, state: 'open'),
        rowStatuses,
      )?.inQueue,
      isTrue,
    );
  });

  group('mergeEnqueuedMessage', () {
    Map<String, dynamic> repo(int number, String status, [int? position]) => {
      'repoName': 'app',
      'prNumber': number,
      'status': status,
      'queuePosition': position,
    };

    test('names one PR with its known position', () {
      expect(
        mergeEnqueuedMessage({
          'mergedRepos': [repo(42, 'enqueued', 3)],
        }),
        'Added #42 to the merge queue (position 3).',
      );
      expect(
        mergeEnqueuedMessage({
          'mergedRepos': [repo(42, 'enqueued'), repo(7, 'merged')],
        }),
        'Added #42 to the merge queue.',
      );
    });

    test('counts several PRs', () {
      expect(
        mergeEnqueuedMessage({
          'mergedRepos': [repo(42, 'enqueued', 1), repo(43, 'enqueued', 2)],
        }),
        'Added 2 pull requests to the merge queue.',
      );
    });

    test('stays silent without an enqueued result', () {
      for (final result in <Map<String, dynamic>>[
        {},
        {'mergedRepos': 'enqueued'},
        {
          'mergedRepos': [repo(42, 'merged')],
        },
        {
          'mergedRepos': [
            'enqueued',
            {'status': 'enqueued'},
          ],
        },
      ]) {
        expect(mergeEnqueuedMessage(result), isNull, reason: '$result');
      }
    });
  });
}
