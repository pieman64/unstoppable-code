import 'package:flutter/material.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

class QueuedMessagesStatus extends StatelessWidget {
  const QueuedMessagesStatus({super.key, required this.count});

  final int count;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final label = '$count ${count == 1 ? 'message' : 'messages'} queued';
    return Semantics(
      key: const ValueKey('chat-queue-status'),
      liveRegion: true,
      label: label,
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Align(
          alignment: Alignment.centerRight,
          child: Text(
            label,
            style: AppTypography.bodySmall.copyWith(
              color: colors.foregroundMuted,
            ),
          ),
        ),
      ),
    );
  }
}
