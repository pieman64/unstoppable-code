import 'dart:async';

import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';

/// The Members tab when the organization list could not be loaded, so the app
/// cannot tell whether this account belongs to an organization.
///
/// Deliberately distinct from the no-organization state: membership here is
/// unknown, not known-empty. Offering "create an organization" would invite a
/// user whose existing org merely failed to fetch — a request timeout, or the
/// teams API gated off for their account — to create a duplicate of one they
/// already own. So this state only retries.
///
/// It is a tab rather than a full-screen wall for the same reason the
/// no-organization state is (CAN-2576): the teams API can be flag-gated off
/// for an account, in which case retrying never succeeds, and blocking the
/// whole app would lock that user out of Remote Control and Account
/// permanently — neither of which needs an organization.
///
/// Sign-out lives on the Account tab, which is reachable from here.
class OrganizationsUnavailableScreen extends StatelessWidget {
  const OrganizationsUnavailableScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: HomeMenuButton.maybeOf(context, designSystem: true),
        content: const Text('Members'),
      ),
      body: Builder(
        builder: (context) => Padding(
          padding: CanopyScaffold.contentPaddingOf(context),
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.cloud_off_outlined,
                    size: 48,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    "Couldn't load your organizations",
                    style: theme.textTheme.titleLarge,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Check your connection and try again.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  const _RetryButton(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Retry, showing progress while the reload is in flight.
///
/// Without visible feedback users tap repeatedly, and `AuthViewModel` would
/// then have several org loads racing. It resolves them last-started-wins, so
/// the result stays correct either way, but the wasted requests and the
/// dead-feeling button are worth avoiding.
class _RetryButton extends StatelessWidget {
  const _RetryButton();

  @override
  Widget build(BuildContext context) {
    final isLoading = context.select<AuthViewModel, bool>(
      (auth) => auth.isLoadingOrganizations,
    );
    if (isLoading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 8),
        child: SizedBox(
          height: 24,
          width: 24,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return FilledButton(
      onPressed: () => unawaited(_retry(context)),
      child: const Text('Retry'),
    );
  }

  /// Retries, and says so when it fails again.
  ///
  /// Without this a failed retry re-renders a byte-identical screen, which is
  /// indistinguishable from the button not having worked at all.
  Future<void> _retry(BuildContext context) async {
    final auth = context.read<AuthViewModel>();
    final messenger = ScaffoldMessenger.of(context);
    await auth.refreshActiveOrg();
    if (!auth.organizationsLoadFailed) return;
    messenger.showSnackBar(
      const SnackBar(content: Text("Still couldn't load your organizations.")),
    );
  }
}
