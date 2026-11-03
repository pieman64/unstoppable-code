import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account device-registration endpoints
/// (`/api/account/devices`) used to register/unregister this device's push
/// token.
final class DeviceApiService {
  const DeviceApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Registers [token] for push delivery on [platform]. Safe to call
  /// repeatedly with the same token — the server upserts by token.
  Future<void> register({
    required String token,
    required DevicePlatform platform,
  }) async {
    await apiClient.postJson(
      '/api/account/devices',
      body: {'token': token, 'platform': platform.wire},
    );
  }

  /// Unregisters [token] so this device no longer receives push delivery.
  Future<void> unregister({required String token}) async {
    await apiClient.deleteJsonWithBody(
      '/api/account/devices',
      body: {'token': token},
    );
  }
}
