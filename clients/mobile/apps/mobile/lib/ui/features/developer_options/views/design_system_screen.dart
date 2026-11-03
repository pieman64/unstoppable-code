import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'app_bars_screen.dart';
import 'package:mobile/ui/features/developer_options/views/fonts_screen.dart';
import 'package:mobile/ui/features/developer_options/views/typography_screen.dart';
import 'package:mobile/ui/features/developer_options/views/code_markdown_screen.dart';
import 'package:mobile/ui/features/developer_options/views/composer_actions_screen.dart';
import 'package:mobile/ui/features/developer_options/views/effort_screen.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/features/developer_options/views/icons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/foundations_screen.dart';
import 'package:mobile/ui/features/developer_options/views/icon_buttons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/progress_screen.dart';
import 'package:mobile/ui/features/developer_options/views/search_field_screen.dart';
import 'package:mobile/ui/features/developer_options/views/settings_list_screen.dart';
import 'package:mobile/ui/features/developer_options/views/mini_buttons_screen.dart';
import 'package:mobile/ui/features/developer_options/views/model_picker_screen.dart';
import 'package:mobile/ui/features/developer_options/views/text_fields_screen.dart';

/// Index of the mobile design-system reference screens.
class DesignSystemScreen extends StatelessWidget {
  const DesignSystemScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Design system'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.symmetric(vertical: 8),
          children: [
            ListTile(
              key: const ValueKey('app-bars-button'),
              leading: const Icon(Icons.web_asset),
              title: const Text('App bars'),
              subtitle: const Text(
                'Floating chrome and edge-to-edge scrolling',
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const AppBarsScreen()),
              ),
            ),
            ListTile(
              key: const ValueKey('icon-buttons-button'),
              leading: const Icon(Icons.touch_app_outlined),
              title: const Text('Icon buttons'),
              subtitle: const Text('Small and medium glyph actions'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const IconButtonsScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('mini-buttons-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.play,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Mini buttons'),
              subtitle: const Text('Small icon-and-text actions'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const MiniButtonsScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('search-field-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.magnifyingGlass,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Search field'),
              subtitle: const Text('Empty, with text and focused states'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const SearchFieldScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('text-fields-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.pencil,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Text fields'),
              subtitle: const Text('Text, number, error and disabled states'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const TextFieldsScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('progress-button'),
              leading: const CanopyIcon(glyph: CanopyGlyph.squareChecklist),
              title: const Text('Progress checklist'),
              subtitle: const Text('Git action progress states'),
              trailing: const CanopyIcon(glyph: CanopyGlyph.chevronRightMedium),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const ProgressScreen()),
              ),
            ),
            ListTile(
              key: const ValueKey('colors-button'),
              leading: const Icon(Icons.palette_outlined),
              title: const Text('Colors'),
              subtitle: const Text('Semantic colors and primitive palettes'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const ColorsScreen()),
              ),
            ),
            ListTile(
              key: const ValueKey('radii-button'),
              leading: const Icon(Icons.rounded_corner),
              title: const Text('Corner radii'),
              subtitle: const Text('The shared desktop radius scale'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const RadiiScreen()),
              ),
            ),
            ListTile(
              key: const ValueKey('icons-button'),
              leading: const Icon(Icons.grid_view_outlined),
              title: const Text('Icons'),
              subtitle: const Text('Browse the icon library'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const IconsScreen()),
              ),
            ),
            ListTile(
              key: const ValueKey('model-picker-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.agent,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Model picker'),
              subtitle: const Text('Tabs, rows and details'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const ModelPickerScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('settings-list-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.listBullets,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Settings list'),
              subtitle: const Text(
                'Sections, values, switches, menus and states',
              ),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const SettingsListScreen(),
                ),
              ),
            ),
            for (final (key, title, subtitle, icon, screen) in const [
              (
                'fonts',
                'Fonts',
                'Inter, JetBrains Mono, weights and italics',
                Icons.font_download_outlined,
                FontsScreen(),
              ),
              (
                'typography',
                'Typography',
                'Text roles, sizes and line heights',
                Icons.text_fields,
                TypographyScreen(),
              ),
              (
                'code-markdown',
                'Code and markdown',
                'Conversation and monospace examples',
                Icons.code,
                CodeMarkdownScreen(),
              ),
            ])
              ListTile(
                key: ValueKey('$key-button'),
                leading: Icon(icon),
                title: Text(title),
                subtitle: Text(subtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(
                  context,
                ).push(MaterialPageRoute<void>(builder: (_) => screen)),
              ),
            ListTile(
              key: const ValueKey('composer-actions-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.plusSmall,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Composer actions'),
              subtitle: const Text('The + sheet and the plugins sheet'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const ComposerActionsScreen(),
                ),
              ),
            ),
            ListTile(
              key: const ValueKey('effort-button'),
              leading: CanopyIcon(
                glyph: CanopyGlyph.brain2,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              title: const Text('Effort'),
              subtitle: const Text('Levels, Fast mode and Ultra fast'),
              trailing: CanopyIcon(
                glyph: CanopyGlyph.chevronRightMedium,
                tint: AppColors.of(context).foregroundSecondary,
              ),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const EffortScreen()),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
