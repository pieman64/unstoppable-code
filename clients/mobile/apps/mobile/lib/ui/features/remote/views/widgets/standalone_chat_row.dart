import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/ui/core/chat/widgets/chat_overview_row.dart';
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

    final tile = ChatOverviewRow(
      title: chat.displayTitle,
      unread: chat.hasUnread == true,
      working: chat.hasActiveChat == true,
      archived: chat.archived == true,
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
