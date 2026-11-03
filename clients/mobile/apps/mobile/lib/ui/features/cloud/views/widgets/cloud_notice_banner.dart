import 'package:flutter/material.dart';

/// Pinned notice above the transcript for a failure the server explained:
/// a definitive send rejection (402 credits, 403 model policy) or a failed
/// bootstrap. Shows recovery copy, a Retry that is disabled while [onRetry] is
/// null, and an optional Dismiss action when hiding the notice is safe.
class CloudNoticeBanner extends StatelessWidget {
  const CloudNoticeBanner({
    super.key,
    required this.message,
    this.onDismiss,
    this.onRetry,
    this.retryKey,
  });

  final String message;
  final VoidCallback? onDismiss;
  final VoidCallback? onRetry;
  final Key? retryKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return MaterialBanner(
      content: Text(message),
      backgroundColor: theme.colorScheme.errorContainer,
      actions: [
        TextButton(
          key: retryKey,
          onPressed: onRetry,
          child: const Text('Retry'),
        ),
        if (onDismiss case final onDismiss?)
          TextButton(onPressed: onDismiss, child: const Text('Dismiss')),
      ],
    );
  }
}
