import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/api_keys.dart';
import 'package:mobile/data/repositories/api_keys_repository.dart';
import 'package:mobile/ui/features/account/view_models/api_keys_view_model.dart';

void main() {
  group('ApiKeysViewModel', () {
    ApiKeysViewModel build() => ApiKeysViewModel(
      repository: MockApiKeysRepository(latency: Duration.zero),
    );

    test('load populates keys from the repository', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.keys, isNotEmpty);
      expect(vm.error, isNull);
    });

    test('create adds a key, returns the token, and reloads', () async {
      final vm = build();
      await vm.load();
      final before = vm.keys.length;

      final token = await vm.create('New key');

      expect(token, isNotNull);
      expect(vm.keys.length, before + 1);
      expect(vm.keys.first.name, 'New key');
    });

    test('revoke removes the key', () async {
      final vm = build();
      await vm.load();
      final id = vm.keys.first.id;

      await vm.revoke(id);

      expect(vm.keys.any((k) => k.id == id), isFalse);
    });

    test('create returns the token and keeps the new key even when the '
        'follow-up list refresh fails', () async {
      final vm = ApiKeysViewModel(repository: _CreateOkListFailsRepository());

      final token = await vm.create('CI token');

      // The one-time token is unrecoverable, so a refresh failure must not
      // discard the key the server already minted.
      expect(token, isNotNull);
      expect(vm.keys.map((k) => k.name), contains('CI token'));
      expect(vm.error, isNull);
    });

    test('revoke returns false and records the error when the delete fails, '
        'leaving the key in place', () async {
      final vm = ApiKeysViewModel(repository: _RevokeFailsRepository());
      await vm.load();
      final id = vm.keys.first.id;

      final ok = await vm.revoke(id);

      expect(ok, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.keys.any((k) => k.id == id), isTrue);
    });

    test('revoke returns true and removes the key when the follow-up list '
        'refresh fails', () async {
      final vm = ApiKeysViewModel(repository: _RevokeOkListFailsRepository());
      await vm.load();
      final id = vm.keys.first.id;

      final ok = await vm.revoke(id);

      expect(ok, isTrue);
      expect(vm.error, isNull);
      expect(vm.keys.any((k) => k.id == id), isFalse);
    });
  });
}

/// Succeeds on [create] but always throws on [list], simulating a network
/// blip on the post-create refresh.
final class _CreateOkListFailsRepository implements ApiKeysRepository {
  @override
  Future<List<UserApiKeyListItem>> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('list request failed');
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    final item = UserApiKeyListItem(
      id: 'key-created',
      name: name,
      source: UserApiKeySource.manual,
      createdIp: '127.0.0.1',
      createdAt: '2026-07-03T00:00:00.000Z',
      lastUsedAt: null,
    );
    return UserApiKeyCreateResponse(token: 'sk-secret-once', userApiKey: item);
  }

  @override
  Future<void> revoke(String id) => throw UnimplementedError();
}

/// Serves one key on [list] but always throws on [revoke], simulating a failed
/// DELETE while other keys remain.
final class _RevokeFailsRepository implements ApiKeysRepository {
  @override
  Future<List<UserApiKeyListItem>> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    return const [
      UserApiKeyListItem(
        id: 'key-keep',
        name: 'CI token',
        source: UserApiKeySource.manual,
        createdIp: '127.0.0.1',
        createdAt: '2026-07-03T00:00:00.000Z',
        lastUsedAt: null,
      ),
    ];
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      throw UnimplementedError();

  @override
  Future<void> revoke(String id) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('revoke request failed');
  }
}

/// Deletes successfully, then simulates a failed post-revoke refresh.
final class _RevokeOkListFailsRepository implements ApiKeysRepository {
  bool _revoked = false;

  @override
  Future<List<UserApiKeyListItem>> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    if (_revoked) {
      throw StateError('list request failed');
    }
    return const [
      UserApiKeyListItem(
        id: 'key-revoked',
        name: 'CI token',
        source: UserApiKeySource.manual,
        createdIp: '127.0.0.1',
        createdAt: '2026-07-03T00:00:00.000Z',
        lastUsedAt: null,
      ),
    ];
  }

  @override
  Future<UserApiKeyCreateResponse> create(String name) =>
      throw UnimplementedError();

  @override
  Future<void> revoke(String id) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    _revoked = true;
  }
}
