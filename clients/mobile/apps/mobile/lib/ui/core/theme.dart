import 'package:flutter/material.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// Application-wide Material 3 theme, sourced from the active [Brand] palette
/// (generated from `brands/<id>/brand.json`).
final class AppTheme {
  AppTheme._();

  static ThemeData get light => _theme(Brightness.light, Brand.light);
  static ThemeData get dark => _theme(Brightness.dark, Brand.dark);

  static ThemeData _theme(Brightness brightness, BrandColors c) {
    return ThemeData(
      useMaterial3: true,
      fontFamily: AppTypography.sansFamily,
      textTheme: AppTypography.textTheme,
      primaryTextTheme: AppTypography.textTheme,
      tooltipTheme: TooltipThemeData(
        textStyle: AppTypography.bodySmall.copyWith(
          color: brightness == Brightness.dark ? Colors.black : Colors.white,
        ),
      ),
      colorScheme: _scheme(brightness, c),
      extensions: [
        brightness == Brightness.dark ? AppColors.dark : AppColors.light,
        brightness == Brightness.dark ? StatusColors.dark : StatusColors.light,
      ],
      scaffoldBackgroundColor: c.background,
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.all(Radius.circular(Brand.radius)),
        ),
      ),
      chipTheme: const ChipThemeData(
        labelPadding: EdgeInsets.symmetric(horizontal: 4),
        padding: EdgeInsets.symmetric(horizontal: 6, vertical: 0),
      ),
      appBarTheme: const AppBarThemeData(
        centerTitle: false,
        scrolledUnderElevation: 1,
      ),
    );
  }

  /// A complete Material 3 scheme seeded from the brand primary, with the
  /// brand-accurate slots the app uses pinned on top of the generated tones.
  /// `tertiary` is pinned to the brand special purple — `fromSeed` would
  /// otherwise generate a magenta/pink tertiary from the accent-blue seed,
  /// which is why merged states used to read pink instead of purple.
  static ColorScheme _scheme(Brightness brightness, BrandColors c) {
    final semantic = brightness == Brightness.dark
        ? Brand.darkSemanticColors
        : Brand.lightSemanticColors;
    return ColorScheme.fromSeed(
      seedColor: c.primary,
      brightness: brightness,
    ).copyWith(
      primary: c.primary,
      onPrimary: c.onPrimary,
      secondary: c.secondary,
      onSecondary: c.onSecondary,
      // Pin the full M3 tertiary pairing, not just tertiary itself —
      // otherwise `tertiaryContainer` consumers (e.g. the staging badge)
      // would keep seed-generated colors unrelated to the brand purple.
      tertiary: semantic['fg-special'],
      // fg-emphasis is white in both modes; against the DARK tertiary
      // (#AC82FF) that is only ~2.8:1, so dark mode pairs a dark on-color
      // instead to keep the M3 pairing WCAG-viable.
      onTertiary: brightness == Brightness.dark
          ? semantic['bg-base']
          : semantic['fg-emphasis'],
      tertiaryContainer: semantic['bg-special-muted'],
      onTertiaryContainer: semantic['fg-special'],
      surface: c.surface,
      onSurface: c.onSurface,
      surfaceContainerHighest: c.surfaceContainerHighest,
      onSurfaceVariant: c.onSurfaceVariant,
      outline: c.outline,
      error: c.error,
      onError: c.onError,
    );
  }
}
