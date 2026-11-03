import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_menu_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_switch_row.dart';
import 'package:mobile/ui/core/dimens.dart';

/// Interactive reference for the grouped settings list in the current
/// appearance. The switch and menu rows hold local preview state only.
class SettingsListScreen extends StatefulWidget {
  const SettingsListScreen({super.key});

  @override
  State<SettingsListScreen> createState() => _SettingsListScreenState();
}

class _SettingsListScreenState extends State<SettingsListScreen> {
  bool _switchValue = true;
  String _menuValue = 'Medium';

  @override
  Widget build(BuildContext context) => CanopyScaffold(
    appBar: CanopyAppBar(
      automaticallyImplyLeading: true,
      content: const Text('Settings list'),
    ),
    body: Builder(
      builder: (context) => ListView(
        padding:
            CanopyScaffold.contentPaddingOf(context) +
            const EdgeInsets.all(AppDimens.padding16),
        children: [
          CanopySettingsSection(
            heading: 'Section heading',
            children: [
              const CanopySettingsRow(
                glyph: CanopyGlyph.email1,
                title: 'Value',
                value: CanopySettingsValue('reader@example.test'),
              ),
              CanopySettingsRow(
                glyph: CanopyGlyph.lock,
                title: 'Chevron',
                trailing: const CanopySettingsChevron(),
                onTap: () {},
              ),
              CanopySettingsSwitchRow(
                glyph: CanopyGlyph.bell,
                title: 'Switch',
                value: _switchValue,
                onChanged: (value) => setState(() => _switchValue = value),
              ),
              CanopySettingsMenuRow<String>(
                glyph: CanopyGlyph.brightness,
                title: 'Menu',
                value: _menuValue,
                options: const [
                  ('Small', 'Small'),
                  ('Medium', 'Medium'),
                  ('Large', 'Large'),
                ],
                onSelected: (value) => setState(() => _menuValue = value),
              ),
              const CanopySettingsRow(
                glyph: CanopyGlyph.shield,
                title: 'Loading',
                value: CanopySettingsValue.loading(),
              ),
              CanopySettingsRow(
                glyph: CanopyGlyph.codeBrackets,
                title: 'Disabled',
                value: const CanopySettingsValue('Unavailable'),
                trailing: const CanopySettingsChevron(),
                enabled: false,
                onTap: () {},
              ),
            ],
          ),
          const SizedBox(height: AppDimens.padding32),
          CanopySettingsSection(
            children: [
              CanopySettingsRow.destructive(
                glyph: CanopyGlyph.arrowBoxRight,
                title: 'Destructive',
                onTap: () {},
              ),
            ],
          ),
        ],
      ),
    ),
  );
}
