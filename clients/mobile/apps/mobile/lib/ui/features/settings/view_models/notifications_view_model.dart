import 'package:flutter/foundation.dart';
import 'package:mobile/data/repositories/notification_preferences_repository.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages the account-wide push-notifications toggle.
final class NotificationsViewModel extends ChangeNotifier
    with DisposeSafeNotifier {
  NotificationsViewModel({
    required this.repository,
    required this.isConfigured,
  });

  final NotificationPreferencesRepository repository;

  /// Reports whether the app currently has a real API configured (mirrors
  /// `AppConfig.hasAuthApiConfig`). A live closure, not a snapshot, so it
  /// reflects a later reviewer-demo-mode toggle: when it returns `false`,
  /// [load] and [setPushEnabled] never call [repository], matching demo
  /// mode's no-network-calls contract. Mirrors the `isPushConfigured`
  /// pattern in `PushService`.
  final bool Function() isConfigured;

  bool _pushEnabled = true;
  bool _isLoading = false;
  bool _isMutating = false;
  Object? _error;

  /// Whether push notifications are currently enabled account-wide.
  bool get pushEnabled => _pushEnabled;

  /// True while the initial/refresh load is in flight.
  bool get isLoading => _isLoading;

  /// True while a toggle update is in flight.
  bool get isMutating => _isMutating;

  /// Non-null when the most recent load or update failed.
  Object? get error => _error;

  /// Loads the current push-notifications preference.
  ///
  /// A no-op when [isConfigured] returns `false` (e.g. reviewer demo mode):
  /// [pushEnabled] keeps its current/default value and [repository] is never
  /// called.
  Future<void> load() async {
    if (!isConfigured()) return;
    _isLoading = true;
    _error = null;
    notifyListenersSafe();
    try {
      final prefs = await repository.load();
      _pushEnabled = prefs.pushEnabled;
    } catch (e) {
      _error = e;
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Toggles the push-notifications preference to [value].
  ///
  /// Updates local state optimistically so the UI reflects the change
  /// immediately, then persists it. If the persist fails, the optimistic
  /// value is reverted and [error] is set. Never throws.
  ///
  /// When [isConfigured] returns `false` (e.g. reviewer demo mode), this only
  /// flips the local value and notifies listeners — [repository] is never
  /// called, matching demo mode's no-network-calls contract.
  Future<void> setPushEnabled(bool value) async {
    if (_pushEnabled == value) return;

    if (!isConfigured()) {
      _pushEnabled = value;
      notifyListenersSafe();
      return;
    }

    final previous = _pushEnabled;
    _pushEnabled = value;
    _isMutating = true;
    _error = null;
    notifyListenersSafe();
    try {
      await repository.update(pushEnabled: value);
    } catch (e) {
      _pushEnabled = previous;
      _error = e;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }
}
