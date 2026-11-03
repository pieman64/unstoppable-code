/// Account-wide notification preferences
/// (`/api/account/notification-preferences`).
class NotificationPreferences {
  const NotificationPreferences({required this.pushEnabled});

  final bool pushEnabled;

  /// Parses the notification-preferences response body. Defaults
  /// [pushEnabled] to `true` when the key is absent or not a bool, matching
  /// the backend default.
  factory NotificationPreferences.fromJson(Map<String, dynamic> json) {
    final pushEnabled = json['pushEnabled'];
    return NotificationPreferences(
      pushEnabled: pushEnabled is bool ? pushEnabled : true,
    );
  }
}
