import 'package:http/http.dart' as http;
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/api_keys_api_service.dart';
import 'package:mobile/device_link/desktop/saved_connection.dart';

/// Captures the authenticated account and origin at composition time. A late
/// setup response cannot mint or revoke a key using another account's session.
final class ComputerConnectKeys {
  const ComputerConnectKeys({
    required this.origin,
    required this.sessionToken,
    required this.twoFactorProof,
    this.createClient = http.Client.new,
  });
  final String origin, sessionToken;
  final String? twoFactorProof;
  /// Each setup attempt owns and closes the client returned by this factory.
  final http.Client Function() createClient;

  Future<ComputerConnectCredential> create() async {
    final client = createClient();
    try {
      final repository = HttpApiKeysRepository(
        service: ApiKeysApiService(
          apiClient: ApiClient(
            baseUrl: origin,
            tokenProvider: () => sessionToken,
            twoFactorProofProvider: () => twoFactorProof,
            httpClient: client,
          ),
        ),
      );
      final response = await repository
          .create('Mobile computer connection')
          .timeout(const Duration(seconds: 20));
      return ComputerConnectCredential(response.userApiKey.id, response.token);
    } on ApiException catch (error) {
      if ([400, 401, 403, 404].contains(error.statusCode)) {
        throw const ComputerConnectSetupRejected(
          'Could not set up computer access. Check your sign-in and account access, then try again.',
        );
      }
      rethrow;
    } finally {
      client.close();
    }
  }
}
