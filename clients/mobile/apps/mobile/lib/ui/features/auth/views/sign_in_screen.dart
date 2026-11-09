import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:provider/provider.dart';
import 'package:mobile/brand/brand.g.dart';
import 'package:mobile/config/api_environment.dart';
import 'package:mobile/config/app_config.dart';
import 'package:mobile/config/demo_mode.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/auth/views/social_sign_in_buttons.dart';
import 'package:mobile/ui/features/auth/views/email_sign_in_entry.dart';

/// Social sign-in and server-gated native email authentication.
///
/// The email/password `AuthRepository.signIn` plumbing is retained for seeded
/// test accounts and is surfaced only through a deliberately obscure gesture:
/// tapping the brand logo [DemoMode.activationTapCount] times reveals a
/// reviewer email/password form and puts the app into [DemoMode] (mock-backed,
/// no network). This is the App Store / Google Play reviewer path for the
/// org-gated app — invisible to normal users and disclosed only in the store
/// review notes. See [DemoMode].
///
/// Reads [AuthViewModel] for the in-flight/loading state and the last error;
/// the root auth gate swaps this screen out once [AuthStatus.authenticated].
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  /// Hold time that opens the hidden environment chooser.
  ///
  /// This is a real [LongPressGestureRecognizer] deadline, not a wall-clock
  /// timer, so it does not need to be padded out to several seconds to stay
  /// obscure: the recognizer competes in the gesture arena, which means a
  /// scroll drag beats it outright and an ordinary tap never reaches it. A
  /// slightly-longer-than-standard press is enough to keep it undiscoverable
  /// while still being reachable on the first try.
  ///
  /// It must stay well under the point where a user assumes the gesture is not
  /// working and lets go — an aborted press falls through to the tap
  /// recognizer, and five of those trip the [DemoMode] reviewer gesture
  /// instead, which is what made the old multi-second hold feel broken.
  static const Duration environmentPickerHoldDuration = Duration(
    milliseconds: 700,
  );

  /// Longest press that still counts toward the [DemoMode] reviewer taps.
  ///
  /// Presses between this and [environmentPickerHoldDuration] deliberately do
  /// nothing at all: someone in that window was reaching for the hidden
  /// environment hold and let go early, and must not be silently pushed toward
  /// the reviewer form instead. Only a genuinely quick tap counts.
  static const Duration maxReviewerTapDuration = Duration(milliseconds: 400);

  /// Padding added around the logo purely to enlarge the touch target.
  static const double logoTouchPadding = 16;

  /// Rendered size of the brand logo.
  static const double logoSize = 72;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _passwordController = TextEditingController();
  int _logoTapCount = 0;
  bool _environmentPickerOpen = false;
  Timer? _quickTapWindow;
  bool _lastLogoPressWasQuick = false;

  @override
  void dispose() {
    _quickTapWindow?.cancel();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _signInWithSocial(SocialProvider provider) {
    unawaited(context.read<AuthViewModel>().signInWithSocial(provider));
  }

  void _signInWithApple() {
    unawaited(context.read<AuthViewModel>().signInWithApple());
  }

  /// Counts logo taps; the Nth tap activates the reviewer login (and demo mode).
  /// Taps are ignored once demo mode is on (the logo is no longer visible then).
  ///
  /// A press that becomes a long press never arrives here: the long-press
  /// recognizer wins the gesture arena and rejects the tap recognizer, so
  /// opening the environment picker cannot also advance this counter.
  void _handleLogoTap() {
    if (DemoMode.enabled.value) return;
    // A press long enough to have been an attempt at the environment hold is
    // not a reviewer tap, even though the arena still reports it as one.
    if (!_lastLogoPressWasQuick) {
      _logoTapCount = 0;
      return;
    }
    _advanceReviewerTapCount();
  }

  /// Counts a semantic activation without applying the physical press timer.
  ///
  /// Accessibility services dispatch tap actions directly, without the pointer
  /// events observed by [_handleLogoPointerDown], so they need a separate path
  /// into the same reviewer-tap counter.
  void _handleLogoSemanticTap() {
    if (DemoMode.enabled.value) return;
    _advanceReviewerTapCount();
  }

  void _advanceReviewerTapCount() {
    _logoTapCount++;
    if (_logoTapCount >= DemoMode.activationTapCount) {
      _logoTapCount = 0;
      DemoMode.enabled.value = true;
    }
  }

  // Classifies how long the current press has lasted. These observe only — the
  // gesture arena still decides which gesture fires; this just tells
  // [_handleLogoTap] whether the press was quick enough to have been a tap.
  //
  // A timer rather than pointer-event timestamps, deliberately: this shares the
  // clock that drives [LongPressGestureRecognizer], so the tap window and the
  // hold deadline can never disagree about how long a press lasted.
  void _handleLogoPointerDown(PointerDownEvent _) {
    _quickTapWindow?.cancel();
    _lastLogoPressWasQuick = true;
    _quickTapWindow = Timer(
      SignInScreen.maxReviewerTapDuration,
      () => _lastLogoPressWasQuick = false,
    );
  }

  void _handleLogoPointerUp(PointerUpEvent _) {
    // Freezes whatever the window decided at the moment the finger lifted.
    _quickTapWindow?.cancel();
  }

  void _handleLogoPointerCancel(PointerCancelEvent _) {
    _quickTapWindow?.cancel();
    _lastLogoPressWasQuick = false;
  }

  void _handleLogoLongPress() {
    // Deliberately silent: no haptic, no visual acknowledgement. This is a
    // hidden gesture, so a stray long press by an ordinary user must give away
    // nothing. The dialog appearing is the only signal it exists.
    unawaited(_showEnvironmentPicker());
  }

  Future<void> _showEnvironmentPicker() async {
    if (_environmentPickerOpen || DemoMode.enabled.value) return;
    _environmentPickerOpen = true;
    final authViewModel = context.read<AuthViewModel>();
    try {
      final selected = await showDialog<ApiEnvironment>(
        context: context,
        builder: (dialogContext) => SimpleDialog(
          key: const Key('apiEnvironmentPicker'),
          title: const Text('Server environment'),
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(24, 0, 24, 12),
              child: Text(
                'Changing servers signs you out. Only predefined servers are available.',
              ),
            ),
            for (final environment in ApiEnvironment.values)
              if (AppConfig.isEnvironmentAvailable(environment))
                SimpleDialogOption(
                  key: Key('${environment.name}EnvironmentOption'),
                  onPressed: () => Navigator.of(dialogContext).pop(environment),
                  child: Row(
                    children: [
                      Icon(
                        AppConfig.environment == environment
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(environment.label),
                            Text(
                              environment == ApiEnvironment.production
                                  ? 'Live organization data'
                                  : 'Test organization data',
                              style: Theme.of(
                                dialogContext,
                              ).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
          ],
        ),
      );
      if (selected == null || selected == AppConfig.environment) return;

      await authViewModel.signOut();
      if (!mounted) return;
      await AppConfig.selectEnvironment(selected);
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not change server environment.')),
      );
    } finally {
      _environmentPickerOpen = false;
    }
  }

  /// Leaves the reviewer login and returns to the OAuth-only screen.
  void _closeReviewerLogin() {
    _logoTapCount = 0;
    _emailController.clear();
    _passwordController.clear();
    DemoMode.enabled.value = false;
  }

  void _submitReviewerLogin() {
    unawaited(
      context.read<AuthViewModel>().signIn(
        email: _emailController.text.trim(),
        password: _passwordController.text,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.watch<AuthViewModel>();
    return ValueListenableBuilder<ApiEnvironment>(
      valueListenable: AppConfig.environmentListenable,
      builder: (context, _, _) => ValueListenableBuilder<bool>(
        valueListenable: DemoMode.enabled,
        builder: (context, reviewerLogin, _) => Scaffold(
          body: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 400),
                  child: reviewerLogin
                      ? _buildReviewerLogin(context, viewModel)
                      : _buildOAuth(context, viewModel),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildOAuth(BuildContext context, AuthViewModel viewModel) {
    final theme = Theme.of(context);
    final isBusy = viewModel.status == AuthStatus.authenticating;
    final errorMessage = viewModel.errorMessage;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Center(
          child: Semantics(
            key: const Key('signInLogo'),
            button: true,
            enabled: !isBusy,
            label: 'Sign-in logo',
            excludeSemantics: true,
            onTap: isBusy ? null : _handleLogoSemanticTap,
            child: Listener(
              // Observes press duration only; see [_handleLogoPointerDown].
              onPointerDown: _handleLogoPointerDown,
              onPointerUp: _handleLogoPointerUp,
              onPointerCancel: _handleLogoPointerCancel,
              child: RawGestureDetector(
                behavior: HitTestBehavior.opaque,
                excludeFromSemantics: true,
                // Both recognizers share one arena, so the long press that opens
                // the environment picker rejects the tap instead of also
                // counting toward the reviewer tap gesture, and a scroll drag
                // beats both.
                gestures: <Type, GestureRecognizerFactory>{
                  TapGestureRecognizer:
                      GestureRecognizerFactoryWithHandlers<
                        TapGestureRecognizer
                      >(TapGestureRecognizer.new, (
                        TapGestureRecognizer instance,
                      ) {
                        instance.onTap = isBusy ? null : _handleLogoTap;
                      }),
                  LongPressGestureRecognizer:
                      GestureRecognizerFactoryWithHandlers<
                        LongPressGestureRecognizer
                      >(
                        () => LongPressGestureRecognizer(
                          duration: SignInScreen.environmentPickerHoldDuration,
                        ),
                        (LongPressGestureRecognizer instance) {
                          instance.onLongPress = isBusy
                              ? null
                              : _handleLogoLongPress;
                        },
                      ),
                },
                child: Padding(
                  // Enlarges the touch target past the artwork: a hold needs more
                  // forgiveness than a tap, and the bare logo box left none.
                  padding: const EdgeInsets.all(SignInScreen.logoTouchPadding),
                  child: Image.asset(
                    'assets/splash/splash_logo.png',
                    // Both dimensions are explicit on purpose. With only a
                    // height, the render box is zero-width until the PNG
                    // decodes, and a zero-width box fails hit-testing outright.
                    width: SignInScreen.logoSize,
                    height: SignInScreen.logoSize,
                    errorBuilder: (context, error, stackTrace) => Icon(
                      Icons.hexagon_outlined,
                      size: 56,
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        if (AppConfig.isStaging) ...[
          const SizedBox(height: 12),
          Center(
            child: Container(
              key: const Key('stagingEnvironmentBadge'),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: theme.colorScheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                'STAGING SERVER',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onTertiaryContainer,
                  fontWeight: AppTypography.emphasisWeight,
                  fontVariations: AppTypography.emphasisVariations,
                ),
              ),
            ),
          ),
        ],
        const SizedBox(height: 24),
        // One screen for new and returning users: the first OAuth sign-in
        // with any provider creates the account (CAN-4424).
        Text(
          'Sign in or create an account',
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          "Connect your computer to work with your projects and chats.",
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 4),
        Text(
          'New to ${Brand.displayName}? Continuing creates your account.',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 32),
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
        SocialSignInButtons(
          enabled: !isBusy,
          onSocial: _signInWithSocial,
          onApple: _signInWithApple,
        ),
        EmailSignInEntry(enabled: !isBusy),
        if (isBusy) ...[
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
    );
  }

  Widget _buildReviewerLogin(BuildContext context, AuthViewModel viewModel) {
    final theme = Theme.of(context);
    final isBusy = viewModel.status == AuthStatus.authenticating;
    final errorMessage = viewModel.errorMessage;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: IconButton(
            key: const Key('reviewerBackButton'),
            icon: const Icon(Icons.arrow_back),
            onPressed: isBusy ? null : _closeReviewerLogin,
            tooltip: 'Back',
          ),
        ),
        const SizedBox(height: 8),
        Text(
          'Sign in with email',
          style: theme.textTheme.headlineSmall?.copyWith(
            fontWeight: AppTypography.emphasisWeight,
            fontVariations: AppTypography.emphasisVariations,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 32),
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
          key: const Key('reviewerEmailField'),
          controller: _emailController,
          enabled: !isBusy,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(
            labelText: 'Email',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('reviewerPasswordField'),
          controller: _passwordController,
          enabled: !isBusy,
          obscureText: true,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => isBusy ? null : _submitReviewerLogin(),
          decoration: const InputDecoration(
            labelText: 'Password',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 24),
        FilledButton(
          key: const Key('reviewerSignInButton'),
          onPressed: isBusy ? null : _submitReviewerLogin,
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          child: const Text('Sign in'),
        ),
        if (isBusy) ...[
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
    );
  }
}
