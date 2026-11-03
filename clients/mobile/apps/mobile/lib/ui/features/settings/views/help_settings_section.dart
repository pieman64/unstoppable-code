import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/features/settings/views/widgets/feedback_report_sheet.dart';

/// Settings' Help section: Send feedback, then the offline open source
/// licenses for bundled fonts and dependencies.
class HelpSettingsSection extends StatelessWidget {
  const HelpSettingsSection({super.key});

  @override
  Widget build(BuildContext context) => CanopySettingsSection(
    heading: 'Help',
    children: [
      const SendFeedbackTile(),
      CanopySettingsRow(
        key: const ValueKey('open-source-licenses'),
        glyph: CanopyGlyph.fileText,
        title: 'Open source licenses',
        trailing: const CanopySettingsChevron(),
        onTap: () => showLicensePage(context: context),
      ),
    ],
  );
}
