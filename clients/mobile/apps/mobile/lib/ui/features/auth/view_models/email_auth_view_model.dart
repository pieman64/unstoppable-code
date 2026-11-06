import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/social_sign_in_result.dart';
import 'package:mobile/data/repositories/email_auth_repository.dart';
import 'package:mobile/data/services/email_auth_api_service.dart';

enum EmailAuthStep { signIn, signUp, verify, forgot, reset, verified }

/// Owns an in-memory attempt. Nothing here is written to preferences or URLs.
final class EmailAuthViewModel extends ChangeNotifier {
  EmailAuthViewModel({
    required this.repository,
    required this.onAuthenticated,
    required this.onSignInFailure,
    DateTime Function()? now,
    Timer Function(void Function())? ticker,
  }) : _now = now ?? DateTime.now {
    _ticker =
        (ticker ??
        ((tick) =>
            Timer.periodic(const Duration(seconds: 1), (_) => tick())))(() {
          if (!_disposed && _resendAt != null) notifyListeners();
        });
  }

  final EmailAuthRepository repository;
  final Future<void> Function(SocialSignInResult) onAuthenticated;
  final Future<void> Function(Object) onSignInFailure;
  final DateTime Function() _now;
  late final Timer _ticker;
  int _generation = 0;
  bool _disposed = false;
  bool busy = false;
  bool available = true;
  EmailAuthStep step = EmailAuthStep.signIn;
  String email = '';
  String password = '';
  String newPassword = '';
  String code = '';
  String? error;
  String? notice;
  DateTime? _resendAt;

  int get resendSeconds {
    final milliseconds = _resendAt?.difference(_now()).inMilliseconds ?? 0;
    return milliseconds <= 0 ? 0 : (milliseconds / 1000).ceil();
  }

  bool _current(int generation) => !_disposed && _generation == generation;

  void changeEmail(String value) {
    if (value == email) return;
    _invalidate();
    email = value;
    _clearSecrets();
    _resendAt = null;
    error = null;
    notice = null;
    notifyListeners();
  }

  void goTo(EmailAuthStep next) {
    _invalidate();
    _clearSecrets();
    step = next;
    error = null;
    notice = null;
    _resendAt = null;
    notifyListeners();
  }

  void _invalidate() {
    ++_generation;
    repository.cancelEmailSignIn();
    busy = false;
  }

  void _clearSecrets() {
    password = '';
    newPassword = '';
    code = '';
  }

  void _cooldown([int seconds = 60]) {
    _resendAt = _now().add(Duration(seconds: seconds < 60 ? 60 : seconds));
  }

  Future<void> _run(Future<void> Function(int generation) action) async {
    if (busy || !available || _disposed) return;
    final generation = ++_generation;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await action(generation);
    } on EmailAuthException catch (failure) {
      if (!_current(generation)) return;
      error = failure.message;
      if (failure.needsNewCode) code = '';
      if (failure.retryAfterSeconds case final seconds?) _cooldown(seconds);
      if (failure.unavailable) {
        available = false;
        _clearSecrets();
      }
    } catch (_) {
      if (!_current(generation)) return;
      error = 'Something went wrong. Try again.';
    } finally {
      if (_current(generation)) {
        busy = false;
        notifyListeners();
      }
    }
  }

  Future<void> _signIn(int generation, {bool resend = false}) async {
    final EmailSignInResult result;
    try {
      result = await repository.signInWithEmail(
        email: email.trim(),
        password: password,
      );
    } catch (error) {
      if (_current(generation)) await onSignInFailure(error);
      rethrow;
    }
    if (!_current(generation)) return;
    switch (result) {
      case EmailSignInVerification():
        step = EmailAuthStep.verify;
        code = '';
        notice = resend
            ? 'If a new code was due, we emailed it. It can take a minute to arrive.'
            : "Your email isn't verified yet. Check your email for a 6-digit code.";
        _cooldown();
      case EmailSignInComplete(:final result):
        _clearSecrets();
        await onAuthenticated(result);
    }
  }

  Future<void> submit() => _run((generation) async {
    switch (step) {
      case EmailAuthStep.signIn || EmailAuthStep.verified:
        await _signIn(generation);
      case EmailAuthStep.signUp:
        await repository.signUpWithEmail(email.trim(), password);
        if (!_current(generation)) return;
        step = EmailAuthStep.verify;
        notice =
            'If this address needs verification, check your email for a 6-digit code.';
        _cooldown();
      case EmailAuthStep.verify:
        if (!RegExp(r'^[0-9]{6}$').hasMatch(code)) return;
        await repository.verifyEmailCode(email.trim(), code);
        if (!_current(generation)) return;
        step = EmailAuthStep.verified;
        code = '';
        notice = 'Your email is verified. Sign in to continue.';
        if (password.isNotEmpty) await _signIn(generation);
      case EmailAuthStep.forgot:
        await repository.requestEmailPasswordReset(email.trim());
        if (!_current(generation)) return;
        step = EmailAuthStep.reset;
        notice =
            'If an account exists for ${email.trim()}, we sent a 6-digit code.';
        _cooldown();
      case EmailAuthStep.reset:
        if (!RegExp(r'^[0-9]{6}$').hasMatch(code)) return;
        await repository.resetEmailPassword(email.trim(), code, newPassword);
        if (!_current(generation)) return;
        password = newPassword;
        newPassword = '';
        code = '';
        step = EmailAuthStep.verified;
        notice = 'Your password is reset. Sign in to continue.';
        await _signIn(generation);
    }
  });

  Future<void> resend() async {
    if (resendSeconds > 0) return;
    await _run((generation) async {
      if (step == EmailAuthStep.verify) {
        if (password.isNotEmpty) await _signIn(generation, resend: true);
      } else if (step == EmailAuthStep.reset) {
        await repository.requestEmailPasswordReset(email.trim());
        if (!_current(generation)) return;
        code = '';
        notice =
            'If an account exists for ${email.trim()}, we sent a 6-digit code.';
        _cooldown();
      }
    });
  }

  /// OS backgrounding drops secrets; resume preserves only email/flow/deadline.
  void suspend() {
    _invalidate();
    _clearSecrets();
    notifyListeners();
  }

  Future<void> resume() async {
    _invalidate();
    final generation = _generation;
    final enabled = await repository.emailAuthAvailable();
    if (!_current(generation)) return;
    available = enabled;
    if (!enabled) {
      _clearSecrets();
      error = const EmailAuthException('EMAIL_AUTH_UNAVAILABLE').message;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _invalidate();
    _clearSecrets();
    _ticker.cancel();
    super.dispose();
  }
}
