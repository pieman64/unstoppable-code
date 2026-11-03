import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/spinner/dot_spinner.dart';
import 'package:mobile/data/models/cloud_chat.dart';
import 'package:mobile/ui/core/widgets/state_message_view.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chat_view_model.dart';
import 'package:mobile/ui/features/cloud/view_models/cloud_chats_view_model.dart';
import 'package:mobile/ui/features/cloud/views/cloud_chat_screen.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_chat_actions_row.dart';
import 'package:mobile/ui/features/cloud/views/widgets/cloud_workspace_section.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';
import 'package:provider/provider.dart';

/// The interim Cloud tab root (CAN-3143): a Projects section listing each
/// cloud workspace with its chats indented beneath it. New chat in the app
/// bar, or the plus on a project, opens a draft ([CloudChatScreen.create])
/// that creates the chat on its first send. Reads [CloudChatsViewModel] for
/// the list and [CloudChatViewModel] for the one chat this device knows is
/// live.
class CloudChatsScreen extends StatefulWidget {
  const CloudChatsScreen({super.key});

  @override
  State<CloudChatsScreen> createState() => _CloudChatsScreenState();
}

class _CloudChatsScreenState extends State<CloudChatsScreen> {
  @override
  void initState() {
    super.initState();
    // Post-frame: load notifies synchronously, which the first build forbids.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final list = context.read<CloudChatsViewModel>();
      unawaited(list.load());
      unawaited(list.ensureModels());
    });
  }

  void _openChat(CloudChatSummary chat) {
    if (!_canOpenChat(chat.externalId)) return;
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => CloudChatScreen(chatId: chat.externalId),
        ),
      ),
    );
  }

  bool _canOpenChat(String? chatId) => canSwitchCloudChat(context, chatId);

  /// Opens a new chat draft, preselecting [workspaceId] or else the first
  /// project. Nothing is created until the draft's first send.
  void _newChat({String? workspaceId}) {
    if (!_canOpenChat(null)) return;
    unawaited(
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              CloudChatScreen.create(initialWorkspaceId: workspaceId),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final list = context.watch<CloudChatsViewModel>();
    final session = context.watch<CloudChatViewModel>();
    final workingChatId = session.turnInProgress ? session.state?.chatId : null;
    final workingParentId = workingChatId == null
        ? null
        : list.chatById(workingChatId)?.taskChatExternalId;
    final navigation = HomeNavigationScope.maybeOf(context);
    return CanopyScaffold(
      appBar: CanopyAppBar(
        leading: navigation == null
            ? null
            : const HomeMenuButton(designSystem: true),
        content: const Text('Cloud chats'),
        trailing: list.workspaces.isEmpty || list.cloudAvailable == false
            ? null
            : CanopyIconButton(
                key: const ValueKey('cloud-new-chat'),
                glyph: CanopyGlyph.bubblePlus,
                tooltip: 'New chat',
                onPressed: _newChat,
              ),
      ),
      body: Builder(
        builder: (context) {
          final padding = CanopyScaffold.contentPaddingOf(context);
          final Widget? state = _stateFor(list);
          return RefreshIndicator(
            edgeOffset: padding.top,
            onRefresh: list.refresh,
            child: state != null
                ? Padding(padding: padding, child: state)
                : ListView(
                    key: const ValueKey('cloud-chats-list'),
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: padding + const EdgeInsets.only(bottom: 32),
                    children: [
                      const CloudProjectsSectionLabel(),
                      for (final workspace in list.workspaces) ...[
                        CloudWorkspaceHeader(
                          workspace: workspace,
                          onNewChat: () =>
                              _newChat(workspaceId: workspace.externalId),
                        ),
                        if (workspace.chats.isEmpty)
                          const _NoChatsYet()
                        else
                          for (final chat in workspace.chats)
                            CloudChatActionsRow(
                              key: ValueKey(
                                'cloud-chat-actions-${chat.externalId}',
                              ),
                              chat: chat,
                              working:
                                  workingChatId != null &&
                                  (chat.externalId == workingChatId ||
                                      chat.externalId == workingParentId),
                              deletionRetentionDays:
                                  workspace.deletionRetentionDays,
                              leadingInset: cloudProjectContentInset,
                              onTap: () => _openChat(chat),
                            ),
                      ],
                    ],
                  ),
          );
        },
      ),
    );
  }

  /// A whole-body state, or null when the workspace list should render.
  Widget? _stateFor(CloudChatsViewModel list) {
    if (list.cloudAvailable == false) {
      return const StateMessageView(
        key: ValueKey('cloud-unavailable'),
        glyph: CanopyGlyph.cloud,
        title: 'Cloud chats are unavailable',
        message: 'Cloud agents are not enabled for this account yet.',
      );
    }
    if (list.workspaces.isNotEmpty) return null;
    final error = list.error;
    if (error != null) {
      return StateMessageView(
        key: const ValueKey('cloud-chats-error'),
        glyph: CanopyGlyph.exclamationTriangle,
        title: "Couldn't load cloud chats",
        message: error,
        onRetry: list.refresh,
      );
    }
    if (list.isLoading ||
        list.isFirstProjectDecisionPending ||
        list.isProvisioningFirstProject ||
        list.cloudAvailable == null) {
      return const Center(child: LoadingSpinner(size: 22));
    }
    return const StateMessageView(
      key: ValueKey('cloud-chats-empty'),
      glyph: CanopyGlyph.cloud,
      title: 'No cloud chats yet',
      message: 'Create a project on the web to start chatting here.',
    );
  }
}

/// Whether another cloud chat ([chatId], or a new draft when null) may take
/// the shared session now. While the bound chat still has queued sends the
/// switch is refused with a notice, so the queue is never abandoned.
bool canSwitchCloudChat(BuildContext context, String? chatId) {
  final state = context.read<CloudChatViewModel>().state;
  if (state == null || state.chatId == chatId || state.outbox.isEmpty) {
    return true;
  }
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(
      const SnackBar(
        content: Text(
          'Wait for the queued message to send before opening another chat.',
        ),
      ),
    );
  return false;
}

class _NoChatsYet extends StatelessWidget {
  const _NoChatsYet();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(cloudProjectContentInset, 8, 16, 8),
      child: Text(
        'No chats yet',
        style: theme.textTheme.bodySmall?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
