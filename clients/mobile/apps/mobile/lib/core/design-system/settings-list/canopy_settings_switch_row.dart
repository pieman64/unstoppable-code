import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';

import '../icon/canopy_glyph.dart';
import 'canopy_settings_row.dart';

/// A [CanopySettingsRow] with a trailing brand-colored switch. Tapping
/// anywhere on the row toggles it, and screen readers announce one toggle.
/// A null [onChanged] disables the row.
class CanopySettingsSwitchRow extends StatelessWidget {
  const CanopySettingsSwitchRow({
    super.key,
    required this.title,
    required this.value,
    required this.onChanged,
    this.glyph,
    this.subtitle,
  });

  final String title;
  final bool value;
  final ValueChanged<bool>? onChanged;
  final CanopyGlyph? glyph;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final onChanged = this.onChanged;
    return CanopySettingsRow(
      title: title,
      glyph: glyph,
      subtitle: subtitle,
      enabled: onChanged != null,
      // A disabled row keeps its onTap, so the switch still merges into
      // one toggle; the row ignores the tap while disabled.
      onTap: () => onChanged?.call(!value),
      announcesButton: false,
      trailing: Switch(
        value: value,
        onChanged: onChanged,
        activeThumbColor: colors.onAccent,
        activeTrackColor: colors.accent,
        inactiveThumbColor: colors.foregroundSecondary,
        inactiveTrackColor: colors.surface,
        trackOutlineColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? colors.accent
              : colors.border,
        ),
      ),
    );
  }
}
