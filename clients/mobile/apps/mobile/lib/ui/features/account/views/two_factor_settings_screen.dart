import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';
import 'package:mobile/ui/features/account/views/two_factor_dialogs.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:provider/provider.dart';

/// Two-factor authentication status, with the enable (enroll, verify) and
/// disable flows against [TwoFactorViewModel].
class TwoFactorSettingsScreen extends StatelessWidget {
  const TwoFactorSettingsScreen({super.key});

  /// Pushes the screen, re-providing the borrowed shell-local view model.
  /// [AuthViewModel] lives above the root navigator already.
  static void open(BuildContext context) {
    final vm = context.read<TwoFactorViewModel>();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChangeNotifierProvider<TwoFactorViewModel>.value(
            value: vm,
            child: const TwoFactorSettingsScreen(),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<TwoFactorViewModel>();
    final enabled = vm.enabled;
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Two-factor authentication'),
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
                    glyph: CanopyGlyph.shield,
                    title: 'Status',
                    value: CanopySettingsValue.loading(),
                  )
                else if (vm.loadFailed)
                  CanopySettingsRow(
                    glyph: CanopyGlyph.shield,
                    title: 'Could not load two-factor status.',
                    trailing: CanopyButton(
                      label: 'Retry',
                      variant: CanopyButtonVariant.inline,
                      onPressed: () => unawaited(vm.load()),
                    ),
                  )
                else ...[
                  CanopySettingsRow(
                    glyph: enabled
                        ? CanopyGlyph.shieldCheck
                        : CanopyGlyph.shield,
                    title: enabled ? 'Enabled' : 'Disabled',
                    subtitle: enabled
                        ? 'A code from your authenticator app is required at '
                              'sign-in.'
                        : 'Add an authenticator app to require a code at '
                              'sign-in.',
                  ),
                  if (enabled)
                    CanopySettingsRow.destructive(
                      glyph: CanopyGlyph.lock,
                      title: 'Disable',
                      enabled: !vm.isMutating,
                      onTap: () => unawaited(_confirmDisable(context, vm)),
                    )
                  else
                    CanopySettingsRow(
                      glyph: CanopyGlyph.plusMedium,
                      title: 'Enable',
                      enabled: !vm.isMutating,
                      onTap: () => unawaited(_startEnroll(context, vm)),
                    ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _startEnroll(
    BuildContext routeContext,
    TwoFactorViewModel vm,
  ) async {
    final context = _flowContext(routeContext);
    final password = vm.hasCredentialAuthSource
        ? await promptForAccountPassword(
            context,
            action: 'enable two-factor authentication',
          )
        : null;
    if (vm.isDisposed ||
        !context.mounted ||
        (vm.hasCredentialAuthSource && password == null)) {
      return;
    }
    final started = await vm.beginEnrollment(password: password);
    if (vm.isDisposed) {
      // The account scope ended: discard the secret without showing it.
      vm.cancelEnrollment();
      return;
    }
    if (!context.mounted) return;
    if (!started) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(twoFactorFailureMessage(vm.failure))),
      );
      return;
    }
    final enrollment = vm.enrollment;
    if (enrollment == null) return;
    // Collect and verify the first code. The dialog owns retries against the vm
    // and pops with `true` once the code is accepted.
    final verified = await showEnrollDialog(context, vm, enrollment);
    if (verified != true) {
      // Dialog dismissed without a successful verify: discard the secret.
      vm.cancelEnrollment();
      return;
    }
    // An ended account scope discards its backup codes without showing them.
    final codes = vm.lastBackupCodes;
    if (!vm.isDisposed &&
        context.mounted &&
        codes != null &&
        codes.isNotEmpty) {
      await showBackupCodes(context, codes);
    }
    vm.acknowledgeBackupCodes();
    if (vm.isDisposed || !context.mounted) return;
    await showReauthAfterTwoFactorChange(context, enabled: true);
    if (vm.isDisposed || !context.mounted) return;
    await _signOut(context);
  }

  Future<void> _confirmDisable(
    BuildContext routeContext,
    TwoFactorViewModel vm,
  ) async {
    final context = _flowContext(routeContext);
    final confirmed = await confirmDestructive(
      context,
      title: 'Disable two-factor authentication',
      message:
          'Sign-in will no longer require a code from your authenticator app. '
          'Are you sure?',
      confirmLabel: 'Disable',
    );
    if (!confirmed || vm.isDisposed || !context.mounted) return;
    final password = vm.hasCredentialAuthSource
        ? await promptForAccountPassword(
            context,
            action: 'disable two-factor authentication',
          )
        : null;
    if (vm.isDisposed ||
        !context.mounted ||
        (vm.hasCredentialAuthSource && password == null)) {
      return;
    }
    final ok = await vm.disable(password: password);
    if (vm.isDisposed || !context.mounted) return;
    if (ok) {
      await showReauthAfterTwoFactorChange(context, enabled: false);
      if (vm.isDisposed || !context.mounted) return;
      await _signOut(context);
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(twoFactorFailureMessage(vm.failure))),
    );
  }

  /// The root navigator's context, for a flow started on this screen. The
  /// user can leave this route while a request runs, but a started
  /// enrollment must still show or discard its secret, and a disable must
  /// still lead to sign-out. Dialogs already open on the root navigator.
  /// The root navigator outlives the account, so a flow also stops after each
  /// dialog or request when a sign-out or another account's sign-in disposed
  /// its view model: it must not change or sign out the current account.
  static BuildContext _flowContext(BuildContext routeContext) =>
      Navigator.of(routeContext).context;

  /// Signs out after a two-factor change. This screen is a pushed route, so
  /// it returns to the first route first: the auth gate swaps that route's
  /// content, and a route left above it would outlive the signed-in shell.
  Future<void> _signOut(BuildContext context) async {
    final auth = context.read<AuthViewModel>();
    Navigator.of(context).popUntil((route) => route.isFirst);
    await auth.signOut();
  }
}
