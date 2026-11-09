import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/chat/widgets/chat_input.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Mobile rendering of the shared `ComposerDrawer`: a depth surface joined to
/// the top of the composer through `ChatInput.attachedHeader`, as wide as the
/// composer and tucked under its rounded top corners.
class ComposerDrawerSurface extends StatelessWidget {
  const ComposerDrawerSurface({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    // A clipped Material of its own: ink paints on the nearest Material, so
    // on the scaffold behind it a highlight or splash would flash in the
    // transparent rounded corners.
    return Material(
      color: colors['bg-depth'],
      shape: RoundedRectangleBorder(
        side: BorderSide(color: colors.border),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      ),
      clipBehavior: Clip.antiAlias,
      // The composer covers the drawer's lower edge.
      child: Padding(
        padding: const EdgeInsets.only(bottom: ChatInput.attachedHeaderOverlap),
        child: child,
      ),
    );
  }
}

/// One of a new chat's context pickers in a [ComposerDrawerSurface], like
/// desktop's capsule `PickerTrigger`: a quiet glyph, the current choice and a
/// chevron, with no fill until pressed. Its hit area keeps the 44px touch
/// floor.
class ComposerContextPicker extends StatelessWidget {
  const ComposerContextPicker({
    super.key,
    required this.icon,
    required this.label,
    required this.semanticLabel,
    required this.onPressed,
  });

  /// A 16px glyph or badge, already tinted.
  final Widget icon;
  final String label;

  /// What the picker chooses and its current choice, such as
  /// "Project, canopy".
  final String semanticLabel;

  /// Opens the options. Null disables the picker.
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final enabled = onPressed != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      excludeSemantics: true,
      child: Opacity(
        // Desktop's disabled composer chip: 40% opacity, resting ink kept.
        opacity: enabled ? 1 : 0.4,
        child: InkWell(
          onTap: onPressed,
          customBorder: const StadiumBorder(),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 44, minWidth: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  icon,
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.bodySmall.copyWith(
                        color: colors.foreground,
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  CanopyIcon(
                    glyph: CanopyGlyph.chevronDownSmall,
                    size: 16,
                    tint: colors.foregroundSecondary,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The pickers of a new chat's [ComposerDrawerSurface]. They wrap onto a
/// second line on narrow phones rather than truncating every label, and each
/// stays within the row's width.
class ComposerContextRow extends StatelessWidget {
  const ComposerContextRow({super.key, required this.children});

  final List<Widget> children;

  // When the keyboard bounds the header, its wrapped rows scroll rather than
  // clip, so every picker stays reachable.
  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(4),
    child: LayoutBuilder(
      // The drawer spans the composer, as on desktop, whatever its pickers.
      builder: (context, constraints) => SizedBox(
        width: constraints.maxWidth,
        child: Wrap(
          children: [
            for (final child in children)
              ConstrainedBox(
                constraints: BoxConstraints(maxWidth: constraints.maxWidth),
                child: child,
              ),
          ],
        ),
      ),
    ),
  );
}
