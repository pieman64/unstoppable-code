import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/sub_teams_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages state for the Sub-teams screen: the org's sub-teams, the members
/// (for the membership picker), the viewer's permission, and the create /
/// rename / delete / membership mutations.
///
/// Every mutation replaces [organization] from the [OrganizationDetail] the
/// backend returns, so `memberCount` and each member's `subTeamIds` stay
/// consistent without a separate refetch.
final class SubTeamsViewModel extends ChangeNotifier with DisposeSafeNotifier {
  SubTeamsViewModel({required this.repository});

  final SubTeamsRepository repository;

  bool _isLoading = false;
  OrganizationDetail? _organization;
  Object? _error;
  bool _isBusy = false;
  Object? _actionError;

  /// True while the initial/refresh org load is in flight.
  bool get isLoading => _isLoading;

  /// The loaded org detail, or `null` before the first successful load.
  OrganizationDetail? get organization => _organization;

  /// Non-null when the initial load failed.
  Object? get error => _error;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  /// True while a create/rename/delete/membership mutation is in flight.
  bool get isBusy => _isBusy;

  /// Non-null when the most recent mutation failed.
  Object? get actionError => _actionError;

  /// The structured org-billing lapse payload when the most recent mutation
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get actionPlanLapse => errorOrgTeamsLapse(_actionError);

  /// User-presentable copy for the most recent mutation failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get actionErrorMessage => presentableErrorMessage(_actionError);

  /// The org's sub-teams, or an empty list before load.
  List<OrganizationSubTeam> get subTeams => _organization?.subTeams ?? const [];

  /// The org's members, or an empty list before load.
  List<OrganizationMember> get members => _organization?.members ?? const [];

  /// Whether the viewer may create/rename/delete sub-teams and manage their
  /// membership (ADMIN or OWNER), mirroring the web `canManageSubTeams` helper.
  bool get canManageSubTeams {
    final role = _organization?.viewerRole;
    return role == OrganizationRole.admin || role == OrganizationRole.owner;
  }

  /// The members currently assigned to sub-team [teamId].
  List<OrganizationMember> membersInTeam(String teamId) => members
      .where((m) => m.subTeamIds.contains(teamId))
      .toList(growable: false);

  /// Loads the organization detail (sub-teams + members + viewer role).
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
  /// Rethrows so callers can react (e.g. surface a snackbar).
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

  /// Creates a sub-team named [name], replacing the org from the returned
  /// detail.
  Future<void> createSubTeam(String name) => _runAction(() async {
    _organization = await repository.createSubTeam(name);
  });

  /// Renames sub-team [teamId] to [name], replacing the org from the detail.
  Future<void> renameSubTeam(String teamId, String name) =>
      _runAction(() async {
        _organization = await repository.renameSubTeam(
          teamId: teamId,
          name: name,
        );
      });

  /// Deletes sub-team [teamId], replacing the org from the returned detail.
  Future<void> deleteSubTeam(String teamId) => _runAction(() async {
    _organization = await repository.deleteSubTeam(teamId);
  });

  /// Replaces sub-team [teamId]'s membership with [memberUserIds] (member ids),
  /// replacing the org from the returned detail.
  Future<void> setMembership(String teamId, List<String> memberUserIds) =>
      _runAction(() async {
        _organization = await repository.setMembership(
          teamId: teamId,
          memberUserIds: memberUserIds,
        );
      });
}
