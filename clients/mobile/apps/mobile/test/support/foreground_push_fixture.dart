// CAN-3642 — synthetic fixture for foreground push behavior: a paired
// desktop with one existing worktree chat, a new chat whose worktree setup
// never finishes, and push payloads for every category the server sends.
// Shared by the widget regression test and the device flows.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_connection.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/services/push_messaging.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

const can3642Workspace = RemoteWorkspace(
  localId: 'ws-1',
  order: 0,
  name: 'canopy',
  type: RemoteWorkspaceType.singleRepo,
);

const can3642Worktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'feature/chat-links',
);

const can3642ChatId = 'chat-1';

/// Draft typed into the composer before pushes arrive.
const can3642Draft = 'Keep this draft while pushes arrive';

/// Foreground pushes covering each server category, another chat, the chat
/// on screen, a pipeline checkpoint, and a payload with no target. Like the
/// server, `worktreeId` carries a server id that never matches a local one.
const can3642Pushes = <PushMessage>[
  PushMessage(
    title: 'canopy — Pipeline needs input',
    body: 'Synthetic pipeline run',
    data: {
      'type': 'needs_input',
      'worktreeId': 'server-worktree-uuid-1',
      'clientChatId': 'pipeline:synthetic-execution',
    },
  ),
  PushMessage(
    title: 'canopy — Agent run completed',
    body: 'Synthetic other chat',
    data: {
      'type': 'run_completed',
      'worktreeId': 'server-worktree-uuid-2',
      'clientChatId': 'chat-other',
    },
  ),
  PushMessage(
    title: 'canopy — Usage limit hit',
    body: 'Synthetic blocked chat',
    data: {
      'type': 'blocked',
      'worktreeId': 'server-worktree-uuid-1',
      'clientChatId': 'chat-1',
    },
  ),
  PushMessage(
    title: 'canopy — Agent run failed',
    body: 'Synthetic failed chat',
    data: {
      'type': 'run_failed',
      'worktreeId': 'server-worktree-uuid-2',
      'clientChatId': 'chat-other',
    },
  ),
  PushMessage(title: 'canopy — Update'),
];

/// Matches anything a foreground push could render in the app: the former
/// SnackBar banner, its View action, or the push copy in any other surface.
Finder can3642NotificationSurface() => find.byWidgetPredicate((widget) {
  if (widget is SnackBarAction) return widget.label == 'View';
  if (widget is Text) {
    final text = widget.data ?? widget.textSpan?.toPlainText() ?? '';
    return can3642Pushes.any((push) => text.contains(push.title!));
  }
  return false;
});

final class Can3642Repository extends FakeRemoteControlRepository {
  Can3642Repository() {
    snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [can3642Workspace],
      worktrees: [can3642Worktree],
      standaloneChats: [],
      chatSummaries: [
        RemoteChatSummary(
          chatId: can3642ChatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Chat link projection',
          active: true,
        ),
      ],
      chatMessages: [
        RemoteChatMessage(
          messageId: 'message-1',
          chatId: can3642ChatId,
          role: ChatRole.assistant,
          status: ChatMessageStatus.complete,
          text: 'Synthetic transcript for CAN-3642.',
        ),
      ],
    );
    // Worktree setup for a new chat stays in progress for the whole flow.
    createWorktreeHandler = () => _pendingCreate.future;
  }

  final Completer<RemoteWorktreeCreateResult> _pendingCreate =
      Completer<RemoteWorktreeCreateResult>();

  @override
  Future<RemoteConnection?> restoreSession() async =>
      RemoteConnection(deviceLabel: 'Test Desktop', pairedAt: DateTime(2026));
}

/// Pushes [screen] on the root navigator above [context], the way the app's
/// own push sites (workspace list, search, notification taps) open chats.
Future<void> can3642OpenChat(
  BuildContext context,
  RemoteControlViewModel viewModel,
  RemoteChatScreen screen,
) {
  return Navigator.of(context, rootNavigator: true).push(
    MaterialPageRoute<void>(
      builder: (_) => ChangeNotifierProvider<RemoteControlViewModel>.value(
        value: viewModel,
        child: screen,
      ),
    ),
  );
}
