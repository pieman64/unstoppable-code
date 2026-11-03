import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/member_detail.dart';
import 'package:mobile/data/protocol/generated/organization.dart';
import 'package:mobile/data/repositories/member_detail_repository.dart';
import 'package:mobile/ui/features/members/view_models/member_detail_view_model.dart';

const OrganizationMember _member = OrganizationMember(
  email: 'sam@acme.dev',
  id: 'member-1',
  name: 'Sam Chen',
  role: OrganizationRole.member,
  subTeamIds: [],
);

void main() {
  group('MemberDetailViewModel', () {
    MemberDetailViewModel build({
      MemberDetailRepository? repository,
      bool canViewStats = true,
    }) => MemberDetailViewModel(
      repository:
          repository ?? MockMemberDetailRepository(latency: Duration.zero),
      member: _member,
      canViewStats: canViewStats,
    );

    test('exposes the injected member profile without re-fetching', () {
      final vm = build();
      expect(vm.member.name, 'Sam Chen');
      expect(vm.member.id, 'member-1');
    });

    test('load populates data from the repository', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNull);
      expect(vm.data, isNotNull);
      expect(vm.data!.sharedPlans, isNotEmpty);
      expect(vm.data!.usage, isNotNull);
    });

    test('load forwards canViewStats=false so usage is omitted', () async {
      final vm = build(canViewStats: false);

      await vm.load();

      expect(vm.data, isNotNull);
      expect(vm.data!.usage, isNull);
    });

    test('load surfaces an error and clears data on failure', () async {
      final vm = build(repository: _ThrowingRepository());

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.error, isNotNull);
      expect(vm.data, isNull);
    });
  });
}

final class _ThrowingRepository implements MemberDetailRepository {
  @override
  Future<MemberDetailData> load({required bool canViewStats}) async {
    throw Exception('boom');
  }
}
