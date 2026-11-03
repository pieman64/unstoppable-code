import 'package:mobile/data/models/notification_preferences.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account-wide notification-preferences endpoint
/// (`/api/account/notification-preferences`).
final class NotificationPreferencesApiService {
  const NotificationPreferencesApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Loads the current notification preferences.
  Future<NotificationPreferences> getPreferences() async {
    final json = await apiClient.getJson(
      '/api/account/notification-preferences',
    );
    return NotificationPreferences.fromJson(json);
  }

  /// Updates the account-wide push-notifications toggle to [value].
  Future<NotificationPreferences> updatePushEnabled(bool value) async {
    final json = await apiClient.patchJson(
      '/api/account/notification-preferences',
      body: {'pushEnabled': value},
    );
    return NotificationPreferences.fromJson(json);
  }
}
