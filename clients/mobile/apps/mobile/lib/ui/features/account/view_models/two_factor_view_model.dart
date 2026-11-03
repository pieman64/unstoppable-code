import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/repositories/two_factor_repository.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';
import 'package:mobile/ui/core/dispose_safe_notifier.dart';

/// Manages the account's TOTP two-factor state: reading status, driving the
/// enroll → verify → enabled flow, and disabling.
///
/// The enroll flow is a small state machine:
///   idle → (beginEnrollment) → awaitingCode → (verifyEnrollment) → idle+enabled
/// The provisioned [enrollment] (secret/URI + one-time backup codes) is held
/// only while [step] is [TwoFactorStep.awaitingCode] and cleared on success or
/// cancel. Backup codes are surfaced once via [lastBackupCodes] after a
/// successful enroll and cleared by [acknowledgeBackupCodes].
///
/// SECURITY: [enrollment] and [lastBackupCodes] hold sensitive material (the
/// TOTP secret and one-time recovery codes). They live only in memory, are
/// cleared as soon as the flow completes, and are never logged or persisted.
final class TwoFactorViewModel extends ChangeNotifier with DisposeSafeNotifier {
  TwoFactorViewModel({required this.repository, required this.issuer});

  final TwoFactorRepository repository;

  /// Authenticator-app label for the provisioned entry (brand display name).
  final String issuer;

  bool _isLoading = false;
  bool _isMutating = false;
  bool _enabled = false;
  bool _hasCredentialAuthSource = false;
  bool _loadFailed = false;
  TwoFactorStep _step = TwoFactorStep.idle;
  TwoFactorEnrollment? _enrollment;
  List<String>? _lastBackupCodes;
  TwoFactorFailure? _failure;

  /// True while the initial/refresh status load is in flight.
  bool get isLoading => _isLoading;

  /// True while an enroll/verify/disable mutation is in flight.
  bool get isMutating => _isMutating;

  /// Whether 2FA is currently enabled for the account.
  bool get enabled => _enabled;

  /// Whether enable/disable must include the account password.
  bool get hasCredentialAuthSource => _hasCredentialAuthSource;

  /// True when the most recent status load failed (status is unknown).
  bool get loadFailed => _loadFailed;

  /// Current position in the enroll state machine.
  TwoFactorStep get step => _step;

  /// The active enrollment (secret/URI + backup codes) while awaiting a code,
  /// else `null`.
  TwoFactorEnrollment? get enrollment => _enrollment;

  /// Backup codes to display once after a successful enroll, else `null`.
  List<String>? get lastBackupCodes => _lastBackupCodes;

  /// The most recent mutation failure, or `null`. Drives a specific message
  /// (invalid code vs re-auth wall vs rate limit).
  TwoFactorFailure? get failure => _failure;

  /// Loads the current 2FA status, replacing any existing state.
  Future<void> load() async {
    _isLoading = true;
    _failure = null;
    notifyListenersSafe();
    try {
      final status = await repository.fetchStatus();
      _enabled = status.enabled;
      _hasCredentialAuthSource = status.hasCredentialAuthSource;
      _loadFailed = false;
    } catch (_) {
      // Leave the last known value; flag that the read failed so the UI can
      // offer a retry rather than silently showing a stale/false status.
      _loadFailed = true;
    } finally {
      _isLoading = false;
      notifyListenersSafe();
    }
  }

  /// Begins enrollment, moving to [TwoFactorStep.awaitingCode] on success so
  /// the UI can render the secret/URI and collect a code. Returns `true` when
  /// the secret was provisioned.
  Future<bool> beginEnrollment({String? password}) async {
    _isMutating = true;
    _failure = null;
    notifyListenersSafe();
    try {
      final enrollment = await repository.beginEnrollment(
        issuer: issuer,
        password: password,
      );
      _enrollment = enrollment;
      _step = TwoFactorStep.awaitingCode;
      return true;
    } on TwoFactorException catch (e) {
      _failure = e.failure;
      return false;
    } catch (_) {
      _failure = TwoFactorFailure.unknown;
      return false;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }

  /// Verifies the first TOTP [code] to activate 2FA. On success the account is
  /// enabled, the enrollment is cleared, and the provisioned backup codes are
  /// moved into [lastBackupCodes] for a one-time display. Returns `true` on
  /// success; on failure the flow stays on [TwoFactorStep.awaitingCode] with a
  /// [failure] so the user can retry.
  Future<bool> verifyEnrollment(String code) async {
    final enrollment = _enrollment;
    if (enrollment == null) return false;
    _isMutating = true;
    _failure = null;
    notifyListenersSafe();
    try {
      await repository.verifyEnrollment(code: code);
      _enabled = true;
      _lastBackupCodes = enrollment.backupCodes;
      _enrollment = null;
      _step = TwoFactorStep.idle;
      return true;
    } on TwoFactorException catch (e) {
      _failure = e.failure;
      return false;
    } catch (_) {
      _failure = TwoFactorFailure.unknown;
      return false;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }

  /// Abandons an in-progress enrollment and returns to [TwoFactorStep.idle].
  /// The provisioned secret is discarded; the account was never enabled.
  void cancelEnrollment() {
    _enrollment = null;
    _step = TwoFactorStep.idle;
    _failure = null;
    notifyListenersSafe();
  }

  /// Clears the one-time backup-code display after the user acknowledges them.
  void acknowledgeBackupCodes() {
    _lastBackupCodes = null;
    notifyListenersSafe();
  }

  /// Disables 2FA. Returns `true` on success. On the bearer path a 403 surfaces
  /// as [TwoFactorFailure.needsReauth] (the app lacks a session-bound proof for
  /// a 2FA enrolled this session); the caller messages that the user must sign
  /// in again to manage 2FA. The enabled flag is left unchanged on failure.
  Future<bool> disable({String? password}) async {
    _isMutating = true;
    _failure = null;
    notifyListenersSafe();
    try {
      await repository.disable(password: password);
      _enabled = false;
      return true;
    } on TwoFactorException catch (e) {
      _failure = e.failure;
      return false;
    } catch (_) {
      _failure = TwoFactorFailure.unknown;
      return false;
    } finally {
      _isMutating = false;
      notifyListenersSafe();
    }
  }
}

/// Discrete steps of the enroll flow the account section renders against.
enum TwoFactorStep {
  /// Not enrolling: showing status + an enable/disable affordance.
  idle,

  /// Secret provisioned; showing it and collecting the first TOTP code.
  awaitingCode,
}
