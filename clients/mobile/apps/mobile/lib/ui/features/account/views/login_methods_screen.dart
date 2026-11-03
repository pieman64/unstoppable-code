import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:provider/provider.dart';

/// The connected login methods, each with Unlink when the server allows it.
class LoginMethodsScreen extends StatelessWidget {
  const LoginMethodsScreen({super.key});

  /// Pushes the screen. The root navigator does not see the shell-local
  /// view models, so the route re-provides the borrowed instances.
  static void open(BuildContext context) {
    final sources = context.read<AuthSourcesViewModel>();
    // Unlinking the credential source refreshes two-factor status.
    final twoFactor = context.read<TwoFactorViewModel>();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => MultiProvider(
            providers: [
              ChangeNotifierProvider<AuthSourcesViewModel>.value(
                value: sources,
              ),
              ChangeNotifierProvider<TwoFactorViewModel>.value(
                value: twoFactor,
              ),
            ],
            child: const LoginMethodsScreen(),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<AuthSourcesViewModel>();
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Login methods'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(AppDimens.padding16),
          children: [
            CanopySettingsSection(
              children: [
                if (vm.isLoading)
                  const CanopySettingsRow(
                    title: 'Login methods',
                    value: CanopySettingsValue.loading(),
                  )
                else if (vm.error != null && vm.sources.isEmpty)
                  CanopySettingsRow(
                    title: 'Could not load login methods.',
                    trailing: CanopyButton(
                      label: 'Retry',
                      variant: CanopyButtonVariant.inline,
                      onPressed: () => unawaited(vm.load()),
                    ),
                  )
                else if (vm.sources.isEmpty)
                  const CanopySettingsRow(title: 'No login methods found.')
                else
                  for (final source in vm.sources)
                    _LoginMethodRow(source: source, vm: vm),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LoginMethodRow extends StatelessWidget {
  const _LoginMethodRow({required this.source, required this.vm});

  final AuthSource source;
  final AuthSourcesViewModel vm;

  @override
  Widget build(BuildContext context) {
    final linked = formatRelativeTime(source.linkedAt);
    return CanopySettingsRow(
      title: source.label,
      subtitle: linked.isEmpty ? 'Connected' : 'Connected $linked',
      // The last remaining method cannot be removed, so the unlink action is
      // hidden entirely when the server marks it non-removable.
      trailing: source.canUnlink
          ? CanopyIconButton.custom(
              // The tooltip names the action; the glyph is not an image.
              iconBuilder: (tint, size) => ExcludeSemantics(
                child: CanopyIcon(
                  glyph: CanopyGlyph.crossMedium,
                  size: size,
                  tint: tint,
                ),
              ),
              tooltip: 'Unlink',
              onPressed: vm.isMutating ? null : () => _confirmUnlink(context),
            )
          : null,
    );
  }

  Future<void> _confirmUnlink(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Unlink login method',
      message:
          'Unlink ${source.label}? You will no longer be able to sign in with it.',
      confirmLabel: 'Unlink',
    );
    // A sign-out while the dialog was open disposed this account's scope.
    if (!confirmed || vm.isDisposed || !context.mounted) return;
    // Read before the await: unlinking the credential (email/password) source
    // changes whether the account still has a password, which the two-factor
    // flow reads via hasCredentialAuthSource. Refresh it after a successful
    // unlink so the 2FA enable/disable flow stops prompting for a password on a
    // now-OAuth-only account.
    final twoFactorVm = context.read<TwoFactorViewModel>();
    final unlinked = await vm.unlink(source);
    // The refresh needs no context, so it runs even if this route has closed,
    // but not after a sign-out disposed the account's view model.
    if (unlinked &&
        source.providerId == 'credential' &&
        !twoFactorVm.isDisposed) {
      unawaited(twoFactorVm.load());
    }
    if (unlinked || vm.isDisposed || !context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Could not unlink the login method.')),
    );
  }
}
