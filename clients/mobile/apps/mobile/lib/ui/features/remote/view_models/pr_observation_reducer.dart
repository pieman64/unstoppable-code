import 'package:mobile/data/models/remote_pr_merge_queue.dart';
import 'package:mobile/data/models/remote_session.dart';

/// Retains failed lookups and merge-queue progress while reconciling whether
/// a host observation supersedes a client action read. Equivalent observations
/// keep the row and its PR list stable.
RemoteWorktree reducePrObservation(
  RemoteWorktree row,
  List<RemoteWorktreePr> prs, {
  required RemotePrObservationSource source,
}) {
  final observations = carryOverMergeQueue(row.prStatuses, [
    for (final pr in prs)
      if (pr.lookupAvailable)
        pr
      else
        ...row.prStatuses.where((held) => held.repoId == pr.repoId),
  ]);
  final observationSource =
      source == RemotePrObservationSource.host &&
          prs.any((pr) => !pr.lookupAvailable)
      ? row.prObservationSource
      : source;
  final unchanged = sameRemotePrStatuses(row.prStatuses, observations);
  final hostConfirms =
      observationSource == RemotePrObservationSource.host &&
      row.prObservationSource == RemotePrObservationSource.actionRead;
  if (unchanged && !hostConfirms) return row;
  return row.withPrStatuses(
    unchanged ? row.prStatuses : observations,
    source: observationSource,
  );
}
