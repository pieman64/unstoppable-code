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
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/format.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';
import 'package:mobile/ui/features/account/views/account_dialogs.dart';
import 'package:provider/provider.dart';

/// API key management: create a key, see its one-time token, and revoke keys.
class ApiKeysScreen extends StatelessWidget {
  const ApiKeysScreen({super.key});

  /// Pushes the screen, re-providing the borrowed shell-local view model.
  static void open(BuildContext context) {
    final vm = context.read<ApiKeysViewModel>();
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChangeNotifierProvider<ApiKeysViewModel>.value(
            value: vm,
            child: const ApiKeysScreen(),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final vm = context.watch<ApiKeysViewModel>();
    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('API keys'),
      ),
      body: Builder(
        builder: (context) => ListView(
          padding:
              CanopyScaffold.contentPaddingOf(context) +
              const EdgeInsets.all(AppDimens.padding16),
          children: [
            CanopySettingsSection(
              children: [
                CanopySettingsRow(
                  glyph: CanopyGlyph.plusMedium,
                  title: 'New key',
                  enabled: !vm.isMutating,
                  onTap: () => unawaited(_promptCreate(context, vm)),
                ),
              ],
            ),
            const SizedBox(height: AppDimens.padding32),
            CanopySettingsSection(
              heading: 'Keys',
              children: [
                if (vm.isLoading)
                  const CanopySettingsRow(
                    title: 'API keys',
                    value: CanopySettingsValue.loading(),
                  )
                else if (vm.error != null && vm.keys.isEmpty)
                  CanopySettingsRow(
                    title: 'Could not load API keys.',
                    trailing: CanopyButton(
                      label: 'Retry',
                      variant: CanopyButtonVariant.inline,
                      onPressed: () => unawaited(vm.load()),
                    ),
                  )
                else if (vm.keys.isEmpty)
                  const CanopySettingsRow(title: 'No API keys yet.')
                else
                  for (final key in vm.keys) _ApiKeyRow(apiKey: key, vm: vm),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _promptCreate(
    BuildContext routeContext,
    ApiKeysViewModel vm,
  ) async {
    // Run on the root navigator's context: the user can leave this route
    // while the key is created, and its one-time token must still be shown.
    // A sign-out or another account's sign-in disposes [vm] instead, and
    // then the old account's token and messages must not be shown.
    final context = Navigator.of(routeContext).context;
    final name = await promptForName(context);
    if (name == null || name.trim().isEmpty) return;
    if (vm.isDisposed || !context.mounted) return;
    final token = await vm.create(name.trim());
    if (vm.isDisposed || !context.mounted) return;
    if (token != null) {
      await showApiKeyToken(context, token);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not create the API key.')),
      );
    }
  }
}

class _ApiKeyRow extends StatelessWidget {
  const _ApiKeyRow({required this.apiKey, required this.vm});

  final UserApiKeyListItem apiKey;
  final ApiKeysViewModel vm;

  @override
  Widget build(BuildContext context) {
    final created = formatRelativeTime(apiKey.createdAt);
    final lastUsedAt = apiKey.lastUsedAt;
    final lastUsed = lastUsedAt == null
        ? 'Never used'
        : 'Last used ${formatRelativeTime(lastUsedAt)}';
    return CanopySettingsRow(
      title: apiKey.name,
      subtitle: [
        _sourceLabel(apiKey.source),
        if (created.isNotEmpty) 'Created $created',
        lastUsed,
      ].join(' · '),
      trailing: CanopyIconButton.custom(
        // The tooltip names the action; the glyph is not an image.
        iconBuilder: (tint, size) => ExcludeSemantics(
          child: CanopyIcon(
            glyph: CanopyGlyph.trashCan,
            size: size,
            tint: tint,
          ),
        ),
        tooltip: 'Revoke',
        onPressed: vm.isMutating ? null : () => _confirmRevoke(context),
      ),
    );
  }

  Future<void> _confirmRevoke(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Revoke API key',
      message:
          'Revoke "${apiKey.name}"? Any client using it will stop working.',
      confirmLabel: 'Revoke',
    );
    // This route can outlive the account scope; a disposed [vm] belongs to
    // a signed-out account, so its revoke and messages must not happen.
    if (!confirmed || vm.isDisposed || !context.mounted) return;
    final revoked = await vm.revoke(apiKey.id);
    if (vm.isDisposed || !context.mounted || revoked) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Could not revoke the API key.')),
    );
  }
}

String _sourceLabel(UserApiKeySource source) => switch (source) {
  UserApiKeySource.manual => 'Manual',
  UserApiKeySource.oauthDesktop => 'Desktop',
  UserApiKeySource.guest => 'Guest',
  UserApiKeySource.serviceAccount => 'Service account',
  UserApiKeySource.coworkSession => 'Cowork session',
};
