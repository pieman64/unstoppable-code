import 'package:flutter/foundation.dart';

/// What the Effort panel shows between a drag and the host's reply.
///
/// A drag previews its level and owns that preview until it is released, so
/// the host's level changes do not replace it and the release sends the level
/// that the panel shows. A landed level stays previewed until the host's data
/// changes, so the panel does not flash the old level meanwhile. Only the
/// latest choice's refusal drops the preview: a superseded choice settles
/// after its successor.
@immutable
class CanopyEffortSelection {
  const CanopyEffortSelection({
    this.preview,
    this.choice = 0,
    this.dragging = false,
  });

  /// The level under a drag or a landed choice, or null for the host's level.
  final String? preview;

  /// Counts drags and landed choices.
  final int choice;

  /// Whether a drag is down.
  final bool dragging;

  /// The level to show while the host holds [hostLevel].
  String shown(String hostLevel) => preview ?? hostLevel;

  /// A drag goes down at slider [value] over [levels].
  CanopyEffortSelection start(List<String> levels, double value) =>
      CanopyEffortSelection(
        preview: levels[value.round()],
        choice: choice + 1,
        dragging: true,
      );

  /// The drag moves to slider [value]. Without a drag nothing changes.
  CanopyEffortSelection drag(List<String> levels, double value) => dragging
      ? CanopyEffortSelection(
          preview: levels[value.round()],
          choice: choice,
          dragging: true,
        )
      : this;

  /// The drag lands at slider [value] while the host holds [hostLevel].
  ///
  /// Returns null when no drag is down, so its release sends nothing. A
  /// landing sends its level only when it differs from [hostLevel]; its
  /// [choice] identifies the reply for [settle].
  ({CanopyEffortSelection next, String? send})? release(
    List<String> levels,
    double value, {
    required String hostLevel,
  }) {
    if (!dragging) return null;
    final level = levels[value.round()];
    final landed = choice + 1;
    if (level == hostLevel) {
      return (next: CanopyEffortSelection(choice: landed), send: null);
    }
    return (
      next: CanopyEffortSelection(preview: level, choice: landed),
      send: level,
    );
  }

  /// The host replied to [landed] with whether it [kept] the level. A refusal
  /// can settle before the host's data ever changes, so [hostChanged] would
  /// not see it.
  CanopyEffortSelection settle(int landed, {required bool kept}) =>
      !kept && landed == choice
      ? CanopyEffortSelection(choice: choice, dragging: dragging)
      : this;

  /// The host's data changed. New [levels] end a drag over the old ones, and
  /// its release sends nothing. A new [level] replaces a landed preview but
  /// not a drag's.
  CanopyEffortSelection hostChanged({
    required bool levels,
    required bool level,
  }) {
    if (levels) return CanopyEffortSelection(choice: choice);
    if (level && !dragging) return CanopyEffortSelection(choice: choice);
    return this;
  }
}
