import 'dart:io';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/core/typography.dart';

void main() {
  group('AppTheme', () {
    test('uses Inter with the desktop body scale in both color modes', () {
      for (final theme in [AppTheme.light, AppTheme.dark]) {
        expect(theme.textTheme.bodyMedium?.fontFamily, 'Inter');
        expect(theme.textTheme.bodyMedium?.fontSize, 14);
        expect(theme.textTheme.bodyMedium?.height, 20 / 14);
        expect(theme.textTheme.bodySmall?.fontSize, 13);
        expect(theme.textTheme.bodyLarge?.fontSize, 16);
        expect(theme.textTheme.titleMedium?.fontVariations?.single.value, 450);
        expect(theme.textTheme.bodyMedium?.fontVariations?.single.value, 400);
        expect(theme.primaryTextTheme.bodyMedium?.fontFamily, 'Inter');
      }
    });

    test('limits the product typography system to eight rendered styles', () {
      final text = AppTheme.light.textTheme;
      final styles = <TextStyle>[
        text.displayLarge!,
        text.displayMedium!,
        text.displaySmall!,
        text.headlineLarge!,
        text.headlineMedium!,
        text.headlineSmall!,
        text.titleLarge!,
        text.titleMedium!,
        text.titleSmall!,
        text.bodyLarge!,
        text.bodyMedium!,
        text.bodySmall!,
        text.labelLarge!,
        text.labelMedium!,
        text.labelSmall!,
        AppTypography.code,
      ];
      final renderedStyles = styles
          .map(
            (style) => (
              style.fontFamily,
              style.fontSize,
              style.height,
              style.fontVariations?.singleOrNull?.value,
            ),
          )
          .toSet();

      expect(renderedStyles, hasLength(8));
      expect(text.displayLarge, text.headlineSmall);
      expect(text.titleLarge, text.headlineSmall);
      expect(text.labelLarge, text.titleSmall);
      expect(text.labelSmall, text.labelMedium);
      expect(text.labelSmall?.fontSize, 13);
      expect(text.labelSmall?.height, 18 / 13);
    });

    test('exposes every generated semantic color in both themes', () {
      expect({
        for (final key in Brand.lightSemanticColors.keys)
          key: AppTheme.light.extension<AppColors>()![key],
      }, Brand.lightSemanticColors);
      expect({
        for (final key in Brand.darkSemanticColors.keys)
          key: AppTheme.dark.extension<AppColors>()![key],
      }, Brand.darkSemanticColors);
      final midway = AppColors.light.lerp(AppColors.dark, 0.5);
      for (final key in Brand.lightSemanticColors.keys) {
        expect(
          midway[key],
          Color.lerp(
            Brand.lightSemanticColors[key],
            Brand.darkSemanticColors[key],
            0.5,
          ),
        );
      }
      expect(() => AppColors.light['missing-token'], throwsArgumentError);
      expect(
        AppColors.light.copyWith(values: {'bg-base': Colors.red}).background,
        Colors.red,
      );
      expect(AppColors.light.background, Brand.lightSemanticColors['bg-base']);
    });

    test('info roles match the desktop blue ink and 16 percent surface', () {
      for (final (colors, primitives, stop) in [
        (AppColors.light, Brand.lightPrimitives, 'blue-600'),
        (AppColors.dark, Brand.darkPrimitives, 'blue-300'),
      ]) {
        final info = primitives[stop]!;
        expect(colors['fg-info'], info);
        expect(colors['bg-info-subtle'], info.withValues(alpha: 0.16));
      }
    });

    test('radius scale matches the shared desktop CSS source', () {
      final css = File(
        '../../packages/ui-shared/src/styles/canopy-tokens-core.css',
      ).readAsStringSync();
      for (final entry in AppRadii.values.entries) {
        expect(css, contains('--${entry.key}: ${entry.value.toInt()}px;'));
      }
      expect(AppRadii.defaultRadius, Brand.radius);
    });

    test('light scheme is sourced from the brand palette', () {
      final scheme = AppTheme.light.colorScheme;
      expect(scheme.brightness, Brightness.light);
      expect(scheme.primary, Brand.light.primary);
      expect(scheme.error, Brand.light.error);
      expect(scheme.surface, Brand.light.surface);
      expect(scheme.onSurfaceVariant, Brand.light.onSurfaceVariant);
    });

    test('dark scheme is sourced from the brand palette', () {
      final scheme = AppTheme.dark.colorScheme;
      expect(scheme.brightness, Brightness.dark);
      expect(scheme.primary, Brand.dark.primary);
      expect(scheme.onSurfaceVariant, Brand.dark.onSurfaceVariant);
    });

    test('tertiary is pinned to the brand special purple, never the '
        'Material-generated pink', () {
      expect(
        AppTheme.light.colorScheme.tertiary,
        Brand.lightSemanticColors['fg-special'],
      );
      expect(
        AppTheme.dark.colorScheme.tertiary,
        Brand.darkSemanticColors['fg-special'],
      );
    });

    test('onTertiary pairs with tertiary at WCAG-viable contrast in both '
        'modes', () {
      double contrast(Color a, Color b) {
        final la = a.computeLuminance();
        final lb = b.computeLuminance();
        final lighter = la > lb ? la : lb;
        final darker = la > lb ? lb : la;
        return (lighter + 0.05) / (darker + 0.05);
      }

      final light = AppTheme.light.colorScheme;
      final dark = AppTheme.dark.colorScheme;
      expect(contrast(light.onTertiary, light.tertiary), greaterThan(4.5));
      // White-on-#AC82FF is 2.84:1; the dark pairing must stay viable.
      expect(contrast(dark.onTertiary, dark.tertiary), greaterThan(4.5));
    });

    test('registers the desktop operational status vocabulary', () {
      final light = AppTheme.light.extension<StatusColors>();
      expect(light, isNotNull);
      // Desktop light mode reads the 600-tier primitives
      // (packages/ui-shared/src/styles/canopy-tokens.css).
      expect(light?.merged, Brand.lightPrimitives['purple-600']);
      expect(light?.unread, Brand.lightPrimitives['blue-600']);
      expect(light?.active, Brand.lightPrimitives['cyan-600']);
      expect(light?.failed, Brand.lightPrimitives['red-600']);
      expect(light?.success, Brand.lightPrimitives['green-600']);
      expect(light?.warning, Brand.lightSemanticColors['fg-attention']);
      expect(light?.special, Brand.lightSemanticColors['fg-special']);
      expect(light?.accent, Brand.lightSemanticColors['fg-accent']);
      expect(light?.destructive, Brand.lightSemanticColors['fg-destructive']);
      expect(light?.neutral, Brand.lightSemanticColors['fg-secondary']);
      expect(light?.quaternary, Brand.lightSemanticColors['fg-quaternary']);

      final dark = AppTheme.dark.extension<StatusColors>();
      expect(dark, isNotNull);
      // Dark mode reads the 300-tier primitives.
      expect(dark?.merged, Brand.darkPrimitives['purple-300']);
      expect(dark?.unread, Brand.darkPrimitives['blue-300']);
      expect(dark?.active, Brand.darkPrimitives['cyan-300']);
      expect(dark?.failed, Brand.darkPrimitives['red-300']);
      expect(dark?.success, Brand.darkPrimitives['green-300']);
      expect(dark?.warning, Brand.darkSemanticColors['fg-attention']);
      expect(dark?.special, Brand.darkSemanticColors['fg-special']);
      expect(dark?.accent, Brand.darkSemanticColors['fg-accent']);
      expect(dark?.destructive, Brand.darkSemanticColors['fg-destructive']);
      expect(dark?.neutral, Brand.darkSemanticColors['fg-secondary']);
      expect(dark?.quaternary, Brand.darkSemanticColors['fg-quaternary']);
    });
  });
}
