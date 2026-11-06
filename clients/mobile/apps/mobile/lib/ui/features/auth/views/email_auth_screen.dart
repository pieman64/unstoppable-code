import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/data/repositories/email_auth_repository.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/view_models/email_auth_view_model.dart';
import 'package:provider/provider.dart';

class EmailAuthScreen extends StatefulWidget {
  const EmailAuthScreen({required this.repository, super.key});
  final EmailAuthRepository repository;

  @override
  State<EmailAuthScreen> createState() => _EmailAuthScreenState();
}

class _EmailAuthScreenState extends State<EmailAuthScreen>
    with WidgetsBindingObserver {
  late final AuthViewModel _auth = context.read<AuthViewModel>();
  late final EmailAuthViewModel _model = EmailAuthViewModel(
    repository: widget.repository,
    onAuthenticated: _auth.acceptEmailSignIn,
    onSignInFailure: _auth.handleEmailSignInFailure,
  );
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _newPassword = TextEditingController();
  final _code = TextEditingController();
  final _codeFocus = FocusNode();
  bool _visible = false;
  bool _left = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _auth.addListener(_leaveOnceComplete);
    _model.addListener(_sync);
    unawaited(_model.resume());
  }

  void _leaveOnceComplete() {
    if (_left || !mounted) return;
    if (_auth.hasAccount ||
        _auth.status == AuthStatus.twoFactorPending ||
        _auth.status == AuthStatus.validationFailed) {
      final route = ModalRoute.of(context);
      if (route == null) return;
      _left = true;
      Navigator.of(context).removeRoute(route);
    }
  }

  void _sync() {
    if (!mounted) return;
    for (final (controller, value) in [
      (_password, _model.password),
      (_newPassword, _model.newPassword),
      (_code, _model.code),
    ]) {
      if (controller.text != value) controller.text = value;
    }
    setState(() {});
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _model.suspend();
      _visible = false;
    } else if (state == AppLifecycleState.resumed) {
      unawaited(_model.resume());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _auth.removeListener(_leaveOnceComplete);
    _model.removeListener(_sync);
    _model.dispose();
    for (final controller in [_email, _password, _newPassword, _code]) {
      controller.clear();
      controller.dispose();
    }
    _codeFocus.dispose();
    super.dispose();
  }

  void _submit() {
    if (_form.currentState?.validate() != true) return;
    unawaited(
      _model.submit().then((_) {
        if (mounted && _model.step == EmailAuthStep.verify) {
          _codeFocus.requestFocus();
        }
      }),
    );
  }

  void _go(EmailAuthStep step) {
    _visible = false;
    _model.goTo(step);
  }

  Widget _passwordField({bool replacement = false, bool creating = false}) {
    return TextFormField(
      key: Key(replacement ? 'emailNewPassword' : 'emailPassword'),
      controller: replacement ? _newPassword : _password,
      enabled: !_model.busy,
      obscureText: !_visible,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: [
        creating || replacement
            ? AutofillHints.newPassword
            : AutofillHints.password,
      ],
      onChanged: (value) {
        setState(() {
          if (replacement) {
            _model.newPassword = value;
          } else {
            _model.password = value;
          }
        });
      },
      validator: (value) {
        if (_model.step == EmailAuthStep.verify) return null;
        if (value == null || value.isEmpty) return 'Enter your password.';
        if ((creating || replacement) && value.length < 12) {
          return 'Use at least 12 characters.';
        }
        if (value.length > 128) return 'Use 128 characters or fewer.';
        return null;
      },
      textInputAction: TextInputAction.done,
      onFieldSubmitted: (_) => _submit(),
      decoration: InputDecoration(
        labelText: replacement ? 'New password' : 'Password',
        helperText: creating || replacement
            ? 'Use at least 12 characters.'
            : null,
        border: const OutlineInputBorder(),
        suffixIcon: IconButton(
          tooltip: _visible ? 'Hide password' : 'Show password',
          onPressed: _model.busy
              ? null
              : () => setState(() => _visible = !_visible),
          icon: Icon(
            _visible
                ? Icons.visibility_off_outlined
                : Icons.visibility_outlined,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final step = _model.step;
    final pending = step == EmailAuthStep.verify || step == EmailAuthStep.reset;
    final title = switch (step) {
      EmailAuthStep.signUp => 'Create your account',
      EmailAuthStep.verify => 'Check your email',
      EmailAuthStep.forgot || EmailAuthStep.reset => 'Reset your password',
      _ => 'Sign in with email',
    };
    final action = switch (step) {
      EmailAuthStep.signUp => 'Create account',
      EmailAuthStep.verify => 'Verify email',
      EmailAuthStep.forgot => 'Send code',
      EmailAuthStep.reset => 'Reset password',
      _ => 'Sign in',
    };
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: AutofillGroup(
                child: Form(
                  key: _form,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_model.notice case final notice?) ...[
                        Semantics(liveRegion: true, child: Text(notice)),
                        const SizedBox(height: 16),
                      ],
                      if (!_model.available) ...[
                        Semantics(
                          liveRegion: true,
                          child: Text(
                            _model.error ?? 'Email sign-in is unavailable.',
                          ),
                        ),
                        TextButton(
                          onPressed: () => unawaited(_model.resume()),
                          child: const Text('Try again'),
                        ),
                        TextButton(
                          onPressed: () => Navigator.of(context).pop(),
                          child: const Text('Back to sign in'),
                        ),
                      ] else ...[
                        if (pending)
                          Text(_model.email)
                        else
                          TextFormField(
                            key: const Key('emailAddress'),
                            controller: _email,
                            enabled: !_model.busy,
                            keyboardType: TextInputType.emailAddress,
                            autofillHints: const [
                              AutofillHints.email,
                              AutofillHints.username,
                            ],
                            autocorrect: false,
                            textInputAction: TextInputAction.next,
                            onChanged: _model.changeEmail,
                            validator: (value) =>
                                value != null &&
                                    RegExp(
                                      r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
                                    ).hasMatch(value.trim())
                                ? null
                                : 'Enter your email.',
                            decoration: const InputDecoration(
                              labelText: 'Email',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        const SizedBox(height: 16),
                        if (pending) ...[
                          TextFormField(
                            key: const Key('emailCode'),
                            controller: _code,
                            focusNode: _codeFocus,
                            enabled: !_model.busy,
                            keyboardType: TextInputType.number,
                            autofillHints: const [AutofillHints.oneTimeCode],
                            inputFormatters: [
                              FilteringTextInputFormatter.digitsOnly,
                              LengthLimitingTextInputFormatter(6),
                            ],
                            autocorrect: false,
                            textInputAction: step == EmailAuthStep.reset
                                ? TextInputAction.next
                                : TextInputAction.done,
                            validator: (value) =>
                                value != null &&
                                    RegExp(r'^[0-9]{6}$').hasMatch(value)
                                ? null
                                : 'Enter the 6-digit code.',
                            onChanged: (value) {
                              final previous = _model.code;
                              _model.code = value;
                              if (step == EmailAuthStep.verify &&
                                  value.length == 6 &&
                                  value != previous) {
                                unawaited(_model.submit());
                              }
                            },
                            onFieldSubmitted: (_) =>
                                step == EmailAuthStep.verify ? _submit() : null,
                            decoration: InputDecoration(
                              labelText: step == EmailAuthStep.verify
                                  ? 'Verification code'
                                  : 'Reset code',
                              border: const OutlineInputBorder(),
                            ),
                          ),
                          const SizedBox(height: 16),
                        ],
                        if (step != EmailAuthStep.forgot)
                          _passwordField(
                            replacement: step == EmailAuthStep.reset,
                            creating: step == EmailAuthStep.signUp,
                          ),
                        if (step == EmailAuthStep.verify) ...[
                          const SizedBox(height: 8),
                          const Text(
                            'Enter your password to get a new code, or verify without it and sign in afterward.',
                          ),
                        ],
                        if (_model.error case final error?) ...[
                          const SizedBox(height: 16),
                          Semantics(
                            liveRegion: true,
                            child: Text(
                              error,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.error,
                              ),
                            ),
                          ),
                        ],
                        const SizedBox(height: 24),
                        FilledButton(
                          key: const Key('emailSubmit'),
                          onPressed: _model.busy ? null : _submit,
                          child: _model.busy
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : Text(action),
                        ),
                        if (pending)
                          TextButton(
                            key: const Key('emailResend'),
                            onPressed:
                                _model.busy ||
                                    _model.resendSeconds > 0 ||
                                    (step == EmailAuthStep.verify &&
                                        _model.password.isEmpty)
                                ? null
                                : () => unawaited(_model.resend()),
                            child: Text(
                              _model.resendSeconds > 0
                                  ? 'Resend code in ${_model.resendSeconds}s'
                                  : 'Resend code',
                            ),
                          ),
                        if (step == EmailAuthStep.signIn ||
                            step == EmailAuthStep.verified) ...[
                          TextButton(
                            onPressed: _model.busy
                                ? null
                                : () => _go(EmailAuthStep.signUp),
                            child: const Text('Create an account'),
                          ),
                          TextButton(
                            onPressed: _model.busy
                                ? null
                                : () => _go(EmailAuthStep.forgot),
                            child: const Text('Forgot password?'),
                          ),
                        ] else ...[
                          TextButton(
                            onPressed: _model.busy
                                ? null
                                : () => _go(EmailAuthStep.signIn),
                            child: const Text('Back to sign in'),
                          ),
                          if (step == EmailAuthStep.verify) ...[
                            TextButton(
                              onPressed: _model.busy
                                  ? null
                                  : () => _go(EmailAuthStep.forgot),
                              child: const Text('Reset password'),
                            ),
                            TextButton(
                              onPressed: _model.busy
                                  ? null
                                  : () {
                                      _email.clear();
                                      _model.changeEmail('');
                                      _go(EmailAuthStep.signUp);
                                    },
                              child: const Text('Use a different email'),
                            ),
                          ],
                        ],
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
