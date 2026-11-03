import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';

void main() {
  group('TwoFactorViewModel', () {
    TwoFactorViewModel build({bool initiallyEnabled = false}) =>
        TwoFactorViewModel(
          repository: MockTwoFactorRepository(
            latency: Duration.zero,
            initiallyEnabled: initiallyEnabled,
          ),
          issuer: 'Test',
        );

    test('load reflects the disabled status', () async {
      final vm = build();

      await vm.load();

      expect(vm.isLoading, isFalse);
      expect(vm.enabled, isFalse);
      expect(vm.loadFailed, isFalse);
    });

    test('load reflects the enabled status', () async {
      final vm = build(initiallyEnabled: true);

      await vm.load();

      expect(vm.enabled, isTrue);
    });

    test('load reflects credential-source password requirements', () async {
      final vm = TwoFactorViewModel(
        repository: _CredentialStatusRepository(),
        issuer: 'Test',
      );

      await vm.load();

      expect(vm.hasCredentialAuthSource, isTrue);
    });

    test('load flags loadFailed when the read throws', () async {
      final vm = TwoFactorViewModel(
        repository: _FetchFailsRepository(),
        issuer: 'Test',
      );

      await vm.load();

      expect(vm.loadFailed, isTrue);
    });

    test(
      'beginEnrollment moves to awaitingCode and holds the secret',
      () async {
        final vm = build();
        await vm.load();

        final started = await vm.beginEnrollment();

        expect(started, isTrue);
        expect(vm.step, TwoFactorStep.awaitingCode);
        expect(vm.enrollment, isNotNull);
        expect(vm.enrollment?.secret, isNotNull);
        expect(vm.enabled, isFalse); // not enabled until verified
      },
    );

    test(
      'verifyEnrollment activates 2FA and surfaces backup codes once',
      () async {
        final vm = build();
        await vm.load();
        await vm.beginEnrollment();

        final ok = await vm.verifyEnrollment('123456');

        expect(ok, isTrue);
        expect(vm.enabled, isTrue);
        expect(vm.step, TwoFactorStep.idle);
        expect(vm.enrollment, isNull); // secret cleared
        expect(vm.lastBackupCodes, isNotEmpty);

        vm.acknowledgeBackupCodes();
        expect(vm.lastBackupCodes, isNull);
      },
    );

    test('verifyEnrollment with a bad code keeps the flow open with a '
        'failure', () async {
      final vm = build();
      await vm.load();
      await vm.beginEnrollment();

      final ok = await vm.verifyEnrollment('000000');

      expect(ok, isFalse);
      expect(vm.enabled, isFalse);
      expect(vm.step, TwoFactorStep.awaitingCode);
      expect(vm.failure, TwoFactorFailure.invalidCode);
      expect(vm.enrollment, isNotNull); // secret retained for a retry
    });

    test('cancelEnrollment discards the secret without enabling', () async {
      final vm = build();
      await vm.load();
      await vm.beginEnrollment();

      vm.cancelEnrollment();

      expect(vm.step, TwoFactorStep.idle);
      expect(vm.enrollment, isNull);
      expect(vm.enabled, isFalse);
    });

    test('disable flips the status to disabled on success', () async {
      final vm = build(initiallyEnabled: true);
      await vm.load();

      final ok = await vm.disable();

      expect(ok, isTrue);
      expect(vm.enabled, isFalse);
    });

    test(
      'beginEnrollment and disable forward password when provided',
      () async {
        final repository = _PasswordCapturingRepository();
        final vm = TwoFactorViewModel(repository: repository, issuer: 'Test');
        await vm.load();

        await vm.beginEnrollment(password: 'pw-enable');
        await vm.disable(password: 'pw-disable');

        expect(repository.beginPassword, 'pw-enable');
        expect(repository.disablePassword, 'pw-disable');
      },
    );

    test(
      'disable surfaces needsReauth and leaves 2FA enabled on 403',
      () async {
        final vm = TwoFactorViewModel(
          repository: _DisableNeedsReauthRepository(),
          issuer: 'Test',
        );
        await vm.load();

        final ok = await vm.disable();

        expect(ok, isFalse);
        expect(vm.failure, TwoFactorFailure.needsReauth);
        expect(vm.enabled, isTrue); // unchanged — still enabled
      },
    );
  });
}

/// Fails every status read.
final class _FetchFailsRepository implements TwoFactorRepository {
  @override
  Future<TwoFactorStatus> fetchStatus() async {
    throw StateError('status read failed');
  }

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => throw UnimplementedError();

  @override
  Future<void> verifyEnrollment({required String code}) =>
      throw UnimplementedError();

  @override
  Future<void> disable({String? password}) => throw UnimplementedError();
}

/// Reports enabled, then rejects disable with the bearer re-auth wall (403).
final class _DisableNeedsReauthRepository implements TwoFactorRepository {
  @override
  Future<TwoFactorStatus> fetchStatus() async =>
      const TwoFactorStatus(enabled: true);

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => throw UnimplementedError();

  @override
  Future<void> verifyEnrollment({required String code}) =>
      throw UnimplementedError();

  @override
  Future<void> disable({String? password}) async {
    throw const TwoFactorException(TwoFactorFailure.needsReauth);
  }
}

final class _CredentialStatusRepository implements TwoFactorRepository {
  @override
  Future<TwoFactorStatus> fetchStatus() async =>
      const TwoFactorStatus(enabled: false, hasCredentialAuthSource: true);

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => throw UnimplementedError();

  @override
  Future<void> verifyEnrollment({required String code}) =>
      throw UnimplementedError();

  @override
  Future<void> disable({String? password}) => throw UnimplementedError();
}

final class _PasswordCapturingRepository implements TwoFactorRepository {
  String? beginPassword;
  String? disablePassword;

  @override
  Future<TwoFactorStatus> fetchStatus() async =>
      const TwoFactorStatus(enabled: true, hasCredentialAuthSource: true);

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) async {
    beginPassword = password;
    return const TwoFactorEnrollment(
      otpauthUri: 'otpauth://totp/Test?secret=ABC',
      backupCodes: [],
    );
  }

  @override
  Future<void> verifyEnrollment({required String code}) async {}

  @override
  Future<void> disable({String? password}) async {
    disablePassword = password;
  }
}
