import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';

/// Pinned over a chat whose cached transcript shows while its latest load
/// failed. Retry loads it again; Dismiss hides this failure (CAN-4427).
class TranscriptHydrationBanner extends StatelessWidget {
  const TranscriptHydrationBanner({
    super.key,
    required this.message,
    required this.onRetry,
    required this.onDismiss,
  });

  final String message;
  final VoidCallback onRetry;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return MaterialBanner(
      key: const ValueKey('remote-transcript-hydration-failure'),
      content: Text(message),
      backgroundColor: colors.errorContainer,
      actions: [
        TextButton(onPressed: onRetry, child: const Text('Retry')),
        CanopyIconButton(
          key: const ValueKey('remote-transcript-hydration-dismiss'),
          glyph: CanopyGlyph.crossMedium,
          tooltip: 'Dismiss',
          size: CanopyIconButtonSize.small,
          tint: colors.onErrorContainer,
          onPressed: onDismiss,
        ),
      ],
    );
  }
}
