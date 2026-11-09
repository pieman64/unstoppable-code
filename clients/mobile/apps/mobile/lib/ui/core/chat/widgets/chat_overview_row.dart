import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/core/status_colors.dart';

/// Chat title and desktop-owned activity shared by both computer connections.
class ChatOverviewRow extends StatelessWidget {
  const ChatOverviewRow({
    super.key,
    required this.title,
    this.unread = false,
    this.working = false,
    this.archived = false,
    this.onTap,
    this.onLongPress,
  });
  final String title;
  final bool unread, working, archived;
  final VoidCallback? onTap, onLongPress;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColors = StatusColors.of(context);
    return ListTile(
      contentPadding: const EdgeInsets.only(
        left: AppDimens.navRowTitleInset,
        right: 16,
      ),
      visualDensity: VisualDensity.compact,
      minTileHeight: 48,
      title: Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing: !working && !unread && !archived
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (working) ...[
                  const Tooltip(
                    message: 'Working',
                    child: ThinkingSpinner(
                      key: ValueKey('standalone-chat-working'),
                      size: 12,
                    ),
                  ),
                  if (unread || archived) const SizedBox(width: 8),
                ],
                if (unread)
                  Tooltip(
                    message: 'Unread',
                    child: Container(
                      width: 8,
                      height: 8,
                      decoration: BoxDecoration(
                        color: statusColors.unread,
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                if (archived) ...[
                  if (unread) const SizedBox(width: 8),
                  Text(
                    'Archived',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
      onTap: onTap,
      onLongPress: onLongPress,
    );
  }
}
