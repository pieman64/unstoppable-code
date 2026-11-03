import 'package:flutter/material.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/models/remote_chat.dart';
import 'package:mobile/data/models/remote_session.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/repositories/auth_repository.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/repositories/members_repository.dart';
import 'package:mobile/data/repositories/turn_feedback_repository.dart';
import 'package:mobile/ui/core/app_route_observer.dart';
import 'package:mobile/ui/core/theme.dart';
import 'package:mobile/ui/features/auth/view_models/auth_view_model.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';
import 'package:mobile/ui/features/feed/views/feed_screen.dart';
import 'package:mobile/ui/features/members/view_models/members_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/remote_control_view_model.dart';
import 'package:mobile/ui/features/remote/view_models/turn_feedback_controller.dart';
import 'package:mobile/ui/features/remote/views/remote_chat_screen.dart';
import 'package:provider/provider.dart';

import 'fake_remote_control_repository.dart';

// Synthetic data for the CAN-3622 search field device flow and its capture
// harness: one paired worktree whose desktop offers eight dispatchable
// pipelines (enough for the picker's search), and an activity feed that
// records each request's free-text query. No account, desktop or network.

/// Pipelines the picker lists; "staging" matches Deploy and Smoke tests.
const searchFieldPipelines = [
  ('review', 'Code review', 'Review the diff with an agent.'),
  ('deploy', 'Deploy', 'Ship the branch to staging.'),
  ('lint', 'Lint and format', 'Check style before a commit.'),
  ('nightly', 'Nightly build', 'Build every platform overnight.'),
  ('plan', 'Plan', 'Draft an implementation plan.'),
  ('notes', 'Release notes', 'Summarize merged changes.'),
  ('scan', 'Security scan', 'Audit dependencies for advisories.'),
  ('smoke', 'Smoke tests', 'Check staging after a deploy.'),
];

const _snapshot = RemoteSessionSnapshot(
  workspaces: [],
  worktrees: [
    RemoteWorktree(
      localId: 'wt-1',
      workspaceLocalId: 'ws-1',
      branch: 'feature/search',
    ),
  ],
  standaloneChats: [],
  chatSummaries: [
    RemoteChatSummary(
      chatId: 'chat-1',
      scope: RemoteChatScope.worktree,
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Search field',
      active: true,
    ),
  ],
  chatMessages: [],
);

FakeRemoteControlRepository searchFieldRemoteRepository({
  bool supportsDispatch = true,
}) => FakeRemoteControlRepository()
  ..supportsPipelineDispatch = supportsDispatch
  ..snapshotBuilder = (() => _snapshot)
  ..worktreeStateSlices = {
    'wt-1': {
      'pipelines': [
        for (final (id, name, description) in searchFieldPipelines)
          {
            'pipelineId': id,
            'name': name,
            'description': description,
            'origin': id == 'review' ? 'bundled' : 'project',
            'triggerTypes': ['dispatch'],
            'worktreeLocalId': 'wt-1',
          },
      ],
    },
  };

/// The worktree chat, from which the Activity drawer opens.
Widget searchFieldRemoteHost(
  RemoteControlViewModel viewModel, {
  ThemeMode themeMode = ThemeMode.light,
  TransitionBuilder? builder,
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
    builder: builder,
    navigatorObservers: [appRouteObserver],
    home: RemoteChatScreen.worktree(
      worktree: viewModel.worktreesFor('ws-1').single,
    ),
  ),
);

/// The activity feed with its filter sheet, on sample data.
Widget searchFieldFeedHost(
  FeedRepository feedRepository, {
  ThemeMode themeMode = ThemeMode.light,
  TransitionBuilder? builder,
}) => MultiProvider(
  providers: [
    ChangeNotifierProvider<AuthViewModel>(
      create: (_) => AuthViewModel(repository: MockAuthRepository()),
    ),
    ChangeNotifierProvider<FeedViewModel>(
      create: (_) => FeedViewModel(repository: feedRepository)..loadFeed(),
    ),
    ChangeNotifierProvider<MembersViewModel>(
      create: (_) => MembersViewModel(
        repository: MockMembersRepository(latency: Duration.zero),
      )..load(),
    ),
  ],
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light,
    darkTheme: AppTheme.dark,
    themeMode: themeMode,
    builder: builder,
    home: const FeedScreen(),
  ),
);

/// Delegates to the sample feed and records each request's free-text query;
/// the sample itself ignores queries, which only the server applies.
final class RecordingFeedRepository implements FeedRepository {
  final _sample = MockFeedRepository();
  final queries = <String?>[];

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) {
    queries.add(query);
    return _sample.fetchFeed(
      cursor: cursor,
      types: types,
      query: query,
      actorId: actorId,
    );
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}
