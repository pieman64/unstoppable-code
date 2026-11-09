import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/data/models/start_screen.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_menu_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_switch_row.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/theme_controller.dart';
import 'package:mobile/ui/core/start_screen_controller.dart';
import 'package:mobile/ui/core/usage_data_controller.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/settings/view_models/notifications_view_model.dart';
import 'package:mobile/ui/features/settings/views/widgets/server_environment_row.dart';
import 'package:provider/provider.dart';

/// Settings' App section: the appearance and start-screen pickers, backed by
/// [ThemeController] and [StartScreenController], the push toggle, backed by
/// [NotificationsViewModel] (provided above the auth gate in `main.dart` so
/// it persists across sign-out and org switches), the Crash reports and Usage
/// analytics switches, backed by [UsageDataController] (device-local, and not
/// narrowed by any organization policy), and the server environment while
/// staging is active.
class AppSettingsSection extends StatelessWidget {
  const AppSettingsSection({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = context.watch<ThemeController>();
    final startScreen = context.watch<StartScreenController>();
    final usageData = context.watch<UsageDataController>();
    return CanopySettingsSection(
      heading: 'App',
      children: [
        CanopySettingsMenuRow<ThemeMode>(
          glyph: CanopyGlyph.brightness,
          title: 'Appearance',
          value: theme.mode,
          options: const [
            (ThemeMode.system, 'System'),
            (ThemeMode.light, 'Light'),
            (ThemeMode.dark, 'Dark'),
          ],
          onSelected: (mode) => unawaited(theme.setMode(mode)),
        ),
        CanopySettingsMenuRow<StartScreen>(
          glyph: CanopyGlyph.layoutWindow,
          title: 'Start screen',
          value: startScreen.screen,
          options: const [
            (StartScreen.newChat, 'New chat'),
            (StartScreen.projects, 'Projects'),
          ],
          enabled: !startScreen.saving,
          onSelected: (screen) => unawaited(startScreen.setScreen(screen)),
        ),
        if (startScreen.saveFailed)
          const CanopySettingsRow(
            title: "Couldn't save start screen. Try again.",
          ),
        const _PushNotificationsRow(),
        CanopySettingsSwitchRow(
          glyph: CanopyGlyph.bug,
          title: 'Crash reports',
          value: usageData.crashReportsEnabled,
          onChanged: (value) =>
              unawaited(usageData.setCrashReportsEnabled(value)),
        ),
        CanopySettingsSwitchRow(
          glyph: CanopyGlyph.electrocardiogram,
          title: 'Usage analytics',
          value: usageData.analyticsEnabled,
          onChanged: (value) => unawaited(usageData.setAnalyticsEnabled(value)),
        ),
        if (AppConfig.usesStagingServer) const ServerEnvironmentRow(),
      ],
    );
  }
}

/// The push toggle, with any load or update failure and its Retry attached
/// below it in the same card.
class _PushNotificationsRow extends StatelessWidget {
  const _PushNotificationsRow();

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<NotificationsViewModel>();
    if (vm.isLoading) {
      return const CanopySettingsRow(
        glyph: CanopyGlyph.bell,
        title: 'Push notifications',
        value: CanopySettingsValue.loading(),
      );
    }
    final activeOrg = context.read<AuthViewModel?>()?.activeOrganization;
    final failureMessage = orgLapseActionMessage(
      vm.error,
      orgName: activeOrg?.name,
      viewerRole: activeOrg?.role,
    );
    final colors = AppColors.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        CanopySettingsSwitchRow(
          glyph: CanopyGlyph.bell,
          title: 'Push notifications',
          value: vm.pushEnabled,
          onChanged: vm.isMutating
              ? null
              : (value) => unawaited(vm.setPushEnabled(value)),
        ),
        if (vm.error != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: AppDimens.navRowTitleInset,
              end: AppDimens.padding8,
              bottom: AppDimens.padding8,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    failureMessage ?? 'Could not update notification settings.',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors['fg-destructive'],
                    ),
                  ),
                ),
                CanopyButton(
                  label: 'Try again',
                  variant: CanopyButtonVariant.inline,
                  onPressed: () => unawaited(vm.load()),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
