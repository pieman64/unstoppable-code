import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/initials.dart';
import 'package:mobile/ui/core/typography.dart';

/// Settings' centered profile: the initials avatar with a pencil badge that
/// edits the display name, then the name and email.
class AccountProfileHeader extends StatelessWidget {
  const AccountProfileHeader({
    super.key,
    required this.name,
    required this.email,
    required this.onEdit,
  });

  final String name;
  final String email;
  final VoidCallback onEdit;

  static const double _avatarRadius = 36;
  static const double _badgeSize = 28;
  static const double _badgeGlyphSize = 16;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    return Column(
      children: [
        // The avatar and badge form one edit target, larger than 48 dp.
        // Screen readers announce it as the Edit name button; the initials
        // and pencil are decoration.
        Semantics(
          container: true,
          button: true,
          child: Tooltip(
            message: 'Edit name',
            child: Material(
              type: MaterialType.transparency,
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onEdit,
                child: ExcludeSemantics(
                  child: Stack(
                    children: [
                      CircleAvatar(
                        radius: _avatarRadius,
                        child: Text(
                          initialsOf(name) ?? '?',
                          style: theme.textTheme.titleMedium,
                        ),
                      ),
                      PositionedDirectional(
                        end: 0,
                        bottom: 0,
                        child: Container(
                          width: _badgeSize,
                          height: _badgeSize,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: colors.surfaceRaised,
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: colors.border,
                              width: AppDimens.border1,
                            ),
                          ),
                          child: CanopyIcon(
                            glyph: CanopyGlyph.pencil,
                            size: _badgeGlyphSize,
                            tint: colors.foreground,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        const SizedBox(height: AppDimens.padding8),
        Text(
          name,
          textAlign: TextAlign.center,
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        Text(
          email,
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colors.foregroundSecondary,
          ),
        ),
      ],
    );
  }
}
