import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/org_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/ui/features/organizations/view_models/org_view_model.dart';

void main() {
  group('OrgViewModel', () {
    OrgViewModel build() =>
        OrgViewModel(repository: MockOrgRepository(latency: Duration.zero));

    test('create returns the new org id and clears mutating/error', () async {
      final vm = build();

      final id = await vm.create('New org');

      expect(id, isNotNull);
      expect(vm.isMutating, isFalse);
      expect(vm.error, isNull);
    });

    test('rename returns true on success', () async {
      final vm = build();

      final ok = await vm.rename(orgId: 'org-1', name: 'Renamed');

      expect(ok, isTrue);
      expect(vm.error, isNull);
    });

    test('leave returns true on success', () async {
      final vm = build();

      final ok = await vm.leave('org-1');

      expect(ok, isTrue);
      expect(vm.error, isNull);
    });

    test('delete returns true on success', () async {
      final vm = build();

      final ok = await vm.delete('org-1');

      expect(ok, isTrue);
      expect(vm.error, isNull);
    });

    test('create returns null and records the error when it fails', () async {
      final vm = OrgViewModel(repository: _FailingOrgRepository());

      final id = await vm.create('New org');

      expect(id, isNull);
      expect(vm.error, isNotNull);
      expect(vm.isMutating, isFalse);
    });

    test('rename returns false and records the error when it fails', () async {
      final vm = OrgViewModel(repository: _FailingOrgRepository());

      final ok = await vm.rename(orgId: 'org-1', name: 'Renamed');

      expect(ok, isFalse);
      expect(vm.error, isNotNull);
    });

    test('leave returns false and records the error when it fails', () async {
      final vm = OrgViewModel(repository: _FailingOrgRepository());

      final ok = await vm.leave('org-1');

      expect(ok, isFalse);
      expect(vm.error, isNotNull);
    });

    test('delete returns false and records the error when it fails', () async {
      final vm = OrgViewModel(repository: _FailingOrgRepository());

      final ok = await vm.delete('org-1');

      expect(ok, isFalse);
      expect(vm.error, isNotNull);
    });

    test('delete surfaces the server reason behind a refusal', () async {
      // CAN-2220: an org with a live subscription is refused with a deliberate
      // 409 that tells the owner what to do. That copy has to reach the UI.
      const refusal = ApiException(
        statusCode: 409,
        body: '{"error":"Cancel the subscription first."}',
      );
      final vm = OrgViewModel(repository: _RefusingOrgRepository(refusal));

      final ok = await vm.delete('org-1');

      expect(ok, isFalse);
      expect(vm.errorMessage, 'Cancel the subscription first.');
    });

    test('errorMessage is null without server copy', () async {
      final vm = OrgViewModel(repository: _FailingOrgRepository());

      await vm.delete('org-1');

      expect(vm.error, isNotNull);
      expect(vm.errorMessage, isNull);
    });
  });
}

/// [OrgRepository] whose delete is refused with a server-authored error.
final class _RefusingOrgRepository extends _FailingOrgRepository {
  _RefusingOrgRepository(this.refusal);

  final ApiException refusal;

  @override
  Future<void> delete(String orgId) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw refusal;
  }
}

/// [OrgRepository] whose every action throws, to exercise the failure paths.
final class _FailingOrgRepository implements OrgRepository {
  @override
  Future<OrganizationDetail> create(String name) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('create failed');
  }

  @override
  Future<OrganizationDetail> rename({
    required String orgId,
    required String name,
  }) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('rename failed');
  }

  @override
  Future<void> leave(String orgId) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('leave failed');
  }

  @override
  Future<void> delete(String orgId) async {
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw StateError('delete failed');
  }
}
