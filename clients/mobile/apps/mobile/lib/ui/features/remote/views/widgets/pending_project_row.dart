import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/remote/view_models/project_clone_coordinator.dart';

/// Status copy for a clone row, from docs/ux-writing.md "Pending project
/// rows". A failure only says the clone failed when the desktop confirmed it.
String pendingProjectStatus(RemoteProjectClone clone) => switch (clone.phase) {
  RemoteProjectClonePhase.submitting ||
  RemoteProjectClonePhase.cloning => 'Cloning…',
  RemoteProjectClonePhase.queued =>
    "Waiting for the desktop… The clone starts when it's back.",
  RemoteProjectClonePhase.awaitingProject =>
    'Project created. Waiting for it to appear…',
  RemoteProjectClonePhase.failed =>
    clone.failure ?? "Couldn't clone ${clone.name}",
  RemoteProjectClonePhase.unknown =>
    "Couldn't confirm that the clone finished. Check Projects before trying "
        'again.',
};

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
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = clone.phase == RemoteProjectClonePhase.failed;
    final settled = failed || clone.phase == RemoteProjectClonePhase.unknown;
    final secondary = theme.colorScheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Material(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
          child: Row(
            children: [
              SizedBox.square(
                dimension: 32,
                child: Center(
                  child: settled
                      ? CanopyIcon(
                          glyph: failed
                              ? CanopyGlyph.exclamationTriangle
                              : CanopyGlyph.circleQuestionmark,
                          size: 17,
                          tint: failed ? theme.colorScheme.error : secondary,
                        )
                      : LoadingSpinner(size: 17, color: secondary),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      clone.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: AppTypography.emphasisWeight,
                        fontVariations: AppTypography.emphasisVariations,
                      ),
                    ),
                    Text(
                      pendingProjectStatus(clone),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: failed ? theme.colorScheme.error : secondary,
                      ),
                    ),
                  ],
                ),
              ),
              if (clone.isDismissible)
                CanopyButton(
                  label: 'Dismiss',
                  semanticsLabel: 'Dismiss ${clone.name}',
                  variant: CanopyButtonVariant.inline,
                  foregroundColor: secondary,
                  onPressed: onDismiss,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
