import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/social_sign_in_buttons.dart';
import 'package:mobile/ui/features/auth/views/email_sign_in_entry.dart';
import 'package:provider/provider.dart';

/// Where a guest signs in (CAN-2872), pushed over their app from Settings.
///
/// The guest stays signed in as a guest while this is open, so backing out or
/// a failed sign-in leaves them where they were. Signing in merges the guest's
/// chats into the account, and this screen removes itself as soon as the
/// session is no longer a guest's: the app behind it has become the account's,
/// or the root gate has moved on to two-factor entry.
class GuestSignInScreen extends StatefulWidget {
  const GuestSignInScreen({super.key});

  static Future<void> open(BuildContext context) {
    // A failure from an earlier attempt belongs to that attempt.
    context.read<AuthViewModel>().clearError();
    return Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => const GuestSignInScreen()));
  }

  @override
  State<GuestSignInScreen> createState() => _GuestSignInScreenState();
}

class _GuestSignInScreenState extends State<GuestSignInScreen> {
  late final AuthViewModel _auth = context.read<AuthViewModel>();
  bool _left = false;

  @override
  void initState() {
    super.initState();
    _auth.addListener(_leaveOnceSignedIn);
  }

  @override
  void dispose() {
    _auth.removeListener(_leaveOnceSignedIn);
    super.dispose();
  }

  void _leaveOnceSignedIn() {
    if (_left || !mounted) return;
    if (_auth.status == AuthStatus.authenticated && _auth.isGuest) return;
    final route = ModalRoute.of(context);
    if (route == null) return;
    _left = true;
    // Removed rather than popped: the route may no longer be the top one.
    Navigator.of(context).removeRoute(route);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthViewModel>();
    final theme = Theme.of(context);
    final busy = auth.isSigningIn;
    final errorMessage = auth.errorMessage;
    return Scaffold(
      appBar: AppBar(),
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
                    'Sign in to keep your chats',
                    style: theme.textTheme.headlineSmall?.copyWith(
                      fontWeight: AppTypography.emphasisWeight,
                      fontVariations: AppTypography.emphasisVariations,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Your guest chats come with you.',
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 32),
                  if (errorMessage != null) ...[
                    Text(
                      errorMessage,
                      key: const Key('guestSignInError'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.error,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 16),
                  ],
                  SocialSignInButtons(
                    enabled: !busy,
                    onSocial: (provider) =>
                        unawaited(auth.signInWithSocial(provider)),
                    onApple: () => unawaited(auth.signInWithApple()),
                  ),
                  EmailSignInEntry(enabled: !busy),
                  if (busy) ...[
                    const SizedBox(height: 24),
                    const Center(
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
