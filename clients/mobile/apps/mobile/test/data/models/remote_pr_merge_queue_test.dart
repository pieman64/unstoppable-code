import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_session.dart';

import '../../support/merge_queue_fixture.dart';

RemoteWorktreePr _rowPr(Map<String, dynamic> status) =>
    RemoteWorktree.fromJson({
      'localId': 'wt-1',
      'workspaceLocalId': 'ws-1',
      'branch': 'feature',
      'lastKnownPrStatus': {
        'repos': [
          {'repoId': 'app', 'status': status},
        ],
      },
    }).prStatuses.single;

RemotePrMergeQueue? _parse(Object? mergeQueue) => _rowPr({
  'prNumber': 1,
  'state': 'open',
  'mergeQueue': mergeQueue,
}).mergeQueue;

void main() {
  group('lastKnownPrStatus mergeQueue parsing', () {
    test('reads membership, position and phase', () {
      final queue = _parse({
        'inQueue': true,
        'position': 2,
        'phase': 'awaiting_checks',
      })!;
      expect(queue.inQueue, isTrue);
      expect(queue.position, 2);
      expect(queue.phase, RemotePrMergeQueuePhase.awaitingChecks);
    });

    test('maps every wire phase and reads unknown strings as unknown', () {
      for (final entry in {
        'queued': RemotePrMergeQueuePhase.queued,
        'awaiting_checks': RemotePrMergeQueuePhase.awaitingChecks,
        'mergeable': RemotePrMergeQueuePhase.mergeable,
        'locked': RemotePrMergeQueuePhase.locked,
        'unmergeable': RemotePrMergeQueuePhase.unmergeable,
        'unknown': RemotePrMergeQueuePhase.unknown,
        'some_future_state': RemotePrMergeQueuePhase.unknown,
      }.entries) {
        expect(
          _parse({'inQueue': true, 'phase': entry.key})!.phase,
          entry.value,
          reason: entry.key,
        );
      }
    });

    test('a missing or malformed value means unknown membership', () {
      expect(_rowPr({'prNumber': 1, 'state': 'open'}).mergeQueue, isNull);
      for (final malformed in <Object?>[
        null,
        true,
        'queued',
        <Object>[],
        <String, dynamic>{},
        {'inQueue': 'yes'},
        {'position': 2, 'phase': 'queued'},
      ]) {
        expect(_parse(malformed), isNull, reason: '$malformed');
      }
    });

    test('drops malformed optional fields but keeps membership', () {
      final queue = _parse({'inQueue': true, 'position': '2', 'phase': 7})!;
      expect(queue.inQueue, isTrue);
      expect(queue.position, isNull);
      expect(queue.phase, isNull);
      expect(_parse({'inQueue': true, 'position': null})!.position, isNull);
    });

    test('an explicit negative answer has no phase', () {
      final queue = _parse({'inQueue': false, 'phase': 'queued'})!;
      expect(queue.inQueue, isFalse);
      expect(queue.phase, isNull);
    });

    test('only an open PR is in the queue', () {
      for (final state in ['open', 'draft', 'merged', 'closed']) {
        final pr = _rowPr({
          'prNumber': 1,
          'state': state,
          'mergeQueue': {'inQueue': true},
        });
        expect(pr.isInMergeQueue, state == 'open', reason: state);
      }
    });
  });

  group('carryOverMergeQueue', () {
    final queuedRow = _rowPr({
      'prNumber': 4454,
      'prUrl': mergeQueuePrUrl(4454),
      'state': 'open',
      'mergeQueue': queued(position: 2, phase: 'awaiting_checks'),
    });
    RemoteWorktreePr live({
      int number = 4454,
      String? url,
      String state = 'open',
    }) => RemoteWorktreePr(prNumber: number, url: url, state: state);

    test('keeps the row queue value for the same PR URL', () {
      final result = carryOverMergeQueue(
        [queuedRow],
        [live(url: mergeQueuePrUrl(4454), state: 'open')],
      ).single;
      expect(result.mergeQueue, same(queuedRow.mergeQueue));
      expect(result.isInMergeQueue, isTrue);
      expect(
        carryOverMergeQueue(
          [queuedRow],
          [live(url: mergeQueuePrUrl(4454), state: 'draft')],
        ).single.mergeQueue,
        same(queuedRow.mergeQueue),
      );
    });

    test('matches by number only when the update has no URL', () {
      expect(
        carryOverMergeQueue([queuedRow], [live()]).single.mergeQueue,
        same(queuedRow.mergeQueue),
      );
      // A sibling repository's PR can share the number but not the URL.
      expect(
        carryOverMergeQueue(
          [queuedRow],
          [live(url: mergeQueuePrUrl(4454, repo: 'web'))],
        ).single.mergeQueue,
        isNull,
      );
      expect(
        carryOverMergeQueue(
          [queuedRow],
          [live(number: 4455)],
        ).single.mergeQueue,
        isNull,
      );
    });

    test('a merged or closed update drops the stale queue value', () {
      for (final state in ['merged', 'closed']) {
        expect(
          carryOverMergeQueue(
            [queuedRow],
            [live(url: mergeQueuePrUrl(4454), state: state)],
          ).single.mergeQueue,
          isNull,
          reason: state,
        );
      }
    });

    test('keeps an incoming value and unrelated PRs as they are', () {
      const incoming = RemoteWorktreePr(
        prNumber: 4454,
        state: 'open',
        mergeQueue: RemotePrMergeQueue(inQueue: false),
      );
      expect(
        carryOverMergeQueue([queuedRow], [incoming]).single,
        same(incoming),
      );
      final unrelated = live(number: 9, url: mergeQueuePrUrl(9));
      expect(
        carryOverMergeQueue([queuedRow], [unrelated]).single,
        same(unrelated),
      );
    });
  });
}
