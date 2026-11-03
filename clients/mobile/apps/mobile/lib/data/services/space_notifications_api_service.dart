import 'package:mobile/data/models/space_notification_policy.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the per-space notification routes
/// (`/api/v1/notification-spaces/{spaceId}`, CAN-3615).
///
/// Throws [ApiException] on a non-2xx response; its body carries the
/// authoritative `policy` for a refused save.
final class SpaceNotificationsApiService {
  const SpaceNotificationsApiService({required this.apiClient});

  final ApiClient apiClient;

  static String _path(String spaceId) =>
      '/api/v1/notification-spaces/${Uri.encodeComponent(spaceId)}';

  /// Reads the space's saved choice. Null when the body is not a usable
  /// snapshot.
  Future<SpaceNotificationPolicy?> getPolicy(String spaceId) async =>
      SpaceNotificationPolicy.tryParse(await apiClient.getJson(_path(spaceId)));

  /// Saves [override] (null removes it) against [expectedRevision]. Null when
  /// the body is not a usable snapshot.
  Future<SpaceNotificationPolicy?> setPreference(
    String spaceId, {
    required int expectedRevision,
    required SpaceNotificationLevel? override,
  }) async => SpaceNotificationPolicy.tryParse(
    await apiClient.patchJson(
      _path(spaceId),
      body: {
        'expectedRevision': expectedRevision,
        'override': override?.wireValue,
      },
    ),
  );
}
