import 'package:flutter/foundation.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Drives the organization lifecycle actions (create, rename, leave, delete)
/// exposed from the Members screen overflow menu.
///
/// This view model owns only the in-flight/error bookkeeping for a single
/// mutation. The canonical active-org selection and org list live in
/// `AuthViewModel`; callers reconcile them by invoking
/// `AuthViewModel.reloadOrganizations()` after a successful action.
final class OrgViewModel extends ChangeNotifier with DisposeSafeNotifier {
  OrgViewModel({required this.repository});

  final OrgRepository repository;

  bool _isMutating = false;
  Object? _error;

  /// True while a create/rename/leave/delete is in flight.
  bool get isMutating => _isMutating;

  /// Non-null when the most recent action failed.
  Object? get error => _error;

  /// The server's own explanation of the most recent failure, when it sent one.
  ///
  /// Some rejections are deliberate and actionable rather than generic
  /// breakage: deleting an organization with a live subscription answers 409
  /// with copy telling the owner to cancel or settle it first (CAN-2220).
  /// Callers should prefer this over their fallback string so that reason
  /// reaches the user. Returns `null` for transport failures and for bodies
  /// that carry no `error` field, where generic copy is the honest answer.
  String? get errorMessage {
    final failure = _error;
    return failure is ApiException ? apiErrorMessage(failure) : null;
  }

  /// Creates an organization named [name]. Returns the new organization's id on
  /// success (so the caller can switch to it), or `null` on failure (see
  /// [error]).
  Future<String?> create(String name) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    String? newOrgId;
    try {
      final detail = await repository.create(name);
      newOrgId = detail.id;
    } catch (e) {
      _error = e;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
    return newOrgId;
  }

  /// Renames organization [orgId] to [name]. Returns `true` on success.
  Future<bool> rename({required String orgId, required String name}) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    var ok = false;
    try {
      await repository.rename(orgId: orgId, name: name);
      ok = true;
    } catch (e) {
      _error = e;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
    return ok;
  }

  /// Leaves organization [orgId]. Returns `true` on success.
  Future<bool> leave(String orgId) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    var ok = false;
    try {
      await repository.leave(orgId);
      ok = true;
    } catch (e) {
      _error = e;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
    return ok;
  }

  /// Deletes organization [orgId] (owner only). Returns `true` on success.
  Future<bool> delete(String orgId) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    var ok = false;
    try {
      await repository.delete(orgId);
      ok = true;
    } catch (e) {
      _error = e;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
    return ok;
  }
}
