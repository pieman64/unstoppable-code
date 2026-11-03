import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_pr_progress.dart';
import 'package:mobile/data/models/remote_progress_phases.dart';

void main() {
  const ordered = [
    'gathering_changes',
    'summarizing',
    'pushing',
    'creating_pr',
  ];

  RemoteProgressStepStatus statusFor(
    String phase, {
    required List<RemoteProgressStep> steps,
    required String currentPhase,
    bool isActive = true,
  }) => deriveRemotePhaseStatus(
    phase: phase,
    orderedPhases: ordered,
    steps: steps,
    currentPhase: currentPhase,
    isActive: isActive,
  );

  group('deriveRemotePhaseStatus', () {
    test('earlier phases complete, current is active, later are pending', () {
      const steps = [
        RemotePrCreationStep(phase: RemotePrCreationPhase.gatheringChanges),
        RemotePrCreationStep(phase: RemotePrCreationPhase.summarizing),
      ];
      expect(
        statusFor(
          'gathering_changes',
          steps: steps,
          currentPhase: 'summarizing',
        ),
        RemoteProgressStepStatus.completed,
      );
      expect(
        statusFor('summarizing', steps: steps, currentPhase: 'summarizing'),
        RemoteProgressStepStatus.active,
      );
      expect(
        statusFor('pushing', steps: steps, currentPhase: 'summarizing'),
        RemoteProgressStepStatus.pending,
      );
    });

    test('the current phase completes when the action is no longer active', () {
      expect(
        statusFor(
          'summarizing',
          steps: const [],
          currentPhase: 'summarizing',
          isActive: false,
        ),
        RemoteProgressStepStatus.completed,
      );
    });

    test('currentPhase done completes every row', () {
      for (final phase in ordered) {
        expect(
          statusFor(phase, steps: const [], currentPhase: 'done'),
          RemoteProgressStepStatus.completed,
        );
      }
    });

    test(
      'on error the last reached phase errors and unreached stay pending',
      () {
        const steps = [
          RemotePrCreationStep(phase: RemotePrCreationPhase.gatheringChanges),
          RemotePrCreationStep(phase: RemotePrCreationPhase.summarizing),
          RemotePrCreationStep(
            phase: RemotePrCreationPhase.error,
            error: 'no upstream',
          ),
        ];
        expect(
          statusFor('gathering_changes', steps: steps, currentPhase: 'error'),
          RemoteProgressStepStatus.completed,
        );
        expect(
          statusFor('summarizing', steps: steps, currentPhase: 'error'),
          RemoteProgressStepStatus.error,
        );
        expect(
          statusFor('pushing', steps: steps, currentPhase: 'error'),
          RemoteProgressStepStatus.pending,
        );
      },
    );

    test('error without error text leaves reached phases completed', () {
      const steps = [
        RemotePrCreationStep(phase: RemotePrCreationPhase.gatheringChanges),
      ];
      expect(
        statusFor('gathering_changes', steps: steps, currentPhase: 'error'),
        RemoteProgressStepStatus.completed,
      );
    });
  });

  group('labels and ordering', () {
    test('PR creation labels match the desktop checklist', () {
      expect(kRemotePrOrderedPhases.map(remotePrPhaseLabel), [
        'Gathering changes',
        'Summarizing changes',
        'Pushing to remote',
        'Creating pull request',
      ]);
    });

    test('merge labels match the desktop checklist', () {
      expect(kRemoteMergeOrderedPhases.map(remoteMergePhaseLabel), [
        'Checking mergeability',
        'Waiting for GitHub',
        'Merging pull request',
        'Refreshing PR status',
      ]);
    });
  });
}
