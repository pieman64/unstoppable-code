import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/services/api_keys_api_service.dart';

/// Contract for managing the current user's API keys.
abstract interface class ApiKeysRepository {
  Future<List<UserApiKeyListItem>> list();
  Future<UserApiKeyCreateResponse> create(String name);
  Future<void> revoke(String id);
}

/// In-memory [ApiKeysRepository] used in mock mode (no API config) and in
/// tests. Mutations are reflected in subsequent [list] calls.
final class MockApiKeysRepository implements ApiKeysRepository {
  MockApiKeysRepository({this.latency = const Duration(milliseconds: 400)});

  final Duration latency;
  int _seq = 0;

  final List<UserApiKeyListItem> _keys = [
    UserApiKeyListItem(
      id: 'key-seed-1',
      name: 'CI token',
      source: UserApiKeySource.manual,
      createdIp: '203.0.113.7',
      createdAt: '2026-06-20T10:00:00.000Z',
      lastUsedAt: '2026-07-01T08:00:00.000Z',
    ),
    UserApiKeyListItem(
      id: 'key-seed-2',
      name: 'Desktop sign-in',
      source: UserApiKeySource.oauthDesktop,
      createdIp: null,
      createdAt: '2026-06-25T14:00:00.000Z',
      lastUsedAt: null,
    ),
  ];

  @override
  Future<List<UserApiKeyListItem>> list() async {
    await Future<void>.delayed(latency);
    return List.unmodifiable(_keys);
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) async {
    await Future<void>.delayed(latency);
    final item = UserApiKeyListItem(
      id: 'key-new-${++_seq}',
      name: name,
      source: UserApiKeySource.manual,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    );
    _keys.insert(0, item);
    return UserApiKeyCreateResponse(
      token: 'sk-mock-${item.id}',
      userApiKey: item,
    );
  }

  @override
  Future<void> revoke(String id) async {
    await Future<void>.delayed(latency);
    _keys.removeWhere((key) => key.id == id);
  }
}

/// Live [ApiKeysRepository] backed by [ApiKeysApiService].
final class HttpApiKeysRepository implements ApiKeysRepository {
  const HttpApiKeysRepository({required this.service});

  final ApiKeysApiService service;

  @override
  Future<List<UserApiKeyListItem>> list() => service.listApiKeys();

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      service.createApiKey(name);

  @override
  Future<void> revoke(String id) => service.revokeApiKey(id);
}
