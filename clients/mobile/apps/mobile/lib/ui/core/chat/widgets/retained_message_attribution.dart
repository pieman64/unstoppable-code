import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';

/// Authorship retained on Portal child text parts. Ordinary messages have no
/// such metadata and keep their existing presentation.
class RetainedMessageAttribution extends StatelessWidget {
  const RetainedMessageAttribution({super.key, required this.message});
  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    if (message.watcherFired != null) return const SizedBox.shrink();
    final author = message.parts
        .where((part) => part.kind == 'text')
        .map((part) => part.data)
        .whereType<Map<String, dynamic>>()
        .where(
          (data) =>
              data['delegationAuthorKind'] == 'agent' ||
              data['delegationAuthorKind'] == 'user',
        )
        .firstOrNull;
    final label = switch (author) {
      {
        'delegationAuthorKind': 'agent',
        'delegationAuthorDescription': final String name,
      }
          when name.trim().isNotEmpty =>
        name.trim(),
      {'delegationAuthorKind': 'agent'} => 'Parent agent',
      {'delegationAuthorKind': 'user', 'delegationDelivery': 'steer'} =>
        'You · Steering',
      {'delegationAuthorKind': 'user'} => 'You',
      _ => null,
    };
    if (label == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        label,
        style: AppTypography.compactLabel.copyWith(
          color: AppColors.of(context).foregroundMuted,
        ),
      ),
    );
  }
}
