/// Dart port of the shared TypeScript progress-checklist derivation.
///
/// MIRRORS — keep in sync, these have no compile-time link:
///  - `derivePhaseStatus`, `PR_ORDERED_PHASES`, `PR_PHASE_LABELS` in
///    `packages/ui-shared/src/lib/pr-creation-progress.ts`
///  - `MERGE_PR_ORDERED_PHASES`, `MERGE_PR_PHASE_LABELS` in
///    `apps/desktop-app/src/renderer/src/lib/git-progress.ts`
library;

import 'package:mobile/data/models/computer_activity/pr_progress.dart';

enum RemoteProgressStepStatus { completed, active, pending, error }

/// Ordered PR-creation phases shown in the checklist (terminal phases excluded).
const List<RemotePrCreationPhase> kRemotePrOrderedPhases = [
  RemotePrCreationPhase.gatheringChanges,
  RemotePrCreationPhase.summarizing,
  RemotePrCreationPhase.pushing,
  RemotePrCreationPhase.creatingPr,
];

String remotePrPhaseLabel(RemotePrCreationPhase phase) => switch (phase) {
  RemotePrCreationPhase.gatheringChanges => 'Gathering changes',
  RemotePrCreationPhase.summarizing => 'Summarizing changes',
  RemotePrCreationPhase.pushing => 'Pushing to remote',
  RemotePrCreationPhase.creatingPr => 'Creating pull request',
  RemotePrCreationPhase.skipped => 'Skipped (no changes)',
  RemotePrCreationPhase.done => 'Done',
  RemotePrCreationPhase.error => 'Error',
};

/// Ordered PR-merge phases. `queued` is deliberately absent: it renders only
/// when the merge actually waited behind others, and carries a position suffix.
const List<RemoteMergePrPhase> kRemoteMergeOrderedPhases = [
  RemoteMergePrPhase.checkingMergeability,
  RemoteMergePrPhase.waitingMergeability,
  RemoteMergePrPhase.merging,
  RemoteMergePrPhase.refreshingPrStatus,
];

String remoteMergePhaseLabel(RemoteMergePrPhase phase) => switch (phase) {
  RemoteMergePrPhase.queued => 'Queued',
  RemoteMergePrPhase.checkingMergeability => 'Checking mergeability',
  RemoteMergePrPhase.waitingMergeability => 'Waiting for GitHub',
  RemoteMergePrPhase.merging => 'Merging pull request',
  RemoteMergePrPhase.refreshingPrStatus => 'Refreshing PR status',
  RemoteMergePrPhase.done => 'Done',
  RemoteMergePrPhase.error => 'Error',
};

/// Phase to row status. Earlier phases are completed, the current phase is
/// active while the action runs (else completed), later phases are pending. On
/// error, the last reached ordered phase is marked error — but only when an
/// error step carrying text exists — and unreached phases stay pending.
RemoteProgressStepStatus deriveRemotePhaseStatus({
  required String phase,
  required List<String> orderedPhases,
  required List<RemoteProgressStep> steps,
  required String currentPhase,
  required bool isActive,
}) {
  if (currentPhase == 'error') {
    final hasError = steps.any(
      (s) => s.wirePhase == 'error' && s.error != null,
    );
    final reached = steps.map((s) => s.wirePhase).toSet();
    if (!reached.contains(phase)) return RemoteProgressStepStatus.pending;

    var lastReachedIdx = -1;
    for (final step in steps) {
      final idx = orderedPhases.indexOf(step.wirePhase);
      if (idx > lastReachedIdx) lastReachedIdx = idx;
    }
    if (orderedPhases.indexOf(phase) == lastReachedIdx && hasError) {
      return RemoteProgressStepStatus.error;
    }
    return RemoteProgressStepStatus.completed;
  }

  if (currentPhase == 'done') return RemoteProgressStepStatus.completed;

  final currentIdx = orderedPhases.indexOf(currentPhase);
  final phaseIdx = orderedPhases.indexOf(phase);
  if (phaseIdx < currentIdx) return RemoteProgressStepStatus.completed;
  if (phaseIdx == currentIdx) {
    return isActive
        ? RemoteProgressStepStatus.active
        : RemoteProgressStepStatus.completed;
  }
  return RemoteProgressStepStatus.pending;
}
