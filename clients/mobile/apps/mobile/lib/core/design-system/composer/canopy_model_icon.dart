import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/typography.dart';

/// Mirrors desktop ModelProviderIcon: vendor logos with an initial fallback.
/// The execution harness must not brand third-party gateway models.
class CanopyModelIcon extends StatelessWidget {
  const CanopyModelIcon({
    super.key,
    required this.vendor,
    required this.tint,
    this.size = 16,
  });
  final String vendor;
  final Color tint;
  final double size;

  /// Desktop `selectedModelIconColor`: the vendor's own brand hue on a
  /// selected picker row (provider-owned brand colors are a documented
  /// exception to semantic tokens). Monochrome vendors use [fallback].
  static Color selectedTint(String vendor, Color fallback) =>
      switch (vendor.trim().toLowerCase()) {
        'anthropic' || 'claude' => const Color(0xFFD97757),
        'deepseek' => const Color(0xFF5786FE),
        'moonshotai' || 'moonshot' || 'kimi' => const Color(0xFF007CFF),
        'minimax' => const Color(0xFFFF6452),
        _ => fallback,
      };

  @override
  Widget build(BuildContext context) {
    final normalized = vendor.trim().toLowerCase();
    final glyph = switch (normalized) {
      'anthropic' || 'claude' => CanopyGlyph.claudeai,
      'openai' || 'codex' => CanopyGlyph.openai,
      'ollama' => CanopyGlyph.ollama,
      _ => null,
    };
    if (glyph != null) return CanopyIcon(glyph: glyph, size: size, tint: tint);
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: tint.withValues(alpha: 0.18),
      ),
      child: Text(
        normalized.isEmpty ? '?' : normalized.characters.first.toUpperCase(),
        style: AppTypography.emphasis.copyWith(
          color: tint,
          fontSize: size / 2,
          height: 1,
        ),
      ),
    );
  }
}
