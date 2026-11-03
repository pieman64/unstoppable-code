import 'dart:async';

import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/ui/core/action_dialogs.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/organizations/org_lapse_presentation.dart';
import 'package:mobile/ui/features/organizations/view_models/org_settings_view_model.dart';

/// Display metadata for each enforced telemetry-sync scope. Labels + copy mirror
/// the web `team-usage-settings-section` so the two surfaces stay consistent.
class _ScopeMeta {
  const _ScopeMeta({
    required this.scope,
    required this.label,
    required this.description,
  });

  final EnforcedSyncScope scope;
  final String label;
  final String description;
}

const List<_ScopeMeta> _scopeMeta = [
  _ScopeMeta(
    scope: EnforcedSyncScope.transcripts,
    label: 'Transcripts',
    description: 'Full chat and agent conversation text.',
  ),
  // Split out of Usage details with the AI-summary split. The description names
  // the derivation on purpose: an org that blocks transcripts must be able to
  // see that summaries are still LLM prose about those same conversations.
  _ScopeMeta(
    scope: EnforcedSyncScope.summaries,
    label: 'Session summaries',
    description:
        'AI-written recaps of what each agent session did, generated from '
        'the conversation.',
  ),
  _ScopeMeta(
    scope: EnforcedSyncScope.plans,
    label: 'Plans',
    description: 'Generated implementation plans.',
  ),
  _ScopeMeta(
    scope: EnforcedSyncScope.metadata,
    label: 'Usage details',
    description: 'Token counts, cost, timing, and tool-usage rollups.',
  ),
];

/// Organization-wide settings: which telemetry-sync scopes are enforced on
/// members, and the org-level GitHub App connection status + disconnect.
///
/// Editing is an ADMIN+/OWNER action; the screen renders a read-only "no
/// access" state for lower-ranked viewers as defense in depth even though the
/// entry point is already gated.
///
/// The [OrgSettingsViewModel] is provided lazily (it is not needed until this
/// screen is pushed), so this screen kicks off its initial [load] on mount.
class OrgSettingsScreen extends StatefulWidget {
  const OrgSettingsScreen({super.key});

  @override
  State<OrgSettingsScreen> createState() => _OrgSettingsScreenState();
}

class _OrgSettingsScreenState extends State<OrgSettingsScreen> {
  @override
  void initState() {
    super.initState();
    // Defer the initial load to after the first frame: load() synchronously
    // flips isLoading and notifies, which would otherwise mark the provider
    // dirty during the initial build. A completed load (e.g. re-entering the
    // screen) simply re-fetches.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final viewModel = context.read<OrgSettingsViewModel>();
      if (viewModel.organization == null && !viewModel.isLoading) {
        unawaited(viewModel.load());
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<OrgSettingsViewModel>();

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: const Text('Organization settings'),
      ),
      body: Builder(
        builder: (context) => Builder(
          builder: (context) {
            if (viewModel.isLoading) {
              return const Center(child: CircularProgressIndicator());
            }
            if (viewModel.error != null || viewModel.organization == null) {
              return StateMessageView(
                glyph: CanopyGlyph.settingsGear2,
                title: 'Could not load organization settings',
                message: viewModel.errorMessage,
                onRetry: viewModel.load,
              );
            }
            if (!viewModel.canEditSettings) {
              return const _NoAccessState();
            }
            return RefreshIndicator(
              edgeOffset: CanopyScaffold.contentPaddingOf(context).top,
              onRefresh: viewModel.load,
              child: _SettingsBody(viewModel: viewModel),
            );
          },
        ),
      ),
    );
  }
}

class _SettingsBody extends StatelessWidget {
  const _SettingsBody({required this.viewModel});

  final OrgSettingsViewModel viewModel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListView(
      padding:
          CanopyScaffold.contentPaddingOf(context) +
          const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      children: [
        Text(
          'Required member settings',
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Enabling a scope forces it to Organization visibility on every '
          "member's desktop and locks it.",
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 8),
        for (final meta in _scopeMeta)
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(meta.label),
            subtitle: Text(meta.description),
            value: viewModel.isScopeEnforced(meta.scope),
            onChanged: viewModel.isBusy
                ? null
                : (value) => unawaited(
                    _setScope(context, viewModel, meta.scope, value),
                  ),
          ),
        const SizedBox(height: 16),
        const Divider(),
        const SizedBox(height: 8),
        _GitHubSection(viewModel: viewModel),
      ],
    );
  }

  Future<void> _setScope(
    BuildContext context,
    OrgSettingsViewModel viewModel,
    EnforcedSyncScope scope,
    bool enforced,
  ) => guardAction(
    context,
    () => viewModel.setScopeEnforced(scope, enforced),
    'Could not update the enforced sync setting.',
    failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
  );
}

class _GitHubSection extends StatelessWidget {
  const _GitHubSection({required this.viewModel});

  final OrgSettingsViewModel viewModel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final connection = viewModel.githubConnection;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'GitHub connection',
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          'Connect the GitHub App so pull request merge state and diff stats in '
          'the timeline are pulled straight from GitHub.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        if (connection.connected)
          _ConnectedRow(viewModel: viewModel, connection: connection)
        else
          const _DisconnectedRow(),
      ],
    );
  }
}

class _ConnectedRow extends StatelessWidget {
  const _ConnectedRow({required this.viewModel, required this.connection});

  final OrgSettingsViewModel viewModel;
  final OrganizationGitHubConnectionDetail connection;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final login = connection.accountLogin;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.check_circle, color: theme.colorScheme.primary),
      title: const Text('Connected'),
      subtitle: Text(
        login == null ? 'GitHub App installed' : 'Installed on $login',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: TextButton(
        onPressed: viewModel.isBusy
            ? null
            : () => unawaited(_disconnect(context)),
        child: const Text('Disconnect'),
      ),
    );
  }

  Future<void> _disconnect(BuildContext context) async {
    final confirmed = await confirmDestructive(
      context,
      title: 'Disconnect GitHub',
      message:
          'Disconnect the GitHub App from this organization? Timeline pull '
          'request data will no longer be refreshed from GitHub.',
      confirmLabel: 'Disconnect',
    );
    if (!confirmed) return;
    if (!context.mounted) return;
    await guardAction(
      context,
      viewModel.disconnectGitHub,
      'Could not disconnect GitHub.',
      failureMessageBuilder: (error) => _lapseActionMessage(error, viewModel),
    );
  }
}

String? _lapseActionMessage(Object error, OrgSettingsViewModel viewModel) {
  final org = viewModel.organization;
  return orgLapseActionMessage(
    error,
    orgName: org?.name,
    viewerRole: org?.viewerRole,
  );
}

class _DisconnectedRow extends StatelessWidget {
  const _DisconnectedRow();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(Icons.link_off, color: theme.colorScheme.onSurfaceVariant),
      title: const Text('Not connected'),
      // Connect is an OAuth GitHub App install that redirects back to the web
      // app's fixed Setup URL and completes via an HttpOnly state cookie in that
      // web session; it cannot cleanly return to a mobile deep-link scheme, so
      // connecting is deferred to the web app for now (status + disconnect work
      // here). See the PR notes / CAN-925 for the deferral rationale.
      subtitle: const Text('Connect the GitHub App from the web dashboard.'),
    );
  }
}

class _NoAccessState extends StatelessWidget {
  const _NoAccessState();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Text(
          'Only organization owners and admins can change these settings.',
          style: theme.textTheme.bodyMedium,
          textAlign: TextAlign.center,
        ),
      ),
    );
  }
}
