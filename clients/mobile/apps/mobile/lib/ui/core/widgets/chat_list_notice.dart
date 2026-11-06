import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';

/// Inline inventory feedback shared by native chat search and Recents. It
/// leaves cached rows and the surrounding navigation available during retry.
class ChatListNotice extends StatelessWidget {
  const ChatListNotice({required this.message, this.onRetry, super.key});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(message, style: Theme.of(context).textTheme.bodyMedium),
        ),
        if (onRetry != null)
          CanopyButton(
            label: 'Try again',
            semanticsLabel: 'Try again to load chats',
            variant: CanopyButtonVariant.inline,
            onPressed: onRetry,
          ),
      ],
    ),
  );
}
