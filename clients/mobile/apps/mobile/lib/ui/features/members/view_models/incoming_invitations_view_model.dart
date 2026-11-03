import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/incoming_invitation.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/incoming_invitations_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages the current user's pending incoming team invitations for a surface
/// with no active organization (the no-organization screen), so a first-time
/// invitee can accept or decline an invite before any org is resolved. Backed
/// by the user-scoped [IncomingInvitationsRepository].
final class IncomingInvitationsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  IncomingInvitationsViewModel({
    required this.repository,
    this.loadTimeout = const Duration(seconds: 30),
  });

  final IncomingInvitationsRepository repository;

  /// Upper bound on a single invitations fetch.
  ///
  /// `ApiClient` sets no request timeout, and this list now reloads on resume
  /// and on pull — without a bound, a stalled socket would leave the screen
  /// loading indefinitely.
  final Duration loadTimeout;

  int _loadGeneration = 0;
  bool _hasLoaded = false;
  bool _isLoading = false;
  List<IncomingInvitation> _invitations = const [];
  Object? _error;
  bool _isBusy = false;
  Object? _actionError;
  String? _actionInviteId;

  bool get isLoading => _isLoading;
  List<IncomingInvitation> get invitations => List.unmodifiable(_invitations);
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

  /// The invitation whose response produced [actionError], if it is still in
  /// the pending list. This lets the no-organization surface name the correct
  /// org when one of several invitation accepts is refused by the lapse gate.
  IncomingInvitation? get actionErrorInvitation {
    final id = _actionInviteId;
    if (id == null) return null;
    for (final invitation in _invitations) {
      if (invitation.id == id) return invitation;
    }
    return null;
  }

  /// Whether there is at least one pending invitation to act on.
  bool get hasInvitations => _invitations.isNotEmpty;

  /// True once a load has settled, successfully or not.
  ///
  /// Callers use this to tell a first load (nothing to show yet) from a
  /// refresh (keep showing what is already there).
  bool get hasLoaded => _hasLoaded;

  /// Loads the pending invitations addressed to the current user.
  ///
  /// Four things can trigger this — the eager load at creation, pull to
  /// refresh, returning to the foreground, and Retry — so results are matched
  /// to the request that started LAST. Otherwise a slow earlier failure
  /// resolving after a newer success would replace a visible invitation with
  /// "we couldn't check for pending invitations".
  Future<void> load() async {
    final generation = ++_loadGeneration;
    _isLoading = true;
    _error = null;
    // A fresh list check is also the recovery path after an owner
    // restores a lapsed org. Do not leave a prior accept refusal latched over
    // the newly loaded invitation; the user must be able to try it again.
    _actionError = null;
    _actionInviteId = null;
    notifyListenersSafe();
    try {
      final invitations = await repository.fetchIncomingInvitations().timeout(
        loadTimeout,
      );
      if (generation != _loadGeneration) return;
      _invitations = invitations;
    } catch (e) {
      if (generation != _loadGeneration) return;
      _error = e;
      _invitations = const [];
    } finally {
      if (generation == _loadGeneration) {
        _isLoading = false;
        _hasLoaded = true;
        notifyListenersSafe();
      }
    }
  }

  /// Accepts [inviteId], dropping it from [invitations]. Rethrows on failure so
  /// the caller can surface an error and skip any post-accept navigation.
  Future<void> accept(String inviteId) =>
      _respond(inviteId: inviteId, accept: true);

  /// Declines [inviteId], dropping it from [invitations]. Rethrows on failure.
  Future<void> decline(String inviteId) =>
      _respond(inviteId: inviteId, accept: false);

  Future<void> _respond({
    required String inviteId,
    required bool accept,
  }) async {
    _isBusy = true;
    _actionError = null;
    _actionInviteId = inviteId;
    notifyListenersSafe();
    try {
      await repository.respondToInvitation(inviteId: inviteId, accept: accept);
      _invitations = _invitations
          .where((i) => i.id != inviteId)
          .toList(growable: false);
      _actionInviteId = null;
    } catch (e) {
      _actionError = e;
      rethrow;
    } finally {
      _isBusy = false;
      notifyListenersSafe();
    }
  }
}
