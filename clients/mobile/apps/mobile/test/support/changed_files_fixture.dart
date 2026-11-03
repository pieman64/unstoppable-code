import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/repositories/remote_control_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

// Synthetic data for the CAN-3644 changed-files loading flow and its device
// coverage: two paired worktrees whose desktop projects changed files only
// when the test lands the projection the drawer requested. No account,
// desktop or network.

/// Changed files a first projection of `wt-1` reports.
const changedFilesFirstProjection = <Map<String, dynamic>>[
  {
    'filePath': 'lib/billing/invoice_total.dart',
    'status': 'modified',
    'insertions': 24,
    'deletions': 6,
  },
  {
    'filePath': 'lib/billing/tax_rules.dart',
    'status': 'added',
    'insertions': 58,
  },
  {
    'filePath': 'test/billing/invoice_total_test.dart',
    'status': 'modified',
    'insertions': 31,
    'deletions': 2,
  },
];

/// Changed files a later projection of `wt-1` reports.
const changedFilesSecondProjection = <Map<String, dynamic>>[
  {
    'filePath': 'lib/billing/currency_format.dart',
    'status': 'modified',
    'insertions': 9,
    'deletions': 3,
  },
];

/// A projection of `wt-1` long enough to scroll at phone height.
final changedFilesLongProjection = <Map<String, dynamic>>[
  for (var i = 0; i < 40; i++)
    {
      'filePath': 'lib/billing/rules/rule_${i.toString().padLeft(2, '0')}.dart',
      'status': 'modified',
      'insertions': i + 1,
    },
];

/// Changed files a projection of `wt-2` reports.
const changedFilesOtherWorktree = <Map<String, dynamic>>[
  {'filePath': 'docs/release_notes.md', 'status': 'modified', 'insertions': 4},
];

RemoteWorktree _worktree(String id, String branch) =>
    RemoteWorktree(localId: id, workspaceLocalId: 'ws-1', branch: branch);

RemoteChatSummary _chat(String id, String worktreeLocalId, String title) =>
    RemoteChatSummary(
      chatId: id,
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: worktreeLocalId,
      title: title,
      active: true,
    );

final _snapshot = RemoteSessionSnapshot(
  workspaces: const [],
  worktrees: [
    _worktree('wt-1', 'feature/invoice-totals'),
    _worktree('wt-2', 'docs/release-notes'),
  ],
  standaloneChats: const [],
  chatSummaries: [
    _chat('chat-1', 'wt-1', 'Invoice totals'),
    _chat('chat-2', 'wt-2', 'Release notes'),
  ],
  chatMessages: const [],
);

Map<String, dynamic> changedFilesSlices(
  String worktreeLocalId,
  List<Map<String, dynamic>> files,
) => {
  'changedFiles': {
    worktreeLocalId: {
      'worktreeLocalId': worktreeLocalId,
      'uncommitted': files,
      'committed': const <Map<String, dynamic>>[],
    },
  },
};

/// A current host: chats open through foreground hydration, and the desktop
/// answers a worktree projection request only when [landProjection] runs.
/// Until then the server cache holds what [cacheFiles] last stored.
final class ChangedFilesFixtureRepository extends FakeRemoteControlRepository {
  ChangedFilesFixtureRepository() {
    supportsForegroundChat = true;
    snapshotBuilder = () => _snapshot;
  }

  int _cursor = 100;

  /// When set, the next projection request fails with it.
  Object? projectionError;

  /// Stores [files] in the server cache without a desktop projection.
  void cacheFiles(String worktreeLocalId, List<Map<String, dynamic>> files) {
    worktreeStateSlices[worktreeLocalId] = changedFilesSlices(
      worktreeLocalId,
      files,
    );
  }

  /// The desktop projected [worktreeLocalId] with [files]: the server cache
  /// holds them and the targeted worktree snapshot arrives.
  void landProjection(
    String worktreeLocalId,
    List<Map<String, dynamic>> files,
  ) {
    cacheFiles(worktreeLocalId, files);
    eventsController.add(
      RemotePortalEventBatch(
        events: [
          RemoteStateSnapshotEvent(
            scope: 'worktree',
            targetWorkspaceLocalId: 'ws-1',
            targetWorktreeLocalId: worktreeLocalId,
          ),
        ],
        nextCursor: _cursor++,
      ),
    );
  }

  @override
  Future<void> requestWorktreeState({
    required String workspaceLocalId,
    required String worktreeLocalId,
  }) async {
    await super.requestWorktreeState(
      workspaceLocalId: workspaceLocalId,
      worktreeLocalId: worktreeLocalId,
    );
    final error = projectionError;
    projectionError = null;
    if (error != null) throw error;
  }

  /// Answers each chat request with its transcript, as the desktop does.
  @override
  Future<String?> requestChatTranscript(RemoteChatTarget target) async {
    await super.requestChatTranscript(target);
    final chatId = target.chatId;
    if (chatId == null) return null;
    scheduleMicrotask(
      () => eventsController.add(
        RemotePortalEventBatch(
          events: [
            RemoteStateSnapshotEvent(
              scope: 'chat',
              targetChatId: chatId,
              targetChatScope: RemoteChatScope.worktree,
              chatMessages: [
                RemoteChatMessage(
                  messageId: '$chatId-q',
                  chatId: chatId,
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.user,
                  status: ChatMessageStatus.complete,
                  text: 'Round invoice totals to the currency precision.',
                ),
                RemoteChatMessage(
                  messageId: '$chatId-a',
                  chatId: chatId,
                  scope: RemoteChatScope.worktree,
                  role: ChatRole.assistant,
                  status: ChatMessageStatus.complete,
                  text: 'Updated the totals and added tests for each rule.',
                ),
              ],
            ),
          ],
          nextCursor: _cursor++,
        ),
      ),
    );
    return null;
  }
}

/// A projection request the relay refused.
const changedFilesProjectionError = RemoteControlException(
  'Projection request failed',
);

/// [worktreeLocalId]'s chat, from which the Activity drawer opens.
Widget changedFilesHost(
  RemoteControlViewModel viewModel, {
  String worktreeLocalId = 'wt-1',
  ThemeMode themeMode = ThemeMode.light,
  bool reduceMotion = false,
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
    builder: reduceMotion
        ? (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          )
        : null,
    navigatorObservers: [appRouteObserver],
    home: RemoteChatScreen.worktree(
      key: ValueKey(worktreeLocalId),
      worktree: viewModel
          .worktreesFor('ws-1')
          .firstWhere((row) => row.localId == worktreeLocalId),
    ),
  ),
);
