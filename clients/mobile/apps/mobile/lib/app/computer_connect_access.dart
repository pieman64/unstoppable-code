import 'package:http/http.dart' as http;
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/api_keys_api_service.dart';
import 'package:mobile/device_link/desktop/relay.dart';

/// Relay access for one signed-in account. Tokens are minted with the app's
/// sign-in session, so no account API key is created.
///
/// The scope is keyed by account, so [sessionToken] only ever returns this
/// account's session; reading it per call picks up a refreshed session.
final class ComputerConnectAccess {
  const ComputerConnectAccess({
    required this.origin,
    required this.sessionToken,
    required this.twoFactorProof,
    this.createClient = http.Client.new,
  });
  final String origin;
  final String? Function() sessionToken, twoFactorProof;

  /// Each revocation owns and closes the client returned by this factory.
  final http.Client Function() createClient;

  Future<DesktopRelayToken> token(String deviceId) {
    final session = sessionToken();
    if (session == null || session.isEmpty) {
      throw const DesktopRelayAccessException(401, code: 'unauthorized');
    }
    return fetchMobileRelayToken(
      origin: Uri.parse(origin),
      sessionToken: session,
      twoFactorProof: twoFactorProof(),
      deviceId: deviceId,
    );
  }

  /// Revokes the `Mobile computer connection` key earlier builds created.
  /// Only the key with [id], which this app stored, is revoked. A key that is
  /// already revoked or gone counts as done; any other failure throws so the
  /// caller keeps the reference and retries later.
  Future<void> revokeLegacyKey(String id) async {
    final client = createClient();
    try {
      await HttpApiKeysRepository(
        service: ApiKeysApiService(
          apiClient: ApiClient(
            baseUrl: origin,
            tokenProvider: sessionToken,
            twoFactorProofProvider: twoFactorProof,
            httpClient: client,
          ),
        ),
      ).revoke(id).timeout(const Duration(seconds: 20));
    } on ApiException catch (error) {
      if (error.statusCode != 404 && error.statusCode != 410) rethrow;
    } finally {
      client.close();
    }
  }
}
