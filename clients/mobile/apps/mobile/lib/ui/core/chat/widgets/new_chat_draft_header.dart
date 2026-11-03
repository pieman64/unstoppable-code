import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';

/// A new chat's app-bar content, `[Project ▾] / Title`, so the chat reads as
/// belonging to the project. The group shrinks to fit and the app bar centers
/// it.
///
/// The title keeps up to half the row and the project name truncates into
/// the rest, so the chevron, slash, and title stay visible on narrow screens.
class NewChatDraftHeader extends StatelessWidget {
  const NewChatDraftHeader({super.key, required this.title, this.project});

  final String title;

  /// The project picker; null shows the title alone.
  final Widget? project;

  @override
  Widget build(BuildContext context) {
    final project = this.project;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (project != null) ...[
          Flexible(child: project),
          ExcludeSemantics(
            // The button's inset and the chevron's own margin already
            // space the slash from the project.
            child: Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Text(
                '/',
                style: TextStyle(color: AppColors.of(context).foregroundMuted),
              ),
            ),
          ),
        ],
        Flexible(
          child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis),
        ),
      ],
    );
  }
}

/// The draft's project as a header button: its name and a chevron that
/// opens the project picker. Shows "No project" when there is none.
class NewChatDraftProjectButton extends StatelessWidget {
  const NewChatDraftProjectButton({
    super.key,
    required this.name,
    required this.onPressed,
  });

  final String? name;

  /// Opens the project picker. Null disables the button.
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    const shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.all(Radius.circular(8)),
    );
    // Its own Material so the ink shows above the app bar's scrim. A Material
    // resets the text style, so it passes on the app bar's title style.
    return Material(
      type: MaterialType.transparency,
      textStyle: DefaultTextStyle.of(context).style,
      child: Semantics(
        button: true,
        enabled: onPressed != null,
        child: InkWell(
          onTap: onPressed,
          customBorder: shape,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      name ?? 'No project',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: colors.foregroundSecondary),
                    ),
                  ),
                  const SizedBox(width: 2),
                  CanopyIcon(
                    glyph: CanopyGlyph.chevronDownSmall,
                    size: 20,
                    tint: onPressed == null
                        ? colors.disabledTint
                        : colors.foregroundSecondary,
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
