import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';

class ChatTranscriptLoading extends StatelessWidget {
  const ChatTranscriptLoading({super.key, required this.label, this.labelKey});

  final String label;

  /// Automation hook for the label, when a caller needs to find this state.
  final Key? labelKey;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const LoadingSpinner(size: 20),
          const SizedBox(height: 12),
          Text(
            label,
            key: labelKey,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class ChatCreationFailed extends StatelessWidget {
  const ChatCreationFailed({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CanopyIcon(
              glyph: CanopyGlyph.warningSign,
              tint: theme.colorScheme.error,
              size: 32,
            ),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            if (onRetry != null)
              FilledButton.tonal(
                key: const ValueKey('retry-worktree-create'),
                onPressed: onRetry,
                child: const Text('Retry'),
              ),
          ],
        ),
      ),
    );
  }
}

class ChatEmptyTranscript extends StatelessWidget {
  const ChatEmptyTranscript({
    super.key,
    required this.isNewChat,
    this.composingNew = false,
  });

  final bool isNewChat;

  /// True when the user explicitly started a new conversation from the
  /// new-chat chip (as opposed to a worktree that has no chats at all).
  final bool composingNew;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          composingNew
              ? 'New conversation — send a message to start it.'
              : isNewChat
              ? 'No chats yet — send a message to start one.'
              : 'No messages yet.',
          textAlign: TextAlign.center,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}
