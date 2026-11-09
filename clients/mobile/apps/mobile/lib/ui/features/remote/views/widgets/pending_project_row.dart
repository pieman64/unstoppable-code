import 'package:flutter/material.dart';
import 'package:mobile/ui/core/workspaces/project_clone_row.dart';
import 'package:mobile/ui/features/remote/view_models/project_clone_coordinator.dart';

/// A project the paired desktop is cloning, in the Remote Control project
/// list. Rows that need no more desktop work offer Dismiss, which only hides
/// the row on this phone.
class PendingProjectRow extends StatelessWidget {
  const PendingProjectRow({
    super.key,
    required this.clone,
    required this.onDismiss,
  });

  final RemoteProjectClone clone;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) => ProjectCloneRow(
    name: clone.name,
    status: switch (clone.phase) {
      RemoteProjectClonePhase.submitting ||
      RemoteProjectClonePhase.cloning => ProjectCloneStatus.cloning,
      RemoteProjectClonePhase.queued => ProjectCloneStatus.queued,
      RemoteProjectClonePhase.awaitingProject =>
        ProjectCloneStatus.awaitingProject,
      RemoteProjectClonePhase.failed => ProjectCloneStatus.failed,
      RemoteProjectClonePhase.unknown => ProjectCloneStatus.unknown,
    },
    failure: clone.failure,
    onDismiss: clone.isDismissible ? onDismiss : null,
  );
}
