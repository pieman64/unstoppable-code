import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// One row of the composer's `+` sheet.
final class CanopyComposerSheetAction {
  const CanopyComposerSheetAction({
    required this.id,
    required this.glyph,
    required this.label,
    required this.onSelected,
    this.detail,
    this.count,
    this.toggled,
    this.enabled = true,
  });

  /// Names the row's widget key, `composer-action-<id>`.
  final String id;
  final CanopyGlyph glyph;
  final String label;

  /// Runs after the sheet has closed, so a follow-up sheet replaces it.
  final VoidCallback onSelected;

  /// A secondary line, such as why the row is disabled.
  final String? detail;

  /// A trailing count, shown when positive.
  final int? count;

  /// Non-null renders a switch in this state.
  final bool? toggled;
  final bool enabled;
}

/// Shows [actions] in a modal bottom sheet. The draft keeps its text and
/// selection; the caller decides what each row does once the sheet closes.
Future<void> showCanopyComposerActionSheet(
  BuildContext context, {
  required List<CanopyComposerSheetAction> actions,
}) async {
  final chosen = await showModalBottomSheet<CanopyComposerSheetAction>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    useSafeArea: true,
    // The route leaves the bottom inset to its content.
    builder: (context) => SafeArea(
      child: CanopyComposerActionSheet(
        actions: actions,
        onSelected: (action) => Navigator.of(context).pop(action),
      ),
    ),
  );
  chosen?.onSelected();
}

/// The `+` sheet's rows. Each row keeps a 48px touch target and wraps its
/// text at large text sizes instead of clipping it.
class CanopyComposerActionSheet extends StatelessWidget {
  const CanopyComposerActionSheet({
    super.key,
    required this.actions,
    required this.onSelected,
  });

  final List<CanopyComposerSheetAction> actions;
  final ValueChanged<CanopyComposerSheetAction> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final action in actions)
              _ActionRow(
                action: action,
                colors: colors,
                onTap: action.enabled ? () => onSelected(action) : null,
              ),
          ],
        ),
      ),
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.action,
    required this.colors,
    required this.onTap,
  });

  final CanopyComposerSheetAction action;
  final AppColors colors;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    final count = action.count;
    final toggled = action.toggled;
    final detail = action.detail;
    return MergeSemantics(
      child: ListTile(
        key: ValueKey('composer-action-${action.id}'),
        enabled: enabled,
        minTileHeight: 48,
        leading: CanopyIcon(
          glyph: action.glyph,
          size: 24,
          tint: enabled ? colors.foregroundSecondary : colors.disabledTint,
        ),
        title: Text(
          action.label,
          style: AppTypography.body.copyWith(
            color: enabled ? colors.foreground : colors.disabledTint,
          ),
        ),
        subtitle: detail == null
            ? null
            : Text(
                detail,
                style: AppTypography.bodySmall.copyWith(
                  color: colors.foregroundSecondary,
                ),
              ),
        trailing: toggled != null
            ? Switch(
                value: toggled,
                onChanged: enabled ? (_) => onTap!() : null,
              )
            : count != null && count > 0
            ? Text(
                '$count',
                style: AppTypography.bodySmall.copyWith(
                  color: colors.foregroundSecondary,
                ),
              )
            : null,
        onTap: onTap,
      ),
    );
  }
}
