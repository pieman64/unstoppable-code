import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';

import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';

/// One row of a [CanopySettingsSection]: an optional leading glyph, a title,
/// an optional subtitle and value, and a trailing accessory.
///
/// The title wraps and never truncates. A [value] that does not fit beside
/// it moves below the title and ellipsizes. A null [onTap] makes a read-only
/// row; [enabled] false dims the row and ignores taps.
///
/// Screen readers get one node with the title, subtitle and value, announced
/// as a button when the row has an [onTap]. A row with an [onTap] merges its
/// trailing accessory into that node. A read-only row keeps its trailing
/// control as a separate node, so the control announces its own action.
class CanopySettingsRow extends StatelessWidget {
  const CanopySettingsRow({
    super.key,
    required this.title,
    this.glyph,
    this.subtitle,
    this.value,
    this.trailing,
    this.onTap,
    this.enabled = true,
    this.focusNode,
    this.announcesButton = true,
  }) : _destructive = false;

  /// A destructive action, such as Sign out: glyph and title use the error
  /// color, with no value or trailing accessory.
  const CanopySettingsRow.destructive({
    super.key,
    required this.title,
    required this.onTap,
    this.glyph,
    this.enabled = true,
  }) : subtitle = null,
       value = null,
       trailing = null,
       focusNode = null,
       announcesButton = true,
       _destructive = true;

  final String title;
  final CanopyGlyph? glyph;

  /// Secondary text under the title, such as metadata or an explanation.
  final String? subtitle;

  /// The current value, usually a [CanopySettingsValue].
  final Widget? value;

  /// An accessory such as [CanopySettingsChevron], a switch or an action.
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool enabled;

  /// Focus node for the row's ink, for overlays that return focus to it.
  final FocusNode? focusNode;

  /// Whether a row with an [onTap] is announced as a button. A row whose
  /// trailing control carries its role, such as a switch, sets this false.
  final bool announcesButton;
  final bool _destructive;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final textTheme = Theme.of(context).textTheme;
    final foreground = !enabled
        ? colors.disabledTint
        : _destructive
        ? colors['fg-destructive']
        : colors.foreground;
    final secondary = enabled
        ? colors.foregroundSecondary
        : colors.disabledTint;
    final glyph = this.glyph;
    final subtitle = this.subtitle;
    final value = this.value;
    final trailing = this.trailing;

    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: AppDimens.padding16,
          children: [
            Text(
              title,
              style: textTheme.bodyLarge?.copyWith(color: foreground),
            ),
            if (value != null)
              DefaultTextStyle.merge(
                style: textTheme.bodyLarge?.copyWith(color: secondary),
                child: value,
              ),
          ],
        ),
        if (subtitle != null)
          Text(
            subtitle,
            style: textTheme.bodySmall?.copyWith(color: secondary),
          ),
      ],
    );
    final interactive = onTap != null;

    final row = InkWell(
      focusNode: focusNode,
      onTap: enabled ? onTap : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(
          minHeight: AppDimens.settingsRowMinHeight,
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppDimens.navRowLeadingInset,
            vertical: AppDimens.padding8,
          ),
          child: Row(
            children: [
              if (glyph != null) ...[
                ExcludeSemantics(
                  child: SizedBox.square(
                    dimension: AppDimens.navRowLeadingSize,
                    child: Center(
                      child: CanopyIcon(
                        glyph: glyph,
                        size: AppDimens.navRowLeadingSize,
                        tint: foreground,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: AppDimens.navRowLeadingGap),
              ],
              Expanded(
                // A read-only row merges only its text, so a trailing
                // control stays a separate node with its own action.
                child: interactive
                    ? details
                    : MergeSemantics(
                        child: Semantics(enabled: enabled, child: details),
                      ),
              ),
              if (trailing != null) ...[
                const SizedBox(width: AppDimens.padding8),
                IconTheme.merge(
                  data: IconThemeData(color: secondary),
                  child: trailing,
                ),
              ],
            ],
          ),
        ),
      ),
    );
    if (!interactive) return row;
    return MergeSemantics(
      child: Semantics(button: announcesButton, enabled: enabled, child: row),
    );
  }
}

/// A row's current value: one line, ellipsized, in the secondary color.
class CanopySettingsValue extends StatelessWidget {
  const CanopySettingsValue(String this.text, {super.key});

  /// A quiet placeholder while the value loads. It does not animate.
  const CanopySettingsValue.loading({super.key}) : text = null;

  final String? text;

  /// Placeholder geometry: about one short word of body text.
  static const Size _placeholderSize = Size(40, 12);

  @override
  Widget build(BuildContext context) {
    final text = this.text;
    if (text == null) {
      return Semantics(
        label: 'Loading',
        child: Container(
          width: _placeholderSize.width,
          height: _placeholderSize.height,
          decoration: BoxDecoration(
            color: AppColors.of(context).border,
            borderRadius: BorderRadius.circular(AppRadii.sm),
          ),
        ),
      );
    }
    return Text(text, maxLines: 1, overflow: TextOverflow.ellipsis);
  }
}

/// Trailing disclosure chevron for a row that opens another screen.
class CanopySettingsChevron extends StatelessWidget {
  const CanopySettingsChevron({super.key});

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: CanopyIcon(
      glyph: CanopyGlyph.chevronRightMedium,
      size: 20,
      tint: IconTheme.of(context).color,
    ),
  );
}
