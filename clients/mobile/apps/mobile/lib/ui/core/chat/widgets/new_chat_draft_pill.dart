import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One of a new chat's selectors above its composer, as on web (CAN-2932):
/// an outlined pill with an icon, the current choice, and a chevron that
/// opens its options.
class NewChatDraftPill extends StatelessWidget {
  const NewChatDraftPill({
    super.key,
    required this.icon,
    required this.label,
    required this.semanticLabel,
    required this.onPressed,
  });

  final Widget icon;
  final String label;

  /// What the pill chooses and its current choice, for screen readers, such
  /// as "Project, canopy".
  final String semanticLabel;

  /// Opens the options. Null disables the pill.
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final enabled = onPressed != null;
    final foreground = enabled ? colors.foreground : colors.disabledTint;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(12),
      side: BorderSide(color: colors.border),
    );
    return Semantics(
      button: true,
      enabled: enabled,
      label: semanticLabel,
      excludeSemantics: true,
      child: Material(
        type: MaterialType.transparency,
        shape: shape,
        child: InkWell(
          onTap: onPressed,
          customBorder: shape,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Opacity(opacity: enabled ? 1 : 0.5, child: icon),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.body.copyWith(color: foreground),
                    ),
                  ),
                  const SizedBox(width: 4),
                  CanopyIcon(
                    glyph: CanopyGlyph.chevronDownSmall,
                    size: 20,
                    tint: enabled
                        ? colors.foregroundSecondary
                        : colors.disabledTint,
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
