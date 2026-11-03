import 'package:mobile/data/models/device_registration.dart';
import 'package:mobile/data/services/device_api_service.dart';

/// Contract for registering/unregistering this device's push token with the
/// account API (`/api/account/devices`).
abstract interface class DeviceRepository {
  /// Registers [token] for push delivery on [platform]. Safe to call
  /// repeatedly with the same token — the server upserts by token.
  Future<void> register({
    required String token,
    required DevicePlatform platform,
  });

  /// Unregisters [token] so this device no longer receives push delivery.
  Future<void> unregister({required String token});
}

/// In-memory [DeviceRepository] used in mock mode (no API config) and in
/// tests. Records every registered/unregistered token instead of talking to
/// a server.
final class MockDeviceRepository implements DeviceRepository {
  MockDeviceRepository({this.latency = const Duration(milliseconds: 400)});

  final Duration latency;

  /// Tokens passed to [register], in call order. Includes duplicates.
  final List<String> registeredTokens = [];

  /// Tokens passed to [unregister], in call order. Includes duplicates.
  final List<String> unregisteredTokens = [];

  @override
  Future<void> register({
    required String token,
    required DevicePlatform platform,
  }) async {
    await Future<void>.delayed(latency);
    registeredTokens.add(token);
  }

  @override
  Future<void> unregister({required String token}) async {
    await Future<void>.delayed(latency);
    unregisteredTokens.add(token);
  }
}

/// Live [DeviceRepository] backed by [DeviceApiService].
final class HttpDeviceRepository implements DeviceRepository {
  const HttpDeviceRepository({required this.service});

  final DeviceApiService service;

  @override
  Future<void> register({
    required String token,
    required DevicePlatform platform,
  }) => service.register(token: token, platform: platform);

  @override
  Future<void> unregister({required String token}) =>
      service.unregister(token: token);
}
