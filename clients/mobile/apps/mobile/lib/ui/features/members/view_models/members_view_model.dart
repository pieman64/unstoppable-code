import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/models/org_invite.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages state for the Members screen: the org member list, the viewer's
/// permissions, the pending outgoing invites, and the invite action.
final class MembersViewModel extends ChangeNotifier with DisposeSafeNotifier {
  MembersViewModel({required this.repository});

  final MembersRepository repository;

  bool _isLoading = false;
  OrganizationDetail? _organization;
  List<OutgoingInvite> _pendingInvites = const [];
  List<IncomingInvitation> _incomingInvitations = const [];
  Object? _error;
  bool _isBusy = false;
  Object? _actionError;

  bool get isLoading => _isLoading;
  OrganizationDetail? get organization => _organization;
  List<OutgoingInvite> get pendingInvites => List.unmodifiable(_pendingInvites);
  List<IncomingInvitation> get incomingInvitations =>
      List.unmodifiable(_incomingInvitations);
  Object? get error => _error;

  /// The structured org-billing lapse payload when the most recent load
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get planLapse => errorOrgTeamsLapse(_error);

  /// User-presentable copy for the most recent load failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get errorMessage => presentableErrorMessage(_error);

  bool get isBusy => _isBusy;
  Object? get actionError => _actionError;

  /// The structured org-billing lapse payload when the most recent mutation
  /// failed because the organization lost its team features, else null.
  OrgTeamsLapsedError? get actionPlanLapse => errorOrgTeamsLapse(_actionError);

  /// User-presentable copy for the most recent mutation failure, or null when
  /// only generic copy is honest (5xx, transport). Never a raw exception dump.
  String? get actionErrorMessage => presentableErrorMessage(_actionError);

  /// Whether the viewer may invite/manage members (ADMIN or OWNER).
  bool get canManageMembers {
    final role = _organization?.viewerRole;
    return role == OrganizationRole.admin || role == OrganizationRole.owner;
  }

  /// Whether the viewer may grant the ADMIN role (OWNER only).
  bool get canGrantAdmin => _organization?.viewerRole == OrganizationRole.owner;

  /// Whether the viewer may change member roles (OWNER only).
  bool get canChangeRoles =>
      _organization?.viewerRole == OrganizationRole.owner;

  /// Whether the viewer may edit the usage-stats config (ADMIN+).
  bool get canEditUsageStatsConfig => canManageMembers;

  /// Whether the viewer may remove [member]: they can manage members and
  /// strictly outrank the target (excludes self and equal-rank owners).
  bool canRemove(OrganizationMember member) {
    final viewerRole = _organization?.viewerRole;
    if (viewerRole == null || !canManageMembers) return false;
    return _rank(viewerRole) > _rank(member.role);
  }

  int _rank(OrganizationRole role) => switch (role) {
    OrganizationRole.owner => 3,
    OrganizationRole.admin => 2,
    OrganizationRole.member => 1,
  };

  /// Loads the organization detail and pending invites together.
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      // Await all requests together so no future is orphaned: if one request
      // throws, the others are still awaited rather than failing as an
      // unhandled async error. `.wait` preserves each result's type, so no
      // casts are needed.
      final (organization, invites, incoming) = await (
        repository.fetchOrganization(),
        repository.fetchPendingInvites(),
        repository.fetchIncomingInvitations(),
      ).wait;
      _organization = organization;
      _pendingInvites = invites;
      _incomingInvitations = incoming;
    } catch (e) {
      _error = e;
      _organization = null;
      _pendingInvites = const [];
      _incomingInvitations = const [];
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Sends an invite and prepends it to [pendingInvites].  Rethrows on failure
  /// so the caller can surface an error.
  Future<OutgoingInvite> submitInvite({
    required String email,
    required OrganizationRole role,
  }) async {
    final invite = await repository.inviteMember(email: email, role: role);
    _pendingInvites = [invite, ..._pendingInvites];
    notifyListenersSafe();
    return invite;
  }

  /// Runs [action] with busy + error bookkeeping, notifying on each edge.
  /// Rethrows so callers can react (e.g. surface a snackbar) if needed.
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

  /// Changes [memberId]'s role, replacing the org from the returned detail.
  Future<void> changeMemberRole(String memberId, OrganizationRole role) =>
      _runAction(() async {
        _organization = await repository.changeMemberRole(
          memberId: memberId,
          role: role,
        );
      });

  /// Removes [memberId], replacing the org from the returned detail.
  Future<void> removeMember(String memberId) => _runAction(() async {
    _organization = await repository.removeMember(memberId);
  });

  /// Revokes an outgoing invite and drops it from [pendingInvites].
  Future<void> revokeInvite(String inviteId) => _runAction(() async {
    await repository.revokeInvite(inviteId);
    _pendingInvites = _pendingInvites
        .where((i) => i.id != inviteId)
        .toList(growable: false);
  });

  /// Accepts an incoming invitation and drops it from [incomingInvitations].
  Future<void> acceptInvitation(String inviteId) => _runAction(() async {
    await repository.respondToInvitation(inviteId: inviteId, accept: true);
    _incomingInvitations = _incomingInvitations
        .where((i) => i.id != inviteId)
        .toList(growable: false);
  });

  /// Declines an incoming invitation and drops it from [incomingInvitations].
  Future<void> declineInvitation(String inviteId) => _runAction(() async {
    await repository.respondToInvitation(inviteId: inviteId, accept: false);
    _incomingInvitations = _incomingInvitations
        .where((i) => i.id != inviteId)
        .toList(growable: false);
  });

  /// Sets the usage-stats min role, then refetches the org detail so the new
  /// value and `canViewUsageStats` are reflected (generated detail is immutable).
  Future<void> setUsageStatsMinRole(OrganizationRole role) =>
      _runAction(() async {
        await repository.setUsageStatsMinRole(role);
        _organization = await repository.fetchOrganization();
      });
}
