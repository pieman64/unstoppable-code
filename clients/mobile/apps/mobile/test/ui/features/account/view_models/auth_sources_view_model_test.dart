import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/auth_source.dart';
import 'package:mobile/data/repositories/auth_sources_repository.dart';
import 'package:mobile/ui/features/account/view_models/auth_sources_view_model.dart';

void main() {
  group('AuthSourcesViewModel', () {
    AuthSourcesViewModel build() => AuthSourcesViewModel(
      repository: MockAuthSourcesRepository(latency: Duration.zero),
    );

    test('load populates sources from the repository', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.sources, isNotEmpty);
      expect(vm.error, isNull);
      // The seeded credential method is non-removable.
      expect(
        vm.sources.any((s) => s.providerId == 'credential' && !s.canUnlink),
        isTrue,
      );
    });

    test('unlink removes the source', () async {
      final vm = build();
      await vm.load();
      final before = vm.sources.length;
      final google = vm.sources.firstWhere((s) => s.providerId == 'google');

      final ok = await vm.unlink(google);

      expect(ok, isTrue);
      expect(vm.sources.any((s) => s.providerId == 'google'), isFalse);
      expect(vm.sources.length, before - 1);
    });

    test('unlink returns false and records the error when the delete fails, '
        'leaving the source in place', () async {
      final vm = AuthSourcesViewModel(repository: _UnlinkFailsRepository());
      await vm.load();
      final google = vm.sources.firstWhere((s) => s.providerId == 'google');

      final ok = await vm.unlink(google);

      expect(ok, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.sources.any((s) => s.providerId == 'google'), isTrue);
    });

    test('unlink returns true and removes the source when the follow-up list '
        'refresh fails', () async {
      final vm = AuthSourcesViewModel(
        repository: _UnlinkOkListFailsRepository(),
      );
      await vm.load();
      final google = vm.sources.firstWhere((s) => s.providerId == 'google');

      final ok = await vm.unlink(google);

      expect(ok, isTrue);
      expect(vm.error, isNull);
      expect(vm.sources.any((s) => s.providerId == 'google'), isFalse);
    });

    test('a failed post-unlink refresh marks a now-sole source '
        'non-removable', () async {
      final vm = AuthSourcesViewModel(
        repository: _UnlinkOkListFailsTwoRemovableRepository(),
      );
      await vm.load();
      final google = vm.sources.firstWhere((s) => s.providerId == 'google');

      final ok = await vm.unlink(google);

      expect(ok, isTrue);
      expect(vm.sources, hasLength(1));
      // The remaining source is now the last one, so it must not keep a stale
      // unlink affordance even though the follow-up refresh failed.
      expect(vm.sources.single.canUnlink, isFalse);
    });

    test(
      'load records the error and clears sources when the list fails',
      () async {
        final vm = AuthSourcesViewModel(repository: _ListFailsRepository());

        await vm.load();

        expect(vm.error, isNotNull);
        expect(vm.sources, isEmpty);
      },
    );
  });
}

AuthSourcesResponse _twoSources() => const AuthSourcesResponse(
  user: AuthSourcesUser(
    name: 'Ada',
    email: 'ada@example.com',
    twoFactorEnabled: false,
  ),
  sources: [
    AuthSource(
      providerId: 'credential',
      accountId: 'acct-credential',
      label: 'Email and password',
      linkedAt: '2026-06-01T09:00:00.000Z',
      canUnlink: false,
    ),
    AuthSource(
      providerId: 'google',
      accountId: 'acct-google',
      label: 'Google',
      linkedAt: '2026-06-10T12:00:00.000Z',
      canUnlink: true,
    ),
  ],
);

/// Serves two sources on [list] but always throws on [unlink], simulating a
/// failed DELETE while the source remains linked.
final class _UnlinkFailsRepository implements AuthSourcesRepository {
  @override
  Future<AuthSourcesResponse> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    return _twoSources();
  }

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('unlink request failed');
  }
}

/// Deletes successfully, then simulates a failed post-unlink refresh.
final class _UnlinkOkListFailsRepository implements AuthSourcesRepository {
  bool _unlinked = false;

  @override
  Future<AuthSourcesResponse> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    if (_unlinked) {
      throw StateError('list request failed');
    }
    return _twoSources();
  }

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    _unlinked = true;
  }
}

/// Two removable sources on [list]; succeeds on [unlink] then fails the
/// post-unlink refresh, so the sole remaining source must be normalized to
/// non-removable.
final class _UnlinkOkListFailsTwoRemovableRepository
    implements AuthSourcesRepository {
  bool _unlinked = false;

  @override
  Future<AuthSourcesResponse> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    if (_unlinked) {
      throw StateError('list request failed');
    }
    return const AuthSourcesResponse(
      user: AuthSourcesUser(
        name: 'Ada',
        email: 'ada@example.com',
        twoFactorEnabled: false,
      ),
      sources: [
        AuthSource(
          providerId: 'google',
          accountId: 'acct-google',
          label: 'Google',
          linkedAt: '2026-06-10T12:00:00.000Z',
          canUnlink: true,
        ),
        AuthSource(
          providerId: 'github',
          accountId: 'acct-github',
          label: 'GitHub',
          linkedAt: '2026-06-20T15:30:00.000Z',
          canUnlink: true,
        ),
      ],
    );
  }

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    _unlinked = true;
  }
}

/// Always throws on [list], simulating a network blip on the initial load.
final class _ListFailsRepository implements AuthSourcesRepository {
  @override
  Future<AuthSourcesResponse> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('list request failed');
  }

  @override
  Future<void> unlink({
    required String providerId,
    required String accountId,
  }) => throw UnimplementedError();
}
