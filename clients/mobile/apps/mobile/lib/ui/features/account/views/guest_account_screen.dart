import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:mobile/ui/features/settings/views/help_settings_section.dart';

/// Settings for a guest (CAN-2872). A guest has no profile, sign-in methods,
/// two-factor or API keys, and the server takes feedback only from accounts,
/// so this offers sign-in, the licenses and repository link, and leaving guest
/// mode instead of [AccountScreen]'s sections.
class GuestAccountScreen extends StatelessWidget {
  const GuestAccountScreen({
    super.key,
    required this.onSignIn,
    required this.onLeaveGuestMode,
  });

  /// Opens the guest sign-in screen. The app shell supplies both actions, so
  /// Settings does not reach into the auth feature.
  final void Function(BuildContext context) onSignIn;

  /// Ends the guest session.
  final Future<void> Function() onLeaveGuestMode;

  static const _sectionGap = SizedBox(height: AppDimens.padding32);

  @override
  Widget build(BuildContext context) {
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const Text('Settings'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(AppDimens.padding16),
          children: [
            CanopySettingsSection(
              heading: 'Guest account',
              children: [
                CanopySettingsRow(
                  key: const ValueKey('guest-sign-in-row'),
                  glyph: CanopyGlyph.user,
                  title: 'Sign in',
                  subtitle: 'Keep your chats and use them on other devices.',
                  trailing: const CanopySettingsChevron(),
                  onTap: () => onSignIn(context),
                ),
              ],
            ),
            _sectionGap,
            CanopySettingsSection(
              heading: 'Help',
              children: [
                CanopySettingsRow(
                  key: const ValueKey('open-source-licenses'),
                  glyph: CanopyGlyph.fileText,
                  title: 'Open source licenses',
                  trailing: const CanopySettingsChevron(),
                  onTap: () => showLicensePage(context: context),
                ),
                const OpenSourceRepositoryRow(),
              ],
            ),
            _sectionGap,
            CanopySettingsSection(
              children: [
                CanopySettingsRow.destructive(
                  key: const ValueKey('guest-leave-row'),
                  glyph: CanopyGlyph.arrowBoxRight,
                  title: 'Leave guest mode',
                  onTap: () => unawaited(_leave(context)),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _leave(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Leave guest mode?',
      message: 'Your guest chats stay behind. To keep them, sign in first.',
      confirmLabel: 'Leave',
      confirmKey: const ValueKey('guest-leave-confirm'),
    );
    if (confirmed) await onLeaveGuestMode();
  }
}
