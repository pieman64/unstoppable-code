import 'package:mobile/ui/core/chat/widgets/chat_search_view.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';
import 'package:mobile/ui/features/remote/view_models/remote_chat_search.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_route.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';

/// Full-screen chat search over every chat the paired desktop projects —
/// worktree chat tabs and standalone/cowork chats — matching on titles only
/// (web Remote Control sidebar search parity, CAN-1990). Only the selected
/// workspace context's chats are searched (CAN-4429).
class ChatSearchScreen extends StatefulWidget {
  const ChatSearchScreen({super.key});

  @override
  State<ChatSearchScreen> createState() => _ChatSearchScreenState();
}

class _ChatSearchScreenState extends State<ChatSearchScreen> {
  @override
  void initState() {
    super.initState();
    // Post-frame: the batched summaries request may notify listeners
    // synchronously, which is not allowed during the first build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.read<RemoteControlViewModel>().ensureChatSummariesIndex();
    });
  }

  void _open(BuildContext context, RemoteChatSearchResult result) {
    final viewModel = context.read<RemoteControlViewModel>();
    switch (result) {
      case RemoteWorktreeChatSearchResult():
        final worktree = viewModel
            .worktreesFor(result.workspaceLocalId)
            .where((worktree) => worktree.localId == result.worktreeLocalId)
            .firstOrNull;
        if (worktree == null) return;
        unawaited(
          Navigator.of(context).push(
            remoteChatRoute(
              context,
              RemoteChatScreen.worktree(
                worktree: worktree,
                initialChatId: result.chatId,
              ),
            ),
          ),
        );
      case RemoteStandaloneChatSearchResult():
        final chat = viewModel.allStandaloneChats
            .where((chat) => chat.localId == result.chatId)
            .firstOrNull;
        if (chat == null) return;
        unawaited(
          Navigator.of(context).push(
            remoteChatRoute(
              context,
              RemoteChatScreen.standalone(standaloneChat: chat),
            ),
          ),
        );
    }
  }

  /// Candidate flatten cache: rebuilding candidates costs O(workspaces ×
  /// worktrees) plus per-worktree sorts, so it is keyed on the snapshot
  /// identity and the workspace context, and reused across keystrokes — only
  /// the cheap title filter runs per query change. A context switch keeps
  /// the snapshot, so the context is part of the key.
  Object? _candidatesSnapshot;
  WorkspaceContext? _candidatesContext;
  List<RemoteChatSearchResult> _candidates = const [];

  List<RemoteChatSearchResult> _candidatesFor(
    RemoteControlViewModel viewModel,
    WorkspaceContext? workspaceContext,
  ) {
    final snapshot = viewModel.snapshot;
    if (!identical(snapshot, _candidatesSnapshot) ||
        workspaceContext != _candidatesContext) {
      _candidatesSnapshot = snapshot;
      _candidatesContext = workspaceContext;
      final scope = RemoteContextScope(workspaceContext, viewModel.workspaces);
      _candidates = buildRemoteChatSearchCandidates(
        workspaces: scope.workspaces,
        worktrees: scope.worktrees(viewModel.allWorktrees),
        standaloneChats: scope.standaloneChats(viewModel.allStandaloneChats),
        chatSummaries: viewModel.allChatSummaries,
      );
    }
    return _candidates;
  }

  @override
  Widget build(BuildContext context) {
    final viewModel = context.read<RemoteControlViewModel>();
    context.select<RemoteControlViewModel, List<Object?>>(
      (vm) => [
        vm.snapshot?.workspaces,
        vm.snapshot?.worktrees,
        vm.snapshot?.standaloneChats,
        vm.snapshot?.chatSummaries,
        vm.isChatSummariesLoading,
        vm.chatSummariesError,
      ],
    );
    final workspaceContext = context.watch<WorkspaceContext?>();
    final label =
        context.watch<WorkspaceContextLabel?>()?.value ??
        WorkspaceContextLabel.fallback(workspaceContext);
    return ChatSearchView(
      contextLabel: label,
      loading: viewModel.isChatSummariesLoading,
      error: viewModel.chatSummariesError,
      onRetry: viewModel.retryChatSummariesIndex,
      items: [
        for (final result in _candidatesFor(viewModel, workspaceContext))
          ChatSearchItem(
            id: result.chatId,
            title: result.title,
            subtitle: switch (result) {
              RemoteWorktreeChatSearchResult(
                :final workspaceName,
                :final worktreeName,
              ) =>
                '$workspaceName · $worktreeName',
              RemoteStandaloneChatSearchResult(:final workspaceName) =>
                workspaceName,
            },
            worktree: result is RemoteWorktreeChatSearchResult,
            onOpen: () => _open(context, result),
          ),
      ],
    );
  }
}
