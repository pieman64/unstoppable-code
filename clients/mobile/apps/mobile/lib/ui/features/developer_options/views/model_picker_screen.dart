import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_details.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_row.dart';
import 'package:mobile/core/design-system/model-picker/canopy_model_tabs.dart';

/// Reference for the design-system parts of the model picker sheet: its tab
/// row, row states and details card. The sheet itself belongs to the Chat
/// feature, which Developer Options does not import.
class ModelPickerScreen extends StatefulWidget {
  const ModelPickerScreen({super.key});

  @override
  State<ModelPickerScreen> createState() => _ModelPickerScreenState();
}

class _ModelPickerScreenState extends State<ModelPickerScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Model picker'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(16),
          children: [
            Text('Tabs', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            CanopyModelTabs(
              tabs: const [
                CanopyModelTab(
                  key: ValueKey('preview-tab-all'),
                  label: 'All models',
                ),
                CanopyModelTab(
                  key: ValueKey('preview-tab-claude'),
                  label: 'Claude',
                ),
                CanopyModelTab(
                  key: ValueKey('preview-tab-cursor'),
                  label: 'Cursor',
                  muted: true,
                ),
              ],
              selectedIndex: _tab,
              onSelected: (index) => setState(() => _tab = index),
            ),
            const SizedBox(height: 24),
            Text('Rows', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            CanopyModelRow(
              vendor: 'anthropic',
              label: 'Selected',
              selected: true,
              onTap: () {},
            ),
            CanopyModelRow(
              vendor: 'deepseek',
              label: 'AI credits',
              tag: CanopyModelRow.aiCreditsTag,
              onTap: () {},
            ),
            CanopyModelRow(
              vendor: 'auto',
              glyph: CanopyGlyph.sparkle,
              label: 'Auto',
              selected: true,
              explanation: 'Picks the best model for you',
              onTap: () {},
            ),
            CanopyModelRow(
              vendor: 'auto',
              glyph: CanopyGlyph.sparkle,
              label: 'Auto',
              enabled: false,
              explanation: 'Add AI Credits to use this',
              onTap: () {},
            ),
            CanopyModelRow(
              vendor: 'cursor',
              label: 'Disabled with reason',
              enabled: false,
              explanation: 'Connect Cursor in the desktop app to use it here.',
              onTap: () {},
            ),
            const SizedBox(height: 24),
            Text('Details', style: theme.textTheme.labelLarge),
            const SizedBox(height: 8),
            const CanopyModelDetails(
              title: 'Claude Opus',
              facts: [
                ('Provider', 'Anthropic'),
                ('Reasoning', 'Allows reasoning'),
                ('Context', '1M'),
              ],
              description: 'Deep reasoning for long tasks.',
              footer:
                  'Depending on your Claude plan, this model may require '
                  'extra usage credits.',
            ),
          ],
        ),
      ),
    );
  }
}
