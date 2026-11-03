import 'package:mobile/data/protocol/generated/account.dart';
import 'package:mobile/data/services/profile_api_service.dart';

/// Contract for mutating the signed-in user's profile.
abstract interface class ProfileRepository {
  Future<UpdateProfileResponse> updateName(String name);
}

/// In-memory [ProfileRepository] used in mock mode and tests: echoes the new
/// name back as the server would.
final class MockProfileRepository implements ProfileRepository {
  MockProfileRepository({this.latency = const Duration(milliseconds: 300)});

  final Duration latency;

  @override
  Future<UpdateProfileResponse> updateName(String name) async {
    await Future<void>.delayed(latency);
    return UpdateProfileResponse(name: name, image: null);
  }
}

/// Live [ProfileRepository] backed by [ProfileApiService].
final class HttpProfileRepository implements ProfileRepository {
  const HttpProfileRepository({required this.service});

  final ProfileApiService service;

  @override
  Future<UpdateProfileResponse> updateName(String name) =>
      service.updateName(name);
}
