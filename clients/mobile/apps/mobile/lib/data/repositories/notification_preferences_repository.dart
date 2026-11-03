import 'package:mobile/data/models/notification_preferences.dart';
import 'package:mobile/data/services/notification_preferences_api_service.dart';

/// Contract for reading and updating the account-wide notification
/// preferences (`/api/account/notification-preferences`).
abstract interface class NotificationPreferencesRepository {
  /// Loads the current notification preferences.
  Future<NotificationPreferences> load();

  /// Updates the push-notifications toggle to [pushEnabled].
  Future<NotificationPreferences> update({required bool pushEnabled});
}

/// In-memory [NotificationPreferencesRepository] used in mock mode (no API
/// config) and in tests. Mutations are reflected in subsequent [load] calls.
final class MockNotificationPreferencesRepository
    implements NotificationPreferencesRepository {
  MockNotificationPreferencesRepository({
    this.latency = const Duration(milliseconds: 400),
  });

  final Duration latency;

  bool _pushEnabled = true;

  /// Number of times [load] has been called. Test-only instrumentation for
  /// asserting a caller skipped the repository entirely (e.g. reviewer demo
  /// mode).
  int loadCount = 0;

  /// Number of times [update] has been called. Test-only instrumentation for
  /// asserting a caller skipped the repository entirely (e.g. reviewer demo
  /// mode).
  int updateCount = 0;

  @override
  Future<NotificationPreferences> load() async {
    loadCount++;
    await Future<void>.delayed(latency);
    return NotificationPreferences(pushEnabled: _pushEnabled);
  }

  @override
  Future<NotificationPreferences> update({required bool pushEnabled}) async {
    updateCount++;
    await Future<void>.delayed(latency);
    _pushEnabled = pushEnabled;
    return NotificationPreferences(pushEnabled: _pushEnabled);
  }
}

/// Live [NotificationPreferencesRepository] backed by
/// [NotificationPreferencesApiService].
final class HttpNotificationPreferencesRepository
    implements NotificationPreferencesRepository {
  const HttpNotificationPreferencesRepository({required this.service});

  final NotificationPreferencesApiService service;

  @override
  Future<NotificationPreferences> load() => service.getPreferences();

  @override
  Future<NotificationPreferences> update({required bool pushEnabled}) =>
      service.updatePushEnabled(pushEnabled);
}
