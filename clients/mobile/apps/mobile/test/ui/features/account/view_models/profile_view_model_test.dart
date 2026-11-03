import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/account.dart';
import 'package:mobile/data/repositories/profile_repository.dart';
import 'package:mobile/ui/features/account/view_models/profile_view_model.dart';

final class _FailingProfileRepository implements ProfileRepository {
  @override
  Future<UpdateProfileResponse> updateName(String name) async =>
      throw StateError('update failed');
}

void main() {
  group('ProfileViewModel', () {
    test('updateName returns the server response on success', () async {
      final vm = ProfileViewModel(
        repository: MockProfileRepository(latency: Duration.zero),
      );

      final result = await vm.updateName('Ada');

      expect(result?.name, 'Ada');
      expect(vm.isSaving, isFalse);
      expect(vm.error, isNull);
    });

    test('updateName returns null and records the error on failure', () async {
      final vm = ProfileViewModel(repository: _FailingProfileRepository());

      final result = await vm.updateName('Ada');

      expect(result, isNull);
      expect(vm.error, isNotNull);
      expect(vm.isSaving, isFalse);
    });
  });
}
