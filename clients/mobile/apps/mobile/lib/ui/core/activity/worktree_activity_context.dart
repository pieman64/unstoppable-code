import 'package:mobile/data/models/computer_activity/pr_status.dart';

final class WorktreeActivityContext {
  const WorktreeActivityContext({
    required this.workspaceLocalId,
    required this.localId,
    this.insertions,
    this.deletions,
    this.prStatuses = const [],
    this.mergingPr = false,
    this.mergeProgressLabel,
  });
  final String workspaceLocalId, localId;
  final int? insertions, deletions;
  final List<RemoteWorktreePr> prStatuses;
  final bool mergingPr;
  final String? mergeProgressLabel;
}
