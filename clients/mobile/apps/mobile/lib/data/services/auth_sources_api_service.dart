import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account auth-sources endpoints (`/api/account/auth-sources`).
final class AuthSourcesApiService {
  const AuthSourcesApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Lists the current user's linked authentication sources plus the account
  /// summary. The endpoint returns a top-level object (Contract B3).
  Future<AuthSourcesResponse> listAuthSources() async {
    final json = await apiClient.getJson('/api/account/auth-sources');
    return AuthSourcesResponse.fromJson(json);
  }

  /// Unlinks the source identified by [providerId] / [accountId]. The provider
  /// id is the server path param (Contract B4), URL-encoded to stay safe for
  /// arbitrary provider ids Better Auth might report; [accountId] is sent in the
  /// request body so the server removes the exact account when a provider has
  /// more than one linked (mirrors the web client, which posts `{accountId}`).
  Future<void> unlinkAuthSource({
    required String providerId,
    required String accountId,
  }) => apiClient.delete(
    '/api/account/auth-sources/${Uri.encodeComponent(providerId)}',
    body: {'accountId': accountId},
  );
}
