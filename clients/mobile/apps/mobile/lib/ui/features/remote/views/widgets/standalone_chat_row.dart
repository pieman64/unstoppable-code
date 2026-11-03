import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/ui/core/dimens.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/space_notifications_view_model.dart';
import 'package:mobile/ui/features/remote/views/widgets/space_notifications_sheet.dart';
import 'package:provider/provider.dart';

/// A cowork entry row with a single muted title and trailing activity.
/// The representative chat remains the navigation target.
///
/// A long press (or the "Notifications" accessibility action) opens the Work
/// Entry's notification choices when the server enabled them for this
/// session and the desktop has registered the entry's space.
class StandaloneChatRow extends StatelessWidget {
  const StandaloneChatRow({super.key, required this.chat, this.onTap});

  final RemoteStandaloneChat chat;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final statusColors = StatusColors.of(context);
    final notifications = context.read<SpaceNotificationsViewModel?>();
    final notificationsEnabled = context.select<RemoteControlViewModel?, bool>(
      (vm) => vm?.canChooseSpaceNotifications ?? false,
    );
    final spaceId = chat.workEntryNotificationSpaceId;
    final openNotifications =
        notifications == null || spaceId == null || !notificationsEnabled
        ? null
        : () => unawaited(
            showSpaceNotificationsSheet(
              context,
              viewModel: notifications,
              spaceId: spaceId,
              title: chat.displayTitle,
            ),
          );

    final tile = ListTile(
      contentPadding: const EdgeInsets.only(
        left: AppDimens.navRowTitleInset,
        right: 16,
      ),
      visualDensity: VisualDensity.compact,
      minTileHeight: 48,
      title: Text(
        chat.displayTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing:
          chat.hasActiveChat != true &&
              chat.hasUnread != true &&
              chat.archived != true
          ? null
          : Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (chat.hasActiveChat == true) ...[
                  const Tooltip(
                    message: 'Working',
                    child: ThinkingSpinner(
                      key: ValueKey('standalone-chat-working'),
                      size: 12,
                    ),
                  ),
                  if (chat.hasUnread == true || chat.archived == true)
                    const SizedBox(width: 8),
                ],
                if (chat.hasUnread == true)
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
                if (chat.archived == true) ...[
                  if (chat.hasUnread == true) const SizedBox(width: 8),
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
      onLongPress: openNotifications,
    );
    if (openNotifications == null) return tile;
    return Semantics(
      customSemanticsActions: {
        const CustomSemanticsAction(label: 'Notifications'): openNotifications,
      },
      child: tile,
    );
  }
}
