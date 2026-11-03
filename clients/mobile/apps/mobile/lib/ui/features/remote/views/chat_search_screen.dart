import 'dart:async';

import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:mobile/data/models/remote_context_scope.dart';
import 'package:mobile/data/models/workspace_context.dart';
import 'package:mobile/ui/core/workspace_context_label.dart';
import 'package:mobile/ui/core/widgets/chat_list_notice.dart';
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
  final TextEditingController _query = TextEditingController();

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

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
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
    final theme = Theme.of(context);
    final queryActive = _query.text.trim().isNotEmpty;

    return CanopyScaffold(
      appBar: CanopyAppBar(
        automaticallyImplyLeading: true,
        content: TextField(
          key: const ValueKey('chat-search-field'),
          controller: _query,
          autofocus: true,
          textInputAction: TextInputAction.search,
          decoration: const InputDecoration(
            hintText: 'Search chats',
            border: InputBorder.none,
          ),
          onChanged: (_) => setState(() {}),
        ),
        trailing: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            if (queryActive)
              CanopyIconButton(
                glyph: CanopyGlyph.crossMedium,
                tooltip: 'Clear',
                onPressed: () => setState(_query.clear),
              ),
          ],
        ),
      ),
      body: Builder(
        builder: (context) {
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
          final results = filterRemoteChatSearchResults(
            _candidatesFor(viewModel, workspaceContext),
            _query.text,
          );
          final error = viewModel.chatSummariesError;
          final loading = viewModel.isChatSummariesLoading;
          final notice = error != null
              ? ChatListNotice(
                  message: error,
                  onRetry: viewModel.retryChatSummariesIndex,
                )
              : loading
              ? const ChatListNotice(
                  message: 'Loading chats from your desktop…',
                )
              : null;
          final insets = CanopyScaffold.contentPaddingOf(context);
          final body = results.isEmpty && (error != null || loading)
              ? const SizedBox.shrink()
              : !queryActive
              ? _CenteredHint(
                  text: 'Search every chat by title.',
                  style: theme.textTheme.bodyMedium,
                )
              : results.isEmpty
              ? _CenteredHint(
                  text: 'No chats match your search in $label.',
                  style: theme.textTheme.bodyMedium,
                )
              : ListView.builder(
                  padding: insets.copyWith(
                    top: notice == null ? insets.top : 0,
                  ),
                  itemCount: results.length,
                  itemBuilder: (context, index) {
                    final result = results[index];
                    final subtitle = switch (result) {
                      RemoteWorktreeChatSearchResult(
                        :final workspaceName,
                        :final worktreeName,
                      ) =>
                        '$workspaceName · $worktreeName',
                      RemoteStandaloneChatSearchResult(:final workspaceName) =>
                        workspaceName,
                    };
                    return ListTile(
                      key: ValueKey('chat-search-result-${result.chatId}'),
                      leading: Icon(
                        result is RemoteWorktreeChatSearchResult
                            ? Icons.account_tree_outlined
                            : Icons.chat_bubble_outline,
                      ),
                      title: Text(
                        result.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        subtitle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: () => _open(context, result),
                    );
                  },
                );
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (notice != null)
                Padding(
                  padding: EdgeInsets.only(top: insets.top),
                  child: notice,
                ),
              Expanded(child: body),
            ],
          );
        },
      ),
    );
  }
}

class _CenteredHint extends StatelessWidget {
  const _CenteredHint({required this.text, this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding:
          CanopyScaffold.contentPaddingOf(context) + const EdgeInsets.all(24),
      child: Text(text, textAlign: TextAlign.center, style: style),
    ),
  );
}
