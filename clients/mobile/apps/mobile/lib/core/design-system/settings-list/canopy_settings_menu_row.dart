import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';

import '../icon/canopy_glyph.dart';
import '../icon/canopy_icon.dart';
import 'canopy_settings_row.dart';

/// A picker row: shows the current option's label and an up/down indicator.
/// Tapping it opens an anchored menu where a checkmark marks the current
/// option. Choosing a different option calls [onSelected]; choosing the
/// current one or dismissing the menu changes nothing.
class CanopySettingsMenuRow<T> extends StatefulWidget {
  const CanopySettingsMenuRow({
    super.key,
    required this.title,
    required this.value,
    required this.options,
    required this.onSelected,
    this.glyph,
    this.enabled = true,
  });

  final String title;
  final T value;

  /// Each option's value and label, in menu order.
  final List<(T, String)> options;
  final ValueChanged<T> onSelected;
  final CanopyGlyph? glyph;
  final bool enabled;

  @override
  State<CanopySettingsMenuRow<T>> createState() =>
      _CanopySettingsMenuRowState<T>();
}

class _CanopySettingsMenuRowState<T> extends State<CanopySettingsMenuRow<T>> {
  /// The row keeps focus when the menu closes.
  final _focusNode = FocusNode(debugLabel: 'settings menu row');

  /// Checkmark size and the matching empty slot on unselected options.
  static const double _checkSize = 20;

  /// The menu's minimum width. Its end edge lines up with the row's
  /// trailing inset, under the current value.
  static const double _menuWidth = 180;

  /// Space between the checkmark slot and the option label.
  static const double _labelGap = 12;

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  /// Opens the menu as a route under the row, with its end edge under the
  /// current value. A route keeps each option in one semantics parent; the
  /// pinned iOS bridge misplaces overlay-portal menus (flutter/flutter#182604).
  Future<void> _open() async {
    final colors = AppColors.of(context);
    final row = context.findRenderObject()! as RenderBox;
    final overlay =
        Navigator.of(context).overlay!.context.findRenderObject()! as RenderBox;
    final bottomEnd = row.localToGlobal(
      row.size.bottomRight(const Offset(-AppDimens.navRowLeadingInset, 0)),
      ancestor: overlay,
    );
    final selected = await showMenu<T>(
      context: context,
      position: RelativeRect.fromLTRB(
        bottomEnd.dx - _menuWidth,
        bottomEnd.dy,
        overlay.size.width - bottomEnd.dx,
        overlay.size.height - bottomEnd.dy,
      ),
      constraints: const BoxConstraints(minWidth: _menuWidth),
      color: colors.surfaceRaised,
      elevation: 8,
      menuPadding: const EdgeInsets.symmetric(vertical: AppDimens.padding4),
      shape: RoundedRectangleBorder(
        side: BorderSide(color: colors.border),
        borderRadius: BorderRadius.circular(AppRadii.lg),
      ),
      popUpAnimationStyle: AnimationStyle.noAnimation,
      items: [
        for (final (option, label) in widget.options)
          PopupMenuItem<T>(
            value: option,
            height: AppDimens.settingsRowMinHeight,
            padding: const EdgeInsets.symmetric(
              horizontal: AppDimens.padding16,
            ),
            labelTextStyle: WidgetStatePropertyAll(
              Theme.of(
                context,
              ).textTheme.labelLarge?.copyWith(color: colors.foreground),
            ),
            child: Row(
              children: [
                // The checked state is announced; the glyph is decoration.
                if (option == widget.value)
                  ExcludeSemantics(
                    child: CanopyIcon(
                      glyph: CanopyGlyph.checkmark1,
                      size: _checkSize,
                      tint: colors.foreground,
                    ),
                  )
                else
                  const SizedBox.square(dimension: _checkSize),
                const SizedBox(width: _labelGap),
                Semantics(
                  checked: option == widget.value,
                  inMutuallyExclusiveGroup: true,
                  child: Text(label),
                ),
              ],
            ),
          ),
      ],
    );
    if (!mounted) return;
    _focusNode.requestFocus();
    if (selected != null && selected != widget.value) {
      widget.onSelected(selected);
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = [
      for (final (option, label) in widget.options)
        if (option == widget.value) label,
    ].firstOrNull;
    return CanopySettingsRow(
      title: widget.title,
      glyph: widget.glyph,
      focusNode: _focusNode,
      enabled: widget.enabled,
      value: current == null ? null : CanopySettingsValue(current),
      trailing: const _UpDownIndicator(),
      onTap: () => unawaited(_open()),
    );
  }
}

/// The catalog has no combined up/down glyph, so the small top and bottom
/// chevrons are stacked into one indicator.
class _UpDownIndicator extends StatelessWidget {
  const _UpDownIndicator();

  static const double _size = 20;

  /// Each small chevron's stroke sits mid-box; this offset separates them.
  static const double _offset = 3;

  @override
  Widget build(BuildContext context) {
    final tint = IconTheme.of(context).color;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: _size,
        child: Stack(
          children: [
            Transform.translate(
              offset: const Offset(0, -_offset),
              child: CanopyIcon(
                glyph: CanopyGlyph.chevronTopSmall,
                size: _size,
                tint: tint,
              ),
            ),
            Transform.translate(
              offset: const Offset(0, _offset),
              child: CanopyIcon(
                glyph: CanopyGlyph.chevronDownSmall,
                size: _size,
                tint: tint,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
