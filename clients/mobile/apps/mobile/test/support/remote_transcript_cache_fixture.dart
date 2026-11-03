/// Synthetic Remote Control chats for the CAN-3373 device, capture, and
/// profile harnesses: a paired session whose server-cached tail and desktop
/// transcript answer only when the harness releases them, plus the chat
/// screen host. No pairing, desktop, or network.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

/// The synthetic account every harness signs in as.
const String kCan3373AccountScope = 'synthetic:can-3373';
const String kCan3373SessionId = 'synthetic-session-can-3373';

const kCan3373Worktree = RemoteWorktree(
  localId: 'wt-cache',
  workspaceLocalId: 'ws-cache',
  branch: 'feat/cached-reopen',
);

const kCan3373StandaloneChat = RemoteStandaloneChat(
  localId: 'chat-standalone',
  projectLocalId: 'ws-cache',
  title: 'Standalone chat',
);

/// A worktree chat and a standalone chat, the two identities a tail is
/// persisted under.
enum Can3373Chat {
  worktree('chat-worktree', RemoteChatScope.worktree),
  standalone('chat-standalone', RemoteChatScope.standalone);

  const Can3373Chat(this.chatId, this.scope);

  final String chatId;
  final RemoteChatScope scope;

  RemoteChatTarget get target => switch (this) {
    worktree => RemoteWorktreeChatTarget(
      workspaceLocalId: kCan3373Worktree.workspaceLocalId,
      worktreeLocalId: kCan3373Worktree.localId,
      chatId: chatId,
    ),
    standalone => RemoteStandaloneChatTarget(
      chatId: chatId,
      projectLocalId: kCan3373StandaloneChat.projectLocalId,
    ),
  };

  Widget get screen => switch (this) {
    worktree => RemoteChatScreen.worktree(
      worktree: kCan3373Worktree,
      initialChatId: chatId,
    ),
    standalone => const RemoteChatScreen.standalone(
      standaloneChat: kCan3373StandaloneChat,
    ),
  };
}

final DateTime _epoch = DateTime.utc(2026, 10, 4, 9);

/// Message [index] of [chat]: alternating prompts and answers, one second
/// apart.
RemoteChatMessage can3373Row(Can3373Chat chat, int index, {String? text}) =>
    RemoteChatMessage(
      messageId: '${chat.chatId}-m$index',
      chatId: chat.chatId,
      scope: chat.scope,
      role: index.isEven ? ChatRole.user : ChatRole.assistant,
      status: ChatMessageStatus.complete,
      text:
          text ??
          (index.isEven
              ? 'Synthetic question $index about the cached reopen'
              : 'Synthetic answer $index: the persisted tail painted first'),
      occurredAt: _epoch.add(Duration(seconds: index)),
    );

/// Messages [from] (inclusive) to [to] (exclusive) of [chat].
List<RemoteChatMessage> can3373Rows(Can3373Chat chat, int from, int to) => [
  for (var i = from; i < to; i++) can3373Row(chat, i),
];

/// A paired session whose transcript sources answer only when released.
final class Can3373Repository extends FakeRemoteControlRepository {
  Can3373Repository() {
    connectedSessionId = kCan3373SessionId;
    snapshotBuilder = () => const RemoteSessionSnapshot(
      workspaces: [
        RemoteWorkspace(
          localId: 'ws-cache',
          name: 'Synthetic workspace',
          type: RemoteWorkspaceType.singleRepo,
        ),
      ],
      worktrees: [kCan3373Worktree],
      standaloneChats: [kCan3373StandaloneChat],
      chatSummaries: [
        RemoteChatSummary(
          chatId: 'chat-worktree',
          scope: RemoteChatScope.worktree,
          title: 'Worktree chat',
          workspaceLocalId: 'ws-cache',
          worktreeLocalId: 'wt-cache',
          active: true,
        ),
      ],
    );
  }

  /// Delay before each released source answers, the same with and without
  /// a persisted tail so timings stay comparable.
  Duration latency = Duration.zero;

  final Map<String, Completer<List<RemoteChatMessage>>> _serverTails = {};

  Completer<List<RemoteChatMessage>> _serverTail(String chatId) =>
      _serverTails.putIfAbsent(chatId, Completer.new);

  @override
  Future<List<RemoteChatMessage>> fetchCachedChatMessages(
    RemoteChatTarget target,
  ) async {
    cachedChatFetches += 1;
    final rows = await _serverTail(target.chatId ?? '').future;
    if (latency > Duration.zero) await Future<void>.delayed(latency);
    return rows;
  }

  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    requestChatTranscriptCalls += 1;
    return 'transcript-${target.chatId}';
  }

  /// Answers [chat]'s server-cached tail read with [rows].
  void releaseServerTail(Can3373Chat chat, List<RemoteChatMessage> rows) {
    final tail = _serverTail(chat.chatId);
    if (!tail.isCompleted) tail.complete(rows);
  }

  /// Delivers the desktop's transcript snapshot of [chat].
  void deliverSnapshot(
    Can3373Chat chat,
    List<RemoteChatMessage> rows, {
    required int cursor,
    bool truncated = false,
  }) => eventsController.add(
    RemotePortalEventBatch(
      nextCursor: cursor,
      events: [
        RemoteStateSnapshotEvent(
          scope: 'chat',
          targetChatId: chat.chatId,
          targetChatScope: chat.scope,
          chatMessages: rows,
          chatMessagesTruncated: truncated,
        ),
      ],
    ),
  );

  /// Delivers one live revision of a row in [chat].
  void deliverLive(Can3373Chat chat, RemoteChatMessage row, int cursor) =>
      eventsController.add(
        RemotePortalEventBatch(
          nextCursor: cursor,
          events: [
            RemoteChatMessageEvent(
              chatId: chat.chatId,
              scope: chat.scope,
              message: row,
            ),
          ],
        ),
      );
}

/// The chat screen for [chat] over [viewModel], at the app's themes.
Widget can3373ChatHost(
  RemoteControlViewModel viewModel,
  Can3373Chat chat, {
  ThemeMode themeMode = ThemeMode.light,
}) => MultiProvider(
  providers: [
    ChangeNotifierProvider<RemoteControlViewModel>.value(value: viewModel),
    ChangeNotifierProvider<TurnFeedbackController>(
      create: (_) =>
          TurnFeedbackController(repository: MockTurnFeedbackRepository()),
    ),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    themeMode: themeMode,
    home: chat.screen,
  ),
);
