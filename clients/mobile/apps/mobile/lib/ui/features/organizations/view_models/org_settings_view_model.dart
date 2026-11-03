import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/org_settings_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// The four enforced telemetry-sync scopes, in display order (most invasive
/// first). `summaries` was split out of `metadata` with the AI-summary split
/// and is a first-class scope: the config PATCH is a full replacement, so a
/// scope that is not represented here is not merely unsettable, it gets
/// rewritten every time any other scope is toggled.
enum EnforcedSyncScope { transcripts, summaries, plans, metadata }

/// Manages the organization-settings screen: the enforced telemetry-sync
/// toggles and the org-level GitHub App connection status + disconnect.
///
/// Gating mirrors the web `canEditOrg` / `canEditOrgEnforcedSettings` rule
/// (OWNER + ADMIN) and the members screen's own `canManageMembers` getter.
final class OrgSettingsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  OrgSettingsViewModel({required this.repository});

  final OrgSettingsRepository repository;

  bool _isLoading = false;
  bool _isBusy = false;
  OrganizationDetail? _organization;
  Object? _error;
  Object? _actionError;

  /// True while the initial/refresh org load is in flight.
  bool get isLoading => _isLoading;

  /// True while a toggle/disconnect mutation is in flight.
  bool get isBusy => _isBusy;

  /// The loaded organization, or null before the first successful load.
  OrganizationDetail? get organization => _organization;

  /// Non-null when the most recent load failed.
  Object? get error => _error;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  /// Non-null when the most recent mutation failed.
  Object? get actionError => _actionError;

  /// The structured org-billing lapse payload when the most recent mutation
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get actionPlanLapse => errorOrgTeamsLapse(_actionError);

  /// User-presentable copy for the most recent mutation failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get actionErrorMessage => presentableErrorMessage(_actionError);

  /// The current enforced-sync scopes, or all-unset before load.
  ///
  /// The fallback is deliberately all-`null` rather than all-`false`: `false`
  /// means PROHIBITED, so a false-filled placeholder would be a policy this
  /// screen invented, and it is this value a write rebuilds the full scope set
  /// from.
  EnforcedSyncScopes get enforcedSync =>
      _organization?.enforcedSync ?? const EnforcedSyncScopes();

  /// The current GitHub connection status, or disconnected before load.
  OrganizationGitHubConnectionDetail get githubConnection =>
      _organization?.githubConnection ??
      const OrganizationGitHubConnectionDetail(
        connected: false,
        accountLogin: null,
      );

  /// Whether the viewer may edit org settings (ADMIN or OWNER). Mirrors the
  /// backend `canEditOrg` rule (rank >= ADMIN).
  bool get canEditSettings {
    final role = _organization?.viewerRole;
    return role == OrganizationRole.admin || role == OrganizationRole.owner;
  }

  /// Whether [scope] is REQUIRED by the org.
  ///
  /// Compared with `== true` on purpose: the scope is three-state, so `false`
  /// (prohibited) and `null` (unset) are both "not required" here but are very
  /// different states, and a `!= true` test would fold them together the wrong
  /// way round on the write path.
  bool isScopeEnforced(EnforcedSyncScope scope) => switch (scope) {
    EnforcedSyncScope.transcripts => enforcedSync.transcripts == true,
    EnforcedSyncScope.summaries => enforcedSync.summaries == true,
    EnforcedSyncScope.plans => enforcedSync.plans == true,
    EnforcedSyncScope.metadata => enforcedSync.metadata == true,
  };

  /// Loads the organization detail, replacing any existing state.
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      _organization = await repository.fetchOrganization();
    } catch (e) {
      _error = e;
      _organization = null;
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Runs [action] with busy + error bookkeeping, notifying on each edge.
  /// Rethrows so callers can surface a snackbar on failure.
  Future<void> _runAction(Future<void> Function() action) async {
    _isBusy = true;
    _actionError = null;
    notifyListenersSafe();
    try {
      await action();
    } catch (e) {
      _actionError = e;
      rethrow;
    } finally {
      _isBusy = false;
      notifyListenersSafe();
    }
  }

  /// Sets [scope] to [enforced], sending the FULL scope set (the server treats
  /// `enforcedSync` as a full replacement of all four scopes). Every untouched
  /// scope is carried over from the currently loaded config verbatim (`false`
  /// and `null` included), so toggling one scope never rewrites another. Then
  /// refetches the org so the returned value is reflected.
  Future<void> setScopeEnforced(EnforcedSyncScope scope, bool enforced) =>
      _runAction(() async {
        final next = _withScope(enforcedSync, scope, enforced);
        await repository.setEnforcedSync(next);
        _organization = await repository.fetchOrganization();
      });

  /// Disconnects the org-level GitHub App, then refetches the org so the status
  /// row reflects the disconnected state.
  Future<void> disconnectGitHub() => _runAction(() async {
    await repository.disconnectGitHub();
    _organization = await repository.fetchOrganization();
  });

  /// Returns a copy of [scopes] with [scope] overridden to [value]. The single
  /// place that reconstructs the immutable generated [EnforcedSyncScopes].
  ///
  /// Every scope other than [scope] is copied through untouched, which is what
  /// makes the full-replacement PATCH safe: a scope this screen does not change
  /// keeps its stored three-state value instead of being reset.
  static EnforcedSyncScopes _withScope(
    EnforcedSyncScopes scopes,
    EnforcedSyncScope scope,
    bool value,
  ) => EnforcedSyncScopes(
    transcripts: scope == EnforcedSyncScope.transcripts
        ? value
        : scopes.transcripts,
    summaries: scope == EnforcedSyncScope.summaries ? value : scopes.summaries,
    plans: scope == EnforcedSyncScope.plans ? value : scopes.plans,
    metadata: scope == EnforcedSyncScope.metadata ? value : scopes.metadata,
  );
}
