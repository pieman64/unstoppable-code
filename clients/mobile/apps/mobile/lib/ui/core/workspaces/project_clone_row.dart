import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/typography.dart';

/// What a pending project row tells the user about its clone.
enum ProjectCloneStatus {
  cloning,

  /// The computer is reconnecting; the clone starts when it is back.
  queued,

  /// The computer created the project; the list does not show it yet.
  awaitingProject,

  /// The computer confirmed that the clone failed.
  failed,

  /// The result could not be confirmed.
  unknown,
}

/// Status copy for a clone row. A failure only says the clone failed when
/// the computer confirmed it.
String projectCloneStatusText(
  ProjectCloneStatus status, {
  required String name,
  String? failure,
}) => switch (status) {
  ProjectCloneStatus.cloning => 'Cloning…',
  ProjectCloneStatus.queued =>
    "Waiting for the desktop… The clone starts when it's back.",
  ProjectCloneStatus.awaitingProject =>
    'Project created. Waiting for it to appear…',
  ProjectCloneStatus.failed => failure ?? "Couldn't clone $name",
  ProjectCloneStatus.unknown =>
    "Couldn't confirm that the clone finished. Check Projects before trying "
        'again.',
};

/// A project the connected computer is cloning, in a project list. A null
/// [onDismiss] hides Dismiss; Dismiss only hides the row on this phone.
class ProjectCloneRow extends StatelessWidget {
  const ProjectCloneRow({
    super.key,
    required this.name,
    required this.status,
    this.failure,
    this.onDismiss,
  });

  /// The repository name derived from the URL, for display only.
  final String name;
  final ProjectCloneStatus status;

  /// Path-free failure copy for [ProjectCloneStatus.failed].
  final String? failure;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = status == ProjectCloneStatus.failed;
    final settled = failed || status == ProjectCloneStatus.unknown;
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
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: AppTypography.emphasisWeight,
                        fontVariations: AppTypography.emphasisVariations,
                      ),
                    ),
                    Text(
                      projectCloneStatusText(
                        status,
                        name: name,
                        failure: failure,
                      ),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: failed ? theme.colorScheme.error : secondary,
                      ),
                    ),
                  ],
                ),
              ),
              if (onDismiss case final onDismiss?)
                CanopyButton(
                  label: 'Dismiss',
                  semanticsLabel: 'Dismiss $name',
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
