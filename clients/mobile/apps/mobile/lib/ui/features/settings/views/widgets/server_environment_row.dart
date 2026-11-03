import 'package:flutter/material.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';

/// Read-only row naming the server environment the app talks to. Settings
/// shows it only while staging is active; the switch itself stays on the
/// sign-in screen because changing servers signs the user out.
class ServerEnvironmentRow extends StatelessWidget {
  const ServerEnvironmentRow({super.key});

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<ApiEnvironment>(
    valueListenable: AppConfig.environmentListenable,
    builder: (context, environment, _) => CanopySettingsRow(
      key: const ValueKey('server-environment'),
      glyph: CanopyGlyph.server,
      title: 'Server environment',
      value: CanopySettingsValue(environment.label),
    ),
  );
}
