import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';

/// Desktop semantic colors from the generated brand palette. Token names match
/// `packages/ui-shared/src/styles/generated-theme-tokens.css` exactly.
/// Prefer semantic roles to primitive colors when styling application widgets.
@immutable
class AppColors extends ThemeExtension<AppColors> {
  AppColors(Map<String, Color> values) : values = Map.unmodifiable(values);

  final Map<String, Color> values;

  static final light = AppColors(
    _withInfoRoles(
      Brand.lightSemanticColors,
      Brand.lightPrimitives['blue-600']!,
    ),
  );
  static final dark = AppColors(
    _withInfoRoles(Brand.darkSemanticColors, Brand.darkPrimitives['blue-300']!),
  );

  // These roles are derived in canopy-tokens-core.css rather than emitted by
  // the color engine: fg-info aliases fg-blue, and bg-info-subtle uses 16% ink.
  // Keep that platform projection here so feature widgets consume role names.
  static Map<String, Color> _withInfoRoles(
    Map<String, Color> generated,
    Color info,
  ) => {
    ...generated,
    'fg-info': info,
    'bg-info-subtle': info.withValues(alpha: 0.16),
  };

  static AppColors of(BuildContext context) {
    final theme = Theme.of(context);
    return theme.extension<AppColors>() ??
        (theme.brightness == Brightness.dark ? dark : light);
  }

  Color operator [](String token) {
    final color = values[token];
    if (color == null) {
      throw ArgumentError.value(token, 'token', 'Unknown color');
    }
    return color;
  }

  Color get background => this['bg-base'];
  Color get surface => this['bg-primary'];
  Color get surfaceRaised => this['bg-secondary'];
  Color get foreground => this['fg-primary'];
  Color get foregroundSecondary => this['fg-secondary'];
  Color get foregroundMuted => this['fg-tertiary'];

  /// Disabled controls retain the normal tint at half opacity.
  Color get disabledTint => foregroundSecondary.withValues(alpha: 0.5);

  Color get border => this['line-primary'];
  Color get focus => this['line-focus'];
  Color get accent => this['bg-accent'];
  Color get onAccent => this['fg-emphasis'];

  @override
  AppColors copyWith({Map<String, Color>? values}) =>
      AppColors({...this.values, ...?values});

  @override
  AppColors lerp(covariant AppColors? other, double t) {
    if (other == null) return this;
    return AppColors({
      for (final key in {...values.keys, ...other.values.keys})
        key: Color.lerp(values[key], other.values[key], t)!,
    });
  }
}

/// Desktop radius tokens in Flutter logical pixels (one CSS px per logical px).
/// Source: `packages/ui-shared/src/styles/canopy-tokens.css`, @theme block.
/// The fixed scale is separate from the brand's configurable default radius.
abstract final class AppRadii {
  static const double none = 0;
  static const double sm = 4;
  static const double md = 8;
  static const double lg = 12;
  static const double xl = 16;
  static const double xxl = 20;
  static const double xxxl = 24;
  static const double full = 9999;
  static const double defaultRadius = Brand.radius;

  static const values = <String, double>{
    'radius-sm': sm,
    'radius-md': md,
    'radius-lg': lg,
    'radius-xl': xl,
    'radius-2xl': xxl,
    'radius-3xl': xxxl,
    'radius-full': full,
  };
}
