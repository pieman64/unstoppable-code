/// Synthetic worktree chat for the CAN-3429 Android flow and captures: two
/// chats with fixed transcripts and model catalogs, optional older history
/// and standalone chats, and tab, composer, send, and PR commands the test
/// answers one by one. No desktop, account, or network.
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_pr.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/services/attachment_picker.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

const chatControllersWorktree = RemoteWorktree(
  localId: 'wt-1',
  workspaceLocalId: 'ws-1',
  branch: 'feature/tabs',
  label: 'Tab controllers',
);

/// The model catalog every synthetic chat projects.
const chatControllersModels = [
  ModelOption(
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    provider: 'codex',
    vendor: 'openai',
    kind: 'model',
    available: true,
    isDefault: true,
  ),
  ModelOption(
    id: 'claude-sonnet',
    label: 'Claude Sonnet 4.5',
    provider: 'claude',
    vendor: 'anthropic',
    kind: 'model',
    available: true,
  ),
];

/// A worktree chat repository whose tab, composer, and send commands wait
/// for the test. [projected] lists the chats the desktop projects.
final class ChatControllersRepository extends FakeRemoteControlRepository {
  ChatControllersRepository() {
    supportsChatAttachments = true;
    supportsPrActions = true;
    prActionRunner =
        (action, {repoId, identity, confirmUnresolvedComments = false}) async {
          if (action == RemotePrAction.refresh) prRefreshes++;
          return const {'repos': [], 'busy': false};
        };
    snapshotBuilder = _snapshot;
  }

  /// Chat ids the desktop projects, in tab order; the first is active.
  final List<String> projected = ['chat-a', 'chat-b'];

  /// Plan mode the desktop projects for every chat.
  bool planMode = false;

  /// Messages listed before the fixed chat-a and chat-b transcripts.
  final List<RemoteChatMessage> history = [];

  /// Standalone chats the desktop projects.
  final List<RemoteStandaloneChat> standaloneChats = [];
  int prRefreshes = 0;
  int _commands = 0;

  final List<Completer<String>> createResponses = [];
  final List<Completer<String>> closeResponses = [];
  final List<Completer<String>> modelResponses = [];
  final List<Completer<String>> planResponses = [];
  final List<Completer<String>> thinkingResponses = [];
  final List<Completer<String>> fastResponses = [];

  /// When set, sends wait for the test.
  Completer<RemoteChatSendResult>? sendResponse;

  String nextCommandId(String kind) => '$kind-${++_commands}';

  @override
  Future<String> createChatTab(RemoteWorktreeChatTarget target) {
    createChatTabTargets.add(target);
    final response = Completer<String>();
    createResponses.add(response);
    return response.future;
  }

  @override
  Future<String> closeChatTab(RemoteWorktreeChatTarget target) {
    closeChatTabTargets.add(target);
    if (closeChatTabError case final error?) return Future.error(error);
    final response = Completer<String>();
    closeResponses.add(response);
    return response.future;
  }

  @override
  Future<String> setChatModel(RemoteChatTarget target, String model) {
    lastSetModelTarget = target;
    lastSetModel = model;
    return _await(modelResponses);
  }

  @override
  Future<String> setChatPlanMode(
    RemoteWorktreeChatTarget target,
    bool planMode,
  ) {
    lastSetPlanMode = planMode;
    return _await(planResponses);
  }

  @override
  Future<String> setChatThinkingLevel(
    RemoteWorktreeChatTarget target,
    String thinkingLevel,
  ) {
    lastSetThinkingLevel = thinkingLevel;
    return _await(thinkingResponses);
  }

  @override
  Future<String> setChatFastMode(
    RemoteWorktreeChatTarget target,
    bool fastMode,
  ) {
    lastSetFastMode = fastMode;
    return _await(fastResponses);
  }

  Future<String> _await(List<Completer<String>> responses) {
    final response = Completer<String>();
    responses.add(response);
    return response.future;
  }

  @override
  Future<RemoteChatSendResult> sendChatMessage(
    RemoteChatTarget target,
    String text, {
    RemoteChatSendOptions? options,
  }) {
    final response = sendResponse;
    if (response == null) {
      return super.sendChatMessage(target, text, options: options);
    }
    sendChatMessageCalls.add((target: target, text: text, options: options));
    return response.future;
  }

  /// Delivers the desktop's rejection of [commandId].
  void fail(String commandId, String message) => eventsController.add(
    RemotePortalEventBatch(
      events: [
        RemoteCommandFailedEvent(commandId: commandId, message: message),
      ],
      nextCursor: ++_commands,
    ),
  );

  /// Delivers the desktop's completion of [commandId].
  void complete(String commandId) => eventsController.add(
    RemotePortalEventBatch(
      events: [RemoteCommandCompletedEvent(commandId: commandId)],
      nextCursor: ++_commands,
    ),
  );

  RemoteSessionSnapshot _snapshot() => RemoteSessionSnapshot(
    workspaces: const [
      RemoteWorkspace(
        localId: 'ws-1',
        order: 0,
        name: 'Canopy',
        type: RemoteWorkspaceType.singleRepo,
      ),
    ],
    worktrees: const [chatControllersWorktree],
    standaloneChats: [...standaloneChats],
    chatSummaries: [
      for (final (index, chatId) in projected.indexed)
        RemoteChatSummary(
          chatId: chatId,
          scope: RemoteChatScope.worktree,
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: switch (chatId) {
            'chat-a' => 'Plan the release',
            'chat-b' => 'Fix flaky test',
            _ => 'Saved chat',
          },
          active: index == 0,
          providerType: 'codex',
          model: 'gpt-5-codex',
          modelLabel: 'GPT-5 Codex',
          planMode: planMode,
          thinkingLevel: 'off',
          fastMode: false,
          providerAvailability: const ProviderAvailability(
            claude: true,
            codex: true,
          ),
          availableModels: chatControllersModels,
          modelCatalogProjected: true,
        ),
    ],
    chatMessages: [
      ...history,
      const RemoteChatMessage(
        messageId: 'a-1',
        chatId: 'chat-a',
        role: ChatRole.user,
        status: ChatMessageStatus.complete,
        text: 'Draft the release checklist.',
      ),
      const RemoteChatMessage(
        messageId: 'a-2',
        chatId: 'chat-a',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'Release checklist: tag, build, smoke test, publish notes.',
      ),
      const RemoteChatMessage(
        messageId: 'b-1',
        chatId: 'chat-b',
        role: ChatRole.assistant,
        status: ChatMessageStatus.complete,
        text: 'The flaky test waits on a real timer.',
      ),
    ],
  );
}

/// The app shell a Remote chat screen needs, with the route observer the
/// screen's visibility depends on.
Widget chatControllersHost(
  RemoteControlViewModel viewModel, {
  required ThemeMode themeMode,
  AttachmentPicker? attachmentPicker,
  GlobalKey<NavigatorState>? navigatorKey,
  RemoteStandaloneChat? standaloneChat,
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
    navigatorKey: navigatorKey,
    navigatorObservers: [appRouteObserver],
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    themeMode: themeMode,
    home: standaloneChat == null
        ? RemoteChatScreen.worktree(
            worktree: chatControllersWorktree,
            attachmentPicker: attachmentPicker,
          )
        : RemoteChatScreen.standalone(standaloneChat: standaloneChat),
  ),
);
