import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:mobile/data/models/social_provider.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

/// The provider buttons: Unstoppable, Google, GitHub, and Sign in with Apple
/// on iOS. Shared by the sign-in screen and the screen a guest signs in from
/// (CAN-2872), so both offer the same providers in the same order.
class SocialSignInButtons extends StatelessWidget {
  const SocialSignInButtons({
    super.key,
    required this.enabled,
    required this.onSocial,
    required this.onApple,
  });

  /// False while a sign-in is in flight.
  final bool enabled;

  /// Starts the browser OAuth flow for a provider.
  final ValueChanged<SocialProvider> onSocial;

  /// Starts native Sign in with Apple.
  final VoidCallback onApple;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    // The Apple button's appearance is fixed by Apple, so it anchors the set and
    // the Google/GitHub buttons conform to it: a solid button that is black on
    // light backgrounds and white on dark. Using literal black/white (not theme
    // tokens) so the fill matches the Apple button's fixed colors exactly, and a
    // shared radius so all three are the same shape.
    const double authRadius = 12; // matches the app card corner (Brand.radius)
    const double authHeight = 48;
    const double authIconSize = 20; // shared logo height across all three
    const double authIconGap = 12; // shared logo-to-label gap
    final Color authFill = isDark ? Colors.white : Colors.black;
    final Color authLabel = isDark ? Colors.black : Colors.white;
    // Use a normal button label (the app's own font at a medium weight) rather
    // than copying the Apple button's oversized SF Pro text — the unified black
    // container and the provider logos carry the cohesion. Apple's built-in
    // label stays a bit larger by design, which reads as a system button.
    final authTextStyle = AppTypography.title;
    final ButtonStyle solidAuthStyle = FilledButton.styleFrom(
      minimumSize: const Size.fromHeight(authHeight),
      backgroundColor: authFill,
      foregroundColor: authLabel,
      disabledBackgroundColor: authFill.withValues(alpha: 0.5),
      disabledForegroundColor: authLabel,
      textStyle: authTextStyle,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(authRadius),
      ),
    );

    // All three buttons share one layout — provider logo, a fixed gap, then the
    // label — so logo height, gap, and text position are identical. The Apple
    // button draws the SDK's own AppleLogoPainter at the same height (below)
    // instead of the package widget, whose fixed geometry couldn't match.
    Widget providerButton({
      Key? key,
      required String label,
      required Widget logo,
      required VoidCallback? onPressed,
    }) {
      return FilledButton(
        key: key,
        onPressed: onPressed,
        style: solidAuthStyle,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            logo,
            const SizedBox(width: authIconGap),
            Flexible(child: Text(label, textAlign: TextAlign.center)),
          ],
        ),
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        providerButton(
          key: const Key('signInUnstoppable'),
          label: 'Continue with Unstoppable',
          logo: SvgPicture.asset(
            'assets/logos/unstoppable-domains.svg',
            height: authIconSize,
          ),
          onPressed: !enabled
              ? null
              : () => onSocial(SocialProvider.unstoppable),
        ),
        const SizedBox(height: 12),
        // Google's 4-color "G" stays full-color per Google's sign-in branding
        // guidelines (a recolored monochrome mark is not permitted).
        providerButton(
          label: 'Continue with Google',
          logo: SvgPicture.asset(
            'assets/logos/google.svg',
            height: authIconSize,
          ),
          onPressed: !enabled ? null : () => onSocial(SocialProvider.google),
        ),
        const SizedBox(height: 12),
        // GitHub's mark is monochrome; tint it to the button's label color so it
        // reads white on light backgrounds and dark on dark ones.
        providerButton(
          label: 'Continue with GitHub',
          logo: SvgPicture.asset(
            'assets/logos/github.svg',
            height: authIconSize,
            colorFilter: ColorFilter.mode(authLabel, BlendMode.srcIn),
          ),
          onPressed: !enabled ? null : () => onSocial(SocialProvider.github),
        ),
        // Sign in with Apple is iOS-only (native authorization sheet). It goes
        // through the same providerButton as Google/GitHub, drawing Apple's own
        // logo (AppleLogoPainter) tinted to the label color. A custom Sign in
        // with Apple button is permitted by Apple's HIG as long as it uses the
        // Apple logo, approved wording, and adequate size/prominence — all met
        // here (official mark, "Sign in with Apple", 48pt, equal weight).
        if (defaultTargetPlatform == TargetPlatform.iOS) ...[
          const SizedBox(height: 12),
          providerButton(
            key: const Key('signInApple'),
            label: 'Sign in with Apple',
            logo: SizedBox(
              width: authIconSize * (25 / 31), // Apple logo aspect ratio
              height: authIconSize,
              child: CustomPaint(painter: AppleLogoPainter(color: authLabel)),
            ),
            onPressed: enabled ? onApple : null,
          ),
        ],
      ],
    );
  }
}
