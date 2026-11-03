import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages the API-keys list plus create/revoke mutations.
final class ApiKeysViewModel extends ChangeNotifier with DisposeSafeNotifier {
  ApiKeysViewModel({required this.repository});

  final ApiKeysRepository repository;

  bool _isLoading = false;
  bool _isMutating = false;
  List<UserApiKeyListItem> _keys = const [];
  Object? _error;

  /// True while the initial/refresh list load is in flight.
  bool get isLoading => _isLoading;

  /// True while a create/revoke is in flight.
  bool get isMutating => _isMutating;

  /// The current keys (newest first).
  List<UserApiKeyListItem> get keys => List.unmodifiable(_keys);

  /// Non-null when the most recent operation failed.
  Object? get error => _error;

  /// Loads the key list, replacing any existing state.
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      _keys = await repository.list();
    } catch (e) {
      _error = e;
      _keys = const [];
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Creates a key named [name] and reloads the list. Returns the one-time
  /// plaintext token on success, or `null` on failure (see [error]).
  Future<String?> create(String name) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    try {
      final response = await repository.create(name);
      // The plaintext token is shown once and can never be recovered, so
      // surface the new key optimistically and treat the canonical list
      // refresh as best-effort: a refresh failure must not discard the token
      // the server already minted.
      _keys = [response.userApiKey, ..._keys];
      try {
        _keys = await repository.list();
      } catch (_) {
        // Keep the optimistic entry; the create itself succeeded.
      }
      return response.token;
    } catch (e) {
      _error = e;
      return null;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }

  /// Revokes the key [id] and reloads the list. Returns `true` when the revoke
  /// succeeds, even if the best-effort follow-up refresh fails.
  Future<bool> revoke(String id) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    try {
      await repository.revoke(id);
      _keys = _keys.where((key) => key.id != id).toList(growable: false);
      try {
        _keys = await repository.list();
      } catch (_) {
        // Keep the optimistic removal; the revoke itself succeeded.
      }
      return true;
    } catch (e) {
      _error = e;
      return false;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }
}
