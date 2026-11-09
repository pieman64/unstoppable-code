import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/workspaces/workspace_section_header.dart';

/// Mobile rendering of the shared `WorkspaceKindBadge`: a 16px rounded square
/// in the project's categorical color holding its kind glyph, as on desktop
/// pickers. A temporary multi-repo project draws a neutral outline instead.
class WorkspaceKindBadge extends StatelessWidget {
  const WorkspaceKindBadge({
    super.key,
    required this.type,
    this.color,
    this.temporary = false,
  });

  /// The project's `type`: `single-repo`, `multi-repo` or `cowork`.
  final String type;

  /// The project's stored hex color.
  final String? color;
  final bool temporary;

  static const double size = 16;

  /// Mirrors `resolveWorkspaceBadgeBackgroundColor`: the stored hue picks a
  /// theme categorical color, so the badge follows the active palette.
  static String categoricalToken(String? hex) {
    final parsed = workspaceColor(hex);
    if (parsed == null) return 'categorical-1';
    final hue = HSVColor.fromColor(parsed).hue;
    if (hue < 15 || hue >= 345) return 'categorical-4';
    if (hue < 65) return 'categorical-3';
    if (hue < 165) return 'categorical-2';
    if (hue < 185) return 'categorical-1';
    if (hue < 255) return 'categorical-6';
    return 'categorical-5';
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final outlined = temporary && type == 'multi-repo';
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: outlined ? null : colors[categoricalToken(color)],
        border: outlined ? Border.all(color: colors['fg-quaternary']) : null,
        // `WORKSPACE_GLYPH_RADIUS_CLASS`: the medium radius less 3px.
        borderRadius: BorderRadius.circular(AppRadii.md - 3),
      ),
      alignment: Alignment.center,
      child: CanopyIcon(
        glyph: type == 'multi-repo'
            ? CanopyGlyph.folders
            : CanopyGlyph.folderFilled,
        size: type == 'multi-repo' ? 12 : 10,
        // The shared badge keeps white artwork on its solid fill.
        tint: outlined ? colors.foreground : colors.onAccent,
      ),
    );
  }
}
