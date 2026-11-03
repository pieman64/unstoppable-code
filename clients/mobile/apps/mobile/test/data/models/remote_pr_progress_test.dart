import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';

void main() {
  group('RemotePrCreationProgress.fromJson', () {
    test('parses the full desktop step feed', () {
      final progress = RemotePrCreationProgress.fromJson({
        'currentPhase': 'pushing',
        'steps': [
          {'phase': 'gathering_changes'},
          {'phase': 'summarizing'},
          {'phase': 'pushing'},
        ],
      });

      expect(progress, isNotNull);
      expect(progress!.currentPhase, RemotePrCreationPhase.pushing);
      expect(progress.steps.map((s) => s.phase), [
        RemotePrCreationPhase.gatheringChanges,
        RemotePrCreationPhase.summarizing,
        RemotePrCreationPhase.pushing,
      ]);
    });

    test('keeps error text on error steps', () {
      final progress = RemotePrCreationProgress.fromJson({
        'currentPhase': 'error',
        'steps': [
          {'phase': 'error', 'error': 'no upstream', 'repoName': 'repo-a'},
        ],
      });

      expect(progress!.steps.single.error, 'no upstream');
      expect(progress.steps.single.repoName, 'repo-a');
    });

    test('drops unknown step phases instead of throwing', () {
      final progress = RemotePrCreationProgress.fromJson({
        'currentPhase': 'pushing',
        'steps': [
          {'phase': 'gathering_changes'},
          {'phase': 'teleporting'},
        ],
      });

      expect(progress!.steps.map((s) => s.phase), [
        RemotePrCreationPhase.gatheringChanges,
      ]);
    });

    test('returns null when currentPhase is unknown or absent', () {
      expect(
        RemotePrCreationProgress.fromJson({
          'currentPhase': 'teleporting',
          'steps': [],
        }),
        isNull,
      );
      expect(RemotePrCreationProgress.fromJson({'steps': []}), isNull);
      expect(RemotePrCreationProgress.fromJson(null), isNull);
      expect(RemotePrCreationProgress.fromJson('nope'), isNull);
    });
  });

  group('RemoteMergePrProgress.fromJson', () {
    test('parses queue and retry metadata', () {
      final progress = RemoteMergePrProgress.fromJson({
        'generation': 42,
        'currentPhase': 'waiting_mergeability',
        'steps': [
          {'phase': 'queued', 'queuePosition': 2, 'queueLength': 3},
          {'phase': 'waiting_mergeability', 'retryDelayMs': 4000},
        ],
      });

      expect(progress!.currentPhase, RemoteMergePrPhase.waitingMergeability);
      expect(progress.generation, 42);
      expect(progress.steps.first.queuePosition, 2);
      expect(progress.steps.first.queueLength, 3);
      expect(progress.steps.last.retryDelayMs, 4000);
    });

    test('ignores non-numeric queue metadata', () {
      final progress = RemoteMergePrProgress.fromJson({
        'currentPhase': 'queued',
        'steps': [
          {'phase': 'queued', 'queuePosition': 'two', 'retryDelayMs': null},
        ],
      });

      expect(progress!.steps.single.queuePosition, isNull);
      expect(progress.steps.single.retryDelayMs, isNull);
    });
  });

  group('RemotePrProgressState', () {
    test('is empty only when neither feed parsed', () {
      const neither = RemotePrProgressState();
      expect(neither.isEmpty, isTrue);
      expect(neither.creation, isNull);
      expect(neither.merge, isNull);

      final creationOnly = RemotePrProgressState(
        creation: RemotePrCreationProgress.fromJson({
          'currentPhase': 'pushing',
          'steps': const [],
        }),
      );
      expect(creationOnly.isEmpty, isFalse);
      expect(creationOnly.merge, isNull);

      final mergeOnly = RemotePrProgressState(
        merge: RemoteMergePrProgress.fromJson({
          'currentPhase': 'merging',
          'steps': const [],
        }),
      );
      expect(mergeOnly.isEmpty, isFalse);
      expect(mergeOnly.creation, isNull);
    });

    test('a host clearing a feed reads as absent, not as a cleared feed', () {
      // The desktop clears a feed by emitting `mergeProgress: undefined`,
      // which `JSON.stringify` drops from the delta entirely. The row then
      // parses as `isEmpty` and `_parsePrProgressEntities` omits it, so the
      // client keeps its last feed — deliberately, because a plain PR-status
      // refresh must never blank a live checklist. The card, not the wire,
      // decides when a settled feed stops rendering.
      final cleared = RemotePrProgressState(
        creation: RemotePrCreationProgress.fromJson(null),
        merge: RemoteMergePrProgress.fromJson(null),
      );
      expect(cleared.isEmpty, isTrue);
    });
  });
}
