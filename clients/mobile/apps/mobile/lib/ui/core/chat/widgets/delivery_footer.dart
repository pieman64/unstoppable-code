import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';

/// Delivery state and recovery actions for a local message awaiting the host.
class DeliveryFooter extends StatelessWidget {
  const DeliveryFooter({
    super.key,
    required this.messageId,
    required this.delivery,
    required this.note,
    required this.onResend,
    required this.onDiscard,
  });

  final String messageId;
  final ChatDelivery delivery;
  final String? note;
  final ValueChanged<String>? onResend;
  final ValueChanged<String>? onDiscard;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final status = StatusColors.of(context);
    final label = switch (delivery) {
      ChatDelivery.notSent => 'Not sent',
      ChatDelivery.uncertain => 'Delivery uncertain',
    };
    final labelColor = switch (delivery) {
      ChatDelivery.notSent => status.failed,
      ChatDelivery.uncertain => colors.foregroundSecondary,
    };
    final reason = note;
    ButtonStyle style(Color color) => TextButton.styleFrom(
      foregroundColor: color,
      minimumSize: const Size(48, 48),
      padding: const EdgeInsets.symmetric(horizontal: 8),
      textStyle: AppTypography.compactLabel,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: AppTypography.bodySmall.copyWith(color: labelColor)),
        if (reason != null && reason.isNotEmpty)
          Text(
            reason,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.bodySmall.copyWith(
              color: colors.foregroundSecondary,
            ),
          ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (onResend case final resend?)
              TextButton(
                key: ValueKey('message-resend-$messageId'),
                style: style(colors.accent),
                onPressed: () => resend(messageId),
                child: const Text('Resend'),
              ),
            if (onDiscard case final discard?)
              TextButton(
                key: ValueKey('message-discard-$messageId'),
                style: style(colors.foregroundSecondary),
                onPressed: () => discard(messageId),
                child: const Text('Discard'),
              ),
          ],
        ),
      ],
    );
  }
}
