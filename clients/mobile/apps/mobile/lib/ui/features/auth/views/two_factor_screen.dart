import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';

/// Collects a second factor for an [AuthStatus.twoFactorPending] sign-in.
///
/// The single field accepts either a 6-digit authenticator (TOTP) code or a
/// backup code — the server decides which. Submitting drives
/// [AuthViewModel.verifyTwoFactor]; the root auth gate swaps this screen out on
/// success. Cancelling calls [AuthViewModel.cancelTwoFactor] and returns to the
/// sign-in screen.
class TwoFactorScreen extends StatefulWidget {
  const TwoFactorScreen({super.key});

  @override
  State<TwoFactorScreen> createState() => _TwoFactorScreenState();
}

class _TwoFactorScreenState extends State<TwoFactorScreen> {
  final _codeController = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final code = _codeController.text.trim();
    if (code.isEmpty) return;
    // Capture the view model before the await so we never touch BuildContext
    // across the async gap.
    final viewModel = context.read<AuthViewModel>();
    setState(() => _submitting = true);
    await viewModel.verifyTwoFactor(code);
    if (!mounted) return;
    setState(() => _submitting = false);
  }

  void _cancel() {
    context.read<AuthViewModel>().cancelTwoFactor();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final errorMessage = context.select<AuthViewModel, String?>(
      (vm) => vm.errorMessage,
    );

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Two-factor authentication',
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Enter the 6-digit code from your authenticator app, or one '
                    'of your backup codes.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  if (errorMessage != null) ...[
                    Text(
                      errorMessage,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                  ],
                  TextField(
                    controller: _codeController,
                    enabled: !_submitting,
                    autofocus: true,
                    autocorrect: false,
                    enableSuggestions: false,
                    textInputAction: TextInputAction.done,
                    onSubmitted: _submitting
                        ? null
                        : (_) => unawaited(_submit()),
                    decoration: const InputDecoration(
                      labelText: 'Authentication code',
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.lock_outline),
                    ),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _submitting ? null : () => unawaited(_submit()),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size.fromHeight(48),
                    ),
                    child: _submitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Verify'),
                  ),
                  const SizedBox(height: 12),
                  TextButton(
                    onPressed: _submitting ? null : _cancel,
                    child: const Text('Cancel'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
