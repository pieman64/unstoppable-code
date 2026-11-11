import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_row.dart';
import 'package:mobile/core/design-system/settings-list/canopy_settings_section.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/features/account/view_models/opencode_usage_policy.dart';
import 'package:mobile/ui/features/account/view_models/usage_limits_policy.dart';
import 'package:mobile/ui/features/account/views/widgets/usage_limit_window_card.dart';
import 'package:mobile/ui/core/dimens.dart';

/// Display-only native metadata, matching the desktop/Portal account card.
/// Each provider can have its own selected account; none is a global identity.
class OpenCodeAccountsSection extends StatelessWidget {
  const OpenCodeAccountsSection({
    required this.snapshot,
    required this.now,
    super.key,
  });

  final OpenCodeAccountSnapshot snapshot;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('opencode-accounts'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        CanopySettingsSection(
          heading: 'OpenCode',
          children: [
            if (snapshot.status != 'ready')
              // Refresh and native sign-in remain desktop-owned. Do not imply
              // this read-only card can repair a native connection on the phone.
              const CanopySettingsRow(
                title: 'Account information is unavailable.',
                subtitle: 'Refresh usage on your desktop.',
              )
            else if (snapshot.providers.isEmpty)
              const CanopySettingsRow(
                title: 'No providers reported by OpenCode.',
              )
            else
              for (final provider in snapshot.providers)
                if (provider.accounts.isEmpty)
                  CanopySettingsRow(
                    title: _providerName(provider),
                    subtitle: 'No account information reported.',
                  )
                else
                  // Lead with the provider, as the shared desktop/Portal card
                  // does, so two accounts labelled "Personal" stay distinct.
                  for (final account in provider.accounts) ...[
                    CanopySettingsRow(
                      title: _providerName(provider),
                      subtitle: [
                        account.label.isEmpty
                            ? 'Account name unavailable'
                            : account.label,
                        _methodLabel(account.method),
                        if (account.selected) 'Selected for this provider',
                        if (account.needsSignIn) 'Sign in again on desktop',
                        openCodeUsageDescription(account.usage),
                      ].join(' · '),
                    ),
                    for (final window in openCodeUsageWindows(account.usage))
                      Padding(
                        padding: const EdgeInsets.all(AppDimens.padding8),
                        child: UsageLimitWindowCard(
                          window: window,
                          resetPassed: isUsageResetPassed(window, now),
                          resetLabel: switch (usageResetAt(window)) {
                            final resetAt? =>
                              'Resets ${_formatReset(context, resetAt)}',
                            null => null,
                          },
                        ),
                      ),
                  ],
          ],
        ),
      ],
    );
  }
}

String _providerName(OpenCodeAccountProvider provider) =>
    provider.name.isEmpty ? 'Provider name unavailable' : provider.name;

String _methodLabel(OpenCodeAccountMethod method) => switch (method) {
  OpenCodeAccountMethod.key => 'API key',
  OpenCodeAccountMethod.oauth => 'Browser sign-in',
  OpenCodeAccountMethod.external => 'External credentials',
  OpenCodeAccountMethod.env => 'Environment variable',
};

String _formatReset(BuildContext context, DateTime value) {
  final local = value.toLocal();
  final labels = MaterialLocalizations.of(context);
  return '${labels.formatShortDate(local)} ${labels.formatTimeOfDay(TimeOfDay.fromDateTime(local))}';
}
