import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/core/format.dart';

/// Fallback title for a cloud chat the server has not titled yet, matching
/// the web sidebar's placeholder.
String cloudChatDisplayTitle(CloudChatSummary chat) {
  final title = chat.title?.trim();
  return title == null || title.isEmpty ? 'New chat' : title;
}

/// One cloud chat in the workspace list: title, when it was created, and a
/// working spinner while this device knows the chat has a live turn.
class CloudChatRow extends StatelessWidget {
  const CloudChatRow({
    super.key,
    required this.chat,
    required this.working,
    this.onTap,
    this.leadingInset = 16,
  });

  final CloudChatSummary chat;

  /// Left edge of the title; project chats indent to the project name.
  final double leadingInset;

  /// True when the selected session for this chat has a turn in progress.
  /// The workspaces payload carries no liveness, so only the chat this device
  /// is bound to can show it.
  final bool working;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final created = DateTime.fromMillisecondsSinceEpoch(chat.createdAtMs);
    return ListTile(
      key: ValueKey('cloud-chat-row-${chat.externalId}'),
      contentPadding: EdgeInsets.only(left: leadingInset, right: 16),
      visualDensity: VisualDensity.compact,
      minTileHeight: 56,
      title: Text(
        cloudChatDisplayTitle(chat),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium,
      ),
      subtitle: Text(
        'Created ${formatRelativeDate(created)}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing: working
          ? Tooltip(
              message: 'Working',
              child: ThinkingSpinner(
                key: ValueKey('cloud-chat-working-${chat.externalId}'),
                size: 12,
              ),
            )
          : null,
      onTap: onTap,
    );
  }
}
