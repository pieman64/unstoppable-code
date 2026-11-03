import 'package:mobile/data/protocol/generated/account.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the account profile endpoint (`PATCH /api/account/profile`).
final class ProfileApiService {
  const ProfileApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Updates the signed-in user's display [name]; returns the canonical
  /// name/image the server now holds.
  Future<UpdateProfileResponse> updateName(String name) async {
    final json = await apiClient.patchJson(
      '/api/account/profile',
      body: {'name': name},
    );
    return UpdateProfileResponse.fromJson(json);
  }
}
