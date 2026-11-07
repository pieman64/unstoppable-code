import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/external_links.dart';
import 'package:mobile/ui/features/settings/views/widgets/feedback_report_sheet.dart';

/// Settings' Help section: Send feedback, the offline open source licenses
/// for bundled fonts and dependencies, then a link to the source repository.
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
      const OpenSourceRepositoryRow(),
    ],
  );
}

/// Opens the app's public source repository in the browser. Shared with the
/// guest Settings screen's Help section.
class OpenSourceRepositoryRow extends StatelessWidget {
  const OpenSourceRepositoryRow({super.key});

  @override
  Widget build(BuildContext context) => CanopySettingsRow(
    key: const ValueKey('open-source-repository'),
    glyph: CanopyGlyph.github,
    title: 'We are open source! Check our repository',
    onTap: () => unawaited(
      openExternalUrl(
        'https://github.com/unstoppable-si/unstoppable-code/tree/main',
      ),
    ),
  );
}
