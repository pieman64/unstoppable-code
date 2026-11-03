import 'package:flutter/material.dart';

/// Mobile roles mapped to packages/ui-shared/src/styles/canopy-tokens.css.
/// Sizes are logical pixels; Flutter's system text scaling remains enabled.
abstract final class AppTypography {
  static const sansFamily = 'Inter';
  static const monoFamily = 'JetBrainsMono';
  static const regularWeight = FontWeight.w400;
  // FontWeight only exposes 100-step values. The variable axis below renders
  // the desktop's actual 450 outline rather than a synthetic medium/bold.
  static const emphasisWeight = FontWeight.w500;
  static const regularVariations = [FontVariation('wght', 400)];
  static const emphasisVariations = [FontVariation('wght', 450)];
  static const features = [FontFeature('rlig'), FontFeature('calt')];

  static const regular = TextStyle(
    fontFamily: sansFamily,
    fontWeight: regularWeight,
    fontVariations: regularVariations,
    fontFeatures: features,
  );
  static const emphasis = TextStyle(
    fontFamily: sansFamily,
    fontWeight: emphasisWeight,
    fontVariations: emphasisVariations,
    fontFeatures: features,
  );

  static final heading = emphasis.copyWith(fontSize: 20, height: 28 / 20);
  static final title = emphasis.copyWith(fontSize: 16, height: 24 / 16);
  static final sectionLabel = emphasis.copyWith(fontSize: 14, height: 20 / 14);
  static final compactLabel = emphasis.copyWith(fontSize: 13, height: 18 / 13);
  static final bodyLarge = regular.copyWith(fontSize: 16, height: 24 / 16);
  // Settings section headings share the row title size with true bold weight.
  static final settingsHeading = bodyLarge.copyWith(
    fontWeight: FontWeight.bold,
    fontVariations: const [FontVariation('wght', 700)],
  );
  static final body = regular.copyWith(fontSize: 14, height: 20 / 14);
  static final bodySmall = regular.copyWith(fontSize: 13, height: 18 / 13);
  static final code = bodySmall.copyWith(
    fontFamily: monoFamily,
    height: 20 / 13,
  );

  // Material requires its full role vocabulary, but the product exposes only
  // the canonical styles above. Framework roles alias those styles so a
  // widget default cannot silently introduce another size or line height.
  static final textTheme = TextTheme(
    displayLarge: heading,
    displayMedium: heading,
    displaySmall: heading,
    headlineLarge: heading,
    headlineMedium: heading,
    headlineSmall: heading,
    titleLarge: heading,
    titleMedium: title,
    titleSmall: sectionLabel,
    bodyLarge: bodyLarge,
    bodyMedium: body,
    bodySmall: bodySmall,
    labelLarge: sectionLabel,
    labelMedium: compactLabel,
    labelSmall: compactLabel,
  );
}
