import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account API-key endpoints (`/api/account/api-keys`).
final class ApiKeysApiService {
  const ApiKeysApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Lists the current user's API keys (newest first, per the server).
  Future<List<UserApiKeyListItem>> listApiKeys() async {
    final list = await apiClient.getJsonList('/api/account/api-keys');
    return list
        .map((e) => UserApiKeyListItem.fromJson(_jsonObject(e)))
        .toList(growable: false);
  }

  /// Creates a new API key named [name]. The response carries the one-time
  /// plaintext token, which the server never returns again.
  Future<UserApiKeyCreateResponse> createApiKey(String name) async {
    final json = await apiClient.postJson(
      '/api/account/api-keys',
      body: {'name': name},
    );
    return UserApiKeyCreateResponse.fromJson(json);
  }

  /// Revokes the API key with [id].
  Future<void> revokeApiKey(String id) =>
      apiClient.delete('/api/account/api-keys/$id');
}

Map<String, dynamic> _jsonObject(Object? value) {
  if (value is Map<String, dynamic>) return value;
  throw const FormatException('Expected API key object');
}
