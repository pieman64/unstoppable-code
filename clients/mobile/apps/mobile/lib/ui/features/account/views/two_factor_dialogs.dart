import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile/data/models/two_factor.dart';
import 'package:mobile/data/services/two_factor_api_service.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/account/view_models/two_factor_view_model.dart';

// The two-factor enrollment, backup-code, re-authentication and password
// dialogs, unchanged from the former inline Account section.

/// Maps a [TwoFactorFailure] to a user-facing message.
String twoFactorFailureMessage(TwoFactorFailure? failure) => switch (failure) {
  TwoFactorFailure.invalidCode => 'That code was not valid. Please try again.',
  TwoFactorFailure.rateLimited =>
    'Too many attempts. Please wait a moment and try again.',
  // A 2FA enrolled in this session leaves the app without a session-bound
  // proof, so the server rejects management until the user re-authenticates.
  TwoFactorFailure.needsReauth =>
    'Please sign out and sign in again to manage two-factor authentication.',
  TwoFactorFailure.unknown || null => 'Something went wrong. Please try again.',
};

/// Shows the provisioned secret/URI and collects the first TOTP code, verifying
/// it against [vm]. Pops with `true` once accepted, or `null`/`false` if the
/// user cancels. No QR image: the otpauth URI and secret are shown as
/// selectable text (a QR image is a possible follow-up).
Future<bool?> showEnrollDialog(
  BuildContext context,
  TwoFactorViewModel vm,
  TwoFactorEnrollment enrollment,
) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => _EnrollDialog(vm: vm, enrollment: enrollment),
  );
}

class _EnrollDialog extends StatefulWidget {
  const _EnrollDialog({required this.vm, required this.enrollment});

  final TwoFactorViewModel vm;
  final TwoFactorEnrollment enrollment;

  @override
  State<_EnrollDialog> createState() => _EnrollDialogState();
}

class _EnrollDialogState extends State<_EnrollDialog> {
  final TextEditingController _controller = TextEditingController();
  bool _submitting = false;
  bool _showError = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) return;
    setState(() {
      _submitting = true;
      _showError = false;
    });
    final ok = await widget.vm.verifyEnrollment(_controller.text.trim());
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _submitting = false;
      _showError = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final enrollment = widget.enrollment;
    final secret = enrollment.secret;
    return AlertDialog(
      title: const Text('Set up authenticator'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Add this account to your authenticator app, then enter the '
              '6-digit code it shows.',
            ),
            const SizedBox(height: 12),
            if (secret != null) ...[
              const Text('Setup key'),
              const SizedBox(height: 4),
              _CopyableField(label: 'Setup key', value: secret),
              const SizedBox(height: 12),
            ],
            const Text('Setup URL'),
            const SizedBox(height: 4),
            _CopyableField(label: 'Setup URL', value: enrollment.otpauthUri),
            const SizedBox(height: 16),
            TextField(
              controller: _controller,
              autofocus: true,
              enabled: !_submitting,
              keyboardType: TextInputType.number,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => unawaited(_submit()),
              decoration: const InputDecoration(
                labelText: '6-digit code',
                hintText: '123456',
              ),
            ),
            if (_showError) ...[
              const SizedBox(height: 8),
              Text(
                twoFactorFailureMessage(widget.vm.failure),
                style: AppTypography.bodySmall.copyWith(
                  color: Theme.of(context).colorScheme.error,
                ),
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _submitting
              ? null
              : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _submitting ? null : () => unawaited(_submit()),
          child: Text(_submitting ? 'Verifying…' : 'Verify'),
        ),
      ],
    );
  }
}

/// A read-only value with a copy affordance, used for the setup key and URL.
class _CopyableField extends StatelessWidget {
  const _CopyableField({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: SelectableText(
            value,
            style: theme.textTheme.bodySmall?.copyWith(
              fontFamily: AppTypography.monoFamily,
            ),
          ),
        ),
        IconButton(
          icon: const Icon(Icons.copy, size: 18),
          tooltip: 'Copy $label',
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: value));
            if (context.mounted) {
              ScaffoldMessenger.of(
                context,
              ).showSnackBar(SnackBar(content: Text('$label copied')));
            }
          },
        ),
      ],
    );
  }
}

/// Shows the one-time backup codes with a copy affordance.
Future<void> showBackupCodes(BuildContext context, List<String> codes) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => PopScope(
      canPop: false,
      child: AlertDialog(
        title: const Text('Save your backup codes'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'These codes are shown once. Store them somewhere safe — each can '
              'be used to sign in if you lose your authenticator.',
            ),
            const SizedBox(height: 12),
            SelectableText(
              codes.join('\n'),
              style: const TextStyle(fontFamily: AppTypography.monoFamily),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: codes.join('\n')));
              if (dialogContext.mounted) {
                Navigator.of(dialogContext).pop();
              }
            },
            child: const Text('Copy'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Done'),
          ),
        ],
      ),
    ),
  );
}

Future<void> showReauthAfterTwoFactorChange(
  BuildContext context, {
  required bool enabled,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => AlertDialog(
      title: const Text('Sign in again'),
      content: Text(
        'Two-factor authentication is ${enabled ? 'enabled' : 'disabled'}. '
        'Please sign in again to continue with refreshed credentials.',
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}

Future<String?> promptForAccountPassword(
  BuildContext context, {
  required String action,
}) {
  return showDialog<String>(
    context: context,
    builder: (dialogContext) => _PasswordDialog(action: action),
  );
}

class _PasswordDialog extends StatefulWidget {
  const _PasswordDialog({required this.action});

  final String action;

  @override
  State<_PasswordDialog> createState() => _PasswordDialogState();
}

class _PasswordDialogState extends State<_PasswordDialog> {
  final TextEditingController _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    if (_controller.text.isEmpty) return;
    Navigator.of(context).pop(_controller.text);
  }

  @override
  Widget build(BuildContext context) {
    final canSubmit = _controller.text.isNotEmpty;
    return AlertDialog(
      title: const Text('Confirm account password'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        obscureText: true,
        textInputAction: TextInputAction.done,
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) => _submit(),
        decoration: InputDecoration(
          labelText: 'Password',
          helperText: 'Required to ${widget.action}.',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: canSubmit ? _submit : null,
          child: const Text('Continue'),
        ),
      ],
    );
  }
}
