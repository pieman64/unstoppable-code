import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages the linked login-methods list plus the unlink mutation. Linking a
/// new provider (OAuth flow) is out of scope for this slice.
final class AuthSourcesViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  AuthSourcesViewModel({required this.repository});

  final AuthSourcesRepository repository;

  bool _isLoading = false;
  bool _isMutating = false;
  List<AuthSource> _sources = const [];
  Object? _error;

  /// True while the initial/refresh list load is in flight.
  bool get isLoading => _isLoading;

  /// True while an unlink is in flight.
  bool get isMutating => _isMutating;

  /// The current linked authentication sources.
  List<AuthSource> get sources => List.unmodifiable(_sources);

  /// Non-null when the most recent operation failed.
  Object? get error => _error;

  /// Loads the auth-sources list, replacing any existing state.
  Future<void> load() async {
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      final response = await repository.list();
      _sources = response.sources;
    } catch (e) {
      _error = e;
      _sources = const [];
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Unlinks [source] and reloads the list. Returns `true` when the unlink
  /// succeeds, even if the best-effort follow-up refresh fails.
  ///
  /// The removal is keyed by [AuthSource.accountId], not just the provider id,
  /// so a user with more than one account under the same provider unlinks the
  /// exact one (matching the server contract and the web client).
  Future<bool> unlink(AuthSource source) async {
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    try {
      await repository.unlink(
        providerId: source.providerId,
        accountId: source.accountId,
      );
      _sources = _sources
          .where((s) => s.accountId != source.accountId)
          .toList(growable: false);
      try {
        final response = await repository.list();
        _sources = response.sources;
      } catch (_) {
        // Keep the optimistic removal; the unlink itself succeeded. Recompute
        // canUnlink locally so a now-sole remaining source loses its unlink
        // affordance (the server marks the last source non-removable) even
        // when the follow-up refresh could not confirm it.
        _sources = _withRecomputedCanUnlink(_sources);
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

  /// Recomputes [AuthSource.canUnlink] across [sources] to mirror the server
  /// rule — a source is removable only when more than one remains — so the
  /// optimistic list stays consistent when the post-unlink refresh fails.
  static List<AuthSource> _withRecomputedCanUnlink(List<AuthSource> sources) {
    final canUnlink = sources.length > 1;
    return sources
        .map((s) => s.copyWith(canUnlink: canUnlink))
        .toList(growable: false);
  }
}
