import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/effort_speed.dart';
import 'package:mobile/ui/core/chat/view_models/thinking_levels.dart';

/// The effort levels and speed one Remote Control chat shows, so its
/// composer and its sends agree.
final class RemoteComposerEffort {
  const RemoteComposerEffort._({
    required this.levels,
    required this.level,
    required this.speed,
  });

  /// Resolves [modelId]'s levels in [catalog], or the default row's without
  /// a model id. The provider hint follows web Remote Control: the chat's
  /// [executionHarness], then the row's harness, then the row's provider,
  /// then the chat's [providerType].
  ///
  /// [level] is the chosen or stored level, shown clamped to the levels. See
  /// [speedOf] for the speed.
  factory RemoteComposerEffort.resolve({
    required List<ModelOption> catalog,
    required String? modelId,
    String? executionHarness,
    required String? providerType,
    required String level,
    bool? pendingFast,
    String? speed,
    bool? fastMode,
  }) {
    final row = catalogRow(catalog, modelId);
    final levels = resolveThinkingLevels(
      catalog,
      modelId,
      executionHarness ?? row?.harness ?? row?.provider ?? providerType,
    );
    return RemoteComposerEffort._(
      levels: levels,
      level: clampThinkingLevelTo(level, levels),
      speed: speedOf(
        pendingFast: pendingFast,
        speed: speed,
        fastMode: fastMode,
      ),
    );
  }

  /// The projected Ultra fast [speed], which no pending choice can override,
  /// then a pending Fast choice ([pendingFast]), then the exact projected
  /// [speed], then the legacy [fastMode] boolean.
  static CanopyEffortSpeed speedOf({
    bool? pendingFast,
    String? speed,
    bool? fastMode,
  }) => switch ((pendingFast, speed)) {
    (_, 'ultrafast') => CanopyEffortSpeed.ultraFast,
    (true, _) => CanopyEffortSpeed.fast,
    (false, _) => CanopyEffortSpeed.regular,
    (null, 'fast') => CanopyEffortSpeed.fast,
    (null, 'standard') => CanopyEffortSpeed.regular,
    _ => fastMode ?? false ? CanopyEffortSpeed.fast : CanopyEffortSpeed.regular,
  };

  /// The model's levels, weakest first; empty when it does not think.
  final List<String> levels;

  /// The shown level, clamped to [levels].
  final String level;
  final CanopyEffortSpeed speed;
}
