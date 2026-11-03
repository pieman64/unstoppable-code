import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';

/// Desktop/web operational status vocabulary as a theme extension, sourced
/// from the generated [Brand] token maps so every surface shares the exact
/// colors documented in `docs/sidebar-worktree-status.md` and
/// `packages/ui-shared/src/styles/canopy-tokens.css`:
///
/// - unread and active are blue/cyan, failed is always red, success is always
///   green, and merged/done is always purple;
/// - warning/attention (orange) means "needs your input", including a paused
///   pipeline;
/// - the agent-working accent is the brand accent, rendered as a spinner.
@immutable
class StatusColors extends ThemeExtension<StatusColors> {
  const StatusColors({
    required this.merged,
    required this.unread,
    required this.active,
    required this.failed,
    required this.success,
    required this.warning,
    required this.special,
    required this.accent,
    required this.destructive,
    required this.neutral,
    required this.quaternary,
  });

  /// Done — PR merged, split completed (`fg-special`, purple).
  final Color merged;

  /// Finished but not seen yet (`fg-info`, blue).
  final Color unread;

  /// Running right now — terminal/script/hook. Cyan here; desktop and web
  /// now draw running with the info ink (`fg-info`, blue), shared with unread.
  final Color active;

  /// Failed, not seen yet (`fg-destructive`, red).
  final Color failed;

  /// Succeeded, unseen (`fg-success`, green).
  final Color success;

  /// Needs your input (`fg-attention`, orange).
  final Color warning;

  /// Special/info intent (`fg-special`, purple).
  final Color special;

  /// Agent working accent (`fg-accent`).
  final Color accent;

  /// Destructive intent (`fg-destructive`).
  final Color destructive;

  /// Housekeeping / secondary text (`fg-secondary`).
  final Color neutral;

  /// Idle / quietest tier (`fg-quaternary`).
  final Color quaternary;

  /// Light mode reads the 600-tier primitives, mirroring desktop's
  /// `:root` block in `canopy-tokens.css`.
  static final StatusColors light = StatusColors(
    merged: _primitive(Brand.lightPrimitives, 'purple-600'),
    unread: _primitive(Brand.lightPrimitives, 'blue-600'),
    active: _primitive(Brand.lightPrimitives, 'cyan-600'),
    failed: _primitive(Brand.lightPrimitives, 'red-600'),
    success: _primitive(Brand.lightPrimitives, 'green-600'),
    warning: _primitive(Brand.lightSemanticColors, 'fg-attention'),
    special: _primitive(Brand.lightSemanticColors, 'fg-special'),
    accent: _primitive(Brand.lightSemanticColors, 'fg-accent'),
    destructive: _primitive(Brand.lightSemanticColors, 'fg-destructive'),
    neutral: _primitive(Brand.lightSemanticColors, 'fg-secondary'),
    quaternary: _primitive(Brand.lightSemanticColors, 'fg-quaternary'),
  );

  /// Dark mode reads the 300-tier primitives, mirroring `:root.dark`.
  static final StatusColors dark = StatusColors(
    merged: _primitive(Brand.darkPrimitives, 'purple-300'),
    unread: _primitive(Brand.darkPrimitives, 'blue-300'),
    active: _primitive(Brand.darkPrimitives, 'cyan-300'),
    failed: _primitive(Brand.darkPrimitives, 'red-300'),
    success: _primitive(Brand.darkPrimitives, 'green-300'),
    warning: _primitive(Brand.darkSemanticColors, 'fg-attention'),
    special: _primitive(Brand.darkSemanticColors, 'fg-special'),
    accent: _primitive(Brand.darkSemanticColors, 'fg-accent'),
    destructive: _primitive(Brand.darkSemanticColors, 'fg-destructive'),
    neutral: _primitive(Brand.darkSemanticColors, 'fg-secondary'),
    quaternary: _primitive(Brand.darkSemanticColors, 'fg-quaternary'),
  );

  /// Resolves the vocabulary from a [BuildContext]; the extension is always
  /// registered by `AppTheme`, but a brightness-matched fallback keeps
  /// bare-`ThemeData` widget tests working.
  static StatusColors of(BuildContext context) {
    final theme = Theme.of(context);
    return theme.extension<StatusColors>() ??
        (theme.brightness == Brightness.dark ? dark : light);
  }

  static Color _primitive(Map<String, Color> map, String key) {
    // Fall back to a neutral grey rather than throwing: these are built into
    // `AppTheme.extensions`, so a brand pack missing one token must degrade
    // a color, not crash theme construction app-wide. (The generator emits
    // every key today; this is the safety net.)
    return map[key] ?? const Color(0xFF9E9E9E);
  }

  @override
  StatusColors copyWith({
    Color? merged,
    Color? unread,
    Color? active,
    Color? failed,
    Color? success,
    Color? warning,
    Color? special,
    Color? accent,
    Color? destructive,
    Color? neutral,
    Color? quaternary,
  }) {
    return StatusColors(
      merged: merged ?? this.merged,
      unread: unread ?? this.unread,
      active: active ?? this.active,
      failed: failed ?? this.failed,
      success: success ?? this.success,
      warning: warning ?? this.warning,
      special: special ?? this.special,
      accent: accent ?? this.accent,
      destructive: destructive ?? this.destructive,
      neutral: neutral ?? this.neutral,
      quaternary: quaternary ?? this.quaternary,
    );
  }

  @override
  StatusColors lerp(ThemeExtension<StatusColors>? other, double t) {
    if (other is! StatusColors) return this;
    return StatusColors(
      merged: Color.lerp(merged, other.merged, t) ?? merged,
      unread: Color.lerp(unread, other.unread, t) ?? unread,
      active: Color.lerp(active, other.active, t) ?? active,
      failed: Color.lerp(failed, other.failed, t) ?? failed,
      success: Color.lerp(success, other.success, t) ?? success,
      warning: Color.lerp(warning, other.warning, t) ?? warning,
      special: Color.lerp(special, other.special, t) ?? special,
      accent: Color.lerp(accent, other.accent, t) ?? accent,
      destructive: Color.lerp(destructive, other.destructive, t) ?? destructive,
      neutral: Color.lerp(neutral, other.neutral, t) ?? neutral,
      quaternary: Color.lerp(quaternary, other.quaternary, t) ?? quaternary,
    );
  }
}
