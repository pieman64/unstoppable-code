import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/services/auth_sources_api_service.dart';

/// Contract for listing and unlinking the current user's authentication
/// sources (linked login methods). Linking a new provider is out of scope.
abstract interface class AuthSourcesRepository {
  Future<AuthSourcesResponse> list();
  Future<void> unlink({required String providerId, required String accountId});
}

/// In-memory [AuthSourcesRepository] used in mock mode (no API config) and in
/// tests. Mutations are reflected in subsequent [list] calls.
final class MockAuthSourcesRepository implements AuthSourcesRepository {
  MockAuthSourcesRepository({this.latency = const Duration(milliseconds: 400)});

  final Duration latency;

  final List<AuthSource> _sources = [
    const AuthSource(
      providerId: 'credential',
      accountId: 'acct-credential',
      label: 'Email and password',
      linkedAt: '2026-06-01T09:00:00.000Z',
      canUnlink: false,
    ),
    const AuthSource(
      providerId: 'google',
      accountId: 'acct-google',
      label: 'Google',
      linkedAt: '2026-06-10T12:00:00.000Z',
      canUnlink: true,
    ),
    const AuthSource(
      providerId: 'github',
      accountId: 'acct-github',
      label: 'GitHub',
      linkedAt: '2026-06-20T15:30:00.000Z',
      canUnlink: true,
    ),
  ];

  @override
  Future<AuthSourcesResponse> list() async {
    await Future<void>.delayed(latency);
    return AuthSourcesResponse(
      user: const AuthSourcesUser(
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        twoFactorEnabled: false,
      ),
      sources: List.unmodifiable(_sources),
    );
  }

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    await Future<void>.delayed(latency);
    _sources.removeWhere(
      (source) =>
          source.accountId == accountId &&
          source.providerId == providerId &&
          source.canUnlink,
    );
  }
}

/// Live [AuthSourcesRepository] backed by [AuthSourcesApiService].
final class HttpAuthSourcesRepository implements AuthSourcesRepository {
  const HttpAuthSourcesRepository({required this.service});

  final AuthSourcesApiService service;

  @override
  Future<AuthSourcesResponse> list() => service.listAuthSources();

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) => service.unlinkAuthSource(providerId: providerId, accountId: accountId);
}
