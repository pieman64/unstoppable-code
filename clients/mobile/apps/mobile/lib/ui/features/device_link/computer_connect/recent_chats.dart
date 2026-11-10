import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/device_link/chats/models.dart';
import 'package:mobile/device_link/chats/recents.dart';
import 'package:mobile/ui/core/navigation/home_recent_chats.dart';
import '../chats_screen.dart';
import 'account.dart';

/// The drawer's Recents across every connected computer, newest first. Rows
/// follow the phone's selected context, whatever context each computer has
/// selected.
final class ComputerRecentChats implements HomeRecentChatsSource {
  ComputerRecentChats(this.account);
  final ComputerConnectAccount account;
  bool _opening = false;

  @override
  void addListener(VoidCallback listener) => account.addListener(listener);
  @override
  void removeListener(VoidCallback listener) =>
      account.removeListener(listener);

  @override
  Future<void> refresh() async {
    await Future.wait([
      for (final computer in account.connectedComputers)
        if (account.engine.sessions[computer.id] case final controller?)
          // Also update ownership evidence so newly listed worktrees can open.
          // refresh() reads inventory without changing the active chat scopes.
          controller.refresh(),
    ]);
  }

  @override
  HomeRecentChatsSnapshot read(WorkspaceContext context) {
    final computers = [
      for (final computer in account.connectedComputers)
        if (account.engine.sessions[computer.id] case final controller?)
          (id: computer.id, name: computer.name, controller: controller),
    ];
    return (
      chats: buildComputerRecentChats([
        for (final computer in computers)
          [
            for (final chat in computer.controller.recents.chats(context))
              _row(computer.id, computer.name, chat),
          ],
      ]),
      loading: computers.any(
        (computer) =>
            !computer.controller.recents.hasInventory &&
            (computer.controller.loading || computer.controller.scopePending),
      ),
      connected: computers.isNotEmpty,
    );
  }

  HomeRecentChat _row(
    String computerId,
    String computerName,
    DeviceRecentChat chat,
  ) => HomeRecentChat(
    key: 'computer-$computerId-${chat.ref.key}',
    title: chat.ref.title,
    computerName: computerName,
    activityAt: chat.activityAt,
    attention: switch (chat.attention) {
      DeviceRecentAttention.none => RecentChatAttention.none,
      DeviceRecentAttention.unread => RecentChatAttention.unread,
      DeviceRecentAttention.awaitingAnswer =>
        RecentChatAttention.awaitingAnswer,
    },
    open: (context, showChat) =>
        _open(context, computerId, chat.ref, chat.worktreeName, showChat),
  );

  /// Switches to the chat's computer, so its overview and Home follow, then
  /// lets the shell host the chat with its navigation menu.
  Future<void> _open(
    BuildContext context,
    String computerId,
    DeviceChatRef ref,
    String? worktreeName,
    Future<void> Function(Widget page) showChat,
  ) async {
    final controller = account.engine.sessions[computerId];
    if (_opening || controller == null || !controller.chats.online) return;
    final workspaceContext = context.read<WorkspaceContext?>();
    _opening = true;
    try {
      await account.select(computerId);
      // The context can change, or the shell be replaced, while the
      // selection is saved. Open only what the current context still shows.
      if (!context.mounted ||
          context.read<WorkspaceContext?>() != workspaceContext ||
          !controller.scopeFor(workspaceContext).includesChat(ref)) {
        return;
      }
      controller.enterChat();
      final opening = controller.chats.open(ref);
      var generation = controller.chats.chats.selectionGeneration;
      try {
        await showChat(
          DeviceChatScreen(
            model: controller.chats,
            locationLabel: worktreeName,
            worktree: controller.activityContext(ref),
          ),
        );
        // The page owned the selection, including tab switches and reconnects
        // inside it. Read it as the shell leaves the page:
        // a chat opened after that, while this open finishes, keeps its own.
        generation = controller.chats.chats.selectionGeneration;
        await opening;
      } finally {
        await controller.restoreOverview(generation);
      }
    } finally {
      _opening = false;
    }
  }
}

/// Interleaves each computer's rows by activity, newest first, then caps them
/// at [limit]. Rows without a timestamp sort last, keeping their source order.
List<HomeRecentChat> buildComputerRecentChats(
  List<List<HomeRecentChat>> computers, {
  int limit = recentChatsLimit,
}) {
  final indexed = [for (final rows in computers) ...rows].indexed.toList()
    ..sort((left, right) {
      final a = left.$2.activityAt, b = right.$2.activityAt;
      if (a == null && b == null) return left.$1.compareTo(right.$1);
      if (a == null) return 1;
      if (b == null) return -1;
      final byActivity = b.compareTo(a);
      return byActivity != 0 ? byActivity : left.$1.compareTo(right.$1);
    });
  return List.unmodifiable([for (final (_, chat) in indexed.take(limit)) chat]);
}
