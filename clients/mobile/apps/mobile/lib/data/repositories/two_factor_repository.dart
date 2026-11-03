import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';

/// Contract for reading and managing the account's TOTP two-factor state.
abstract interface class TwoFactorRepository {
  /// Reads the current enabled/disabled status.
  Future<TwoFactorStatus> fetchStatus();

  /// Begins enrollment (provisions the secret + backup codes).
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  });

  /// Confirms enrollment by verifying the first TOTP [code].
  Future<void> verifyEnrollment({required String code});

  /// Disables two-factor authentication.
  Future<void> disable({String? password});
}

/// In-memory [TwoFactorRepository] for mock mode (no API config) and tests.
///
/// Starts disabled unless [initiallyEnabled] is set. [beginEnrollment] returns
/// a deterministic sample secret and backup codes; [verifyEnrollment] accepts
/// [validCode] and then reports enabled; [disable] flips back to disabled. The
/// mock deliberately does not enforce the bearer re-auth wall — that constraint
/// is server-side only.
final class MockTwoFactorRepository implements TwoFactorRepository {
  MockTwoFactorRepository({
    this.validCode = '123456',
    this.latency = const Duration(milliseconds: 300),
    bool initiallyEnabled = false,
  }) : _enabled = initiallyEnabled;

  final String validCode;
  final Duration latency;
  bool _enabled;

  @override
  Future<TwoFactorStatus> fetchStatus() async {
    await Future<void>.delayed(latency);
    return TwoFactorStatus(enabled: _enabled);
  }

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) async {
    await Future<void>.delayed(latency);
    final label = issuer.trim().isEmpty ? 'Mock' : issuer.trim();
    final encodedLabel = Uri.encodeComponent(label);
    return TwoFactorEnrollment(
      otpauthUri:
          'otpauth://totp/$encodedLabel?secret=$_mockSecret&issuer=$encodedLabel',
      backupCodes: const [
        '11112222',
        '33334444',
        '55556666',
        '77778888',
        '99990000',
      ],
    );
  }

  @override
  Future<void> verifyEnrollment({required String code}) async {
    await Future<void>.delayed(latency);
    if (code.trim() != validCode) {
      throw const TwoFactorException(TwoFactorFailure.invalidCode);
    }
    _enabled = true;
  }

  @override
  Future<void> disable({String? password}) async {
    await Future<void>.delayed(latency);
    _enabled = false;
  }
}

const String _mockSecret = 'JBSWY3DPEHPK3PXP';

/// Live [TwoFactorRepository] backed by [TwoFactorApiService].
final class HttpTwoFactorRepository implements TwoFactorRepository {
  const HttpTwoFactorRepository({required this.service});

  final TwoFactorApiService service;

  @override
  Future<TwoFactorStatus> fetchStatus() => service.fetchStatus();

  @override
  Future<TwoFactorEnrollment> beginEnrollment({
    required String issuer,
    String? password,
  }) => service.beginEnrollment(issuer: issuer, password: password);

  @override
  Future<void> verifyEnrollment({required String code}) =>
      service.verifyEnrollment(code: code);

  @override
  Future<void> disable({String? password}) =>
      service.disable(password: password);
}
