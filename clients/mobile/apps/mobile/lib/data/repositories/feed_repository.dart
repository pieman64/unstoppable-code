import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/services/feed_api_service.dart';

/// Contract for fetching paginated feed data, optionally filtered by item
/// [types], a free-text [query], and a single actor via [actorId] (a member's
/// user externalId).
abstract interface class FeedRepository {
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  });

  /// The viewer's data-sharing evidence for this feed's organization, or null
  /// when the feed has none (Personal Activity, or mock data).
  Future<FeedSharingStatus?> fetchSharingStatus();
}

/// Reads the viewer's data-sharing evidence for organization [orgId].
typedef FeedSharingStatusReader =
    Future<FeedSharingStatus?> Function({required String orgId});

/// The [FeedSharingStatusReader] for a feed without organization sharing
/// evidence (Personal Activity). It sends no request.
Future<FeedSharingStatus?> noFeedSharingStatus({required String orgId}) async =>
    null;

/// In-memory stub that returns a realistic sample page covering five
/// different [FeedItem] variants.  Includes a small artificial delay
/// to simulate a network round-trip so the loading state is visible.
final class MockFeedRepository implements FeedRepository {
  static const _delay = Duration(milliseconds: 600);

  static final _actor = FeedActor(
    displayName: 'Alex Rivera',
    userId: 'user-001',
  );

  static final _actor2 = FeedActor(displayName: 'Sam Chen', userId: 'user-002');

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    await Future<void>.delayed(_delay);

    final items = <FeedItem>[
      AgentSessionFeedItem(
        actor: _actor,
        id: 'feed-001',
        occurredAt: DateTime.now()
            .subtract(const Duration(minutes: 4))
            .toIso8601String(),
        worktreeId: 'wt-abc',
        clientChatId: 'chat-001',
        latestModel: 'claude-sonnet-4-5',
        latestStatus: 'completed',
        toolUseCount: 12,
        totalCostUsd: 0.042,
        turnCount: 6,
      ),
      PrMergedFeedItem(
        actor: _actor,
        id: 'feed-002',
        occurredAt: DateTime.now()
            .subtract(const Duration(hours: 1))
            .toIso8601String(),
        worktreeId: 'wt-abc',
        additions: 134,
        branchName: 'feat/activity-feed',
        changedFiles: 7,
        deletions: 23,
        models: const ['claude-sonnet-4-5'],
        prNumber: 247,
        prUrl: 'https://github.com/example/repo/pull/247',
        repoName: 'example/repo',
        title: 'Add activity feed screen',
        totalCostUsd: 0.018,
        totalTokens: 14200,
      ),
      PipelineRunFeedItem(
        actor: _actor2,
        id: 'feed-003',
        occurredAt: DateTime.now()
            .subtract(const Duration(hours: 3))
            .toIso8601String(),
        pipelineId: 'pipe-ci-001',
        pipelineName: 'CI / Tests',
        startedAt: DateTime.now()
            .subtract(const Duration(hours: 3, minutes: 5))
            .toIso8601String(),
        completedAt: DateTime.now()
            .subtract(const Duration(hours: 3))
            .toIso8601String(),
        status: 'success',
        stepCount: 8,
        jobCount: 2,
        runDurationMs: 312000,
      ),
      PlanApprovedFeedItem(
        actor: _actor2,
        id: 'feed-004',
        occurredAt: DateTime.now()
            .subtract(const Duration(hours: 6))
            .toIso8601String(),
        planId: 'plan-xyz',
        planVersion: 3,
        reviewStatus: 'approved',
        title: 'Refactor authentication module',
      ),
      RunFailedFeedItem(
        actor: _actor,
        id: 'feed-005',
        occurredAt: DateTime.now()
            .subtract(const Duration(hours: 9))
            .toIso8601String(),
        label: 'Deploy to staging',
        model: 'claude-sonnet-4-5',
        notificationWorthy: true,
        status: 'error',
      ),
    ];

    // The mock applies the type and actor filters so filtering is demoable
    // without a backend; free-text `query` is handled server-side only.
    final trimmedActorId = actorId?.trim();
    final filtered = items.where((item) {
      if (types != null && types.isNotEmpty && !types.contains(item.type)) {
        return false;
      }
      if (trimmedActorId != null && trimmedActorId.isNotEmpty) {
        return item.actor.userId == trimmedActorId;
      }
      return true;
    }).toList();
    return FeedPageResponse(items: filtered);
  }

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() async => null;
}

/// Live [FeedRepository] that fetches data from the Canopy web API via
/// [FeedApiService].
///
/// [orgId] may be a team organization or the Personal organization. Only a
/// team organization has organization data-sharing evidence, so the shell
/// injects [readSharingStatus]: the team feed passes
/// [FeedApiService.fetchSharingStatus], and Personal Activity passes
/// [noFeedSharingStatus], which never calls that endpoint.
///
/// Constructed only when [AppConfig.hasAuthApiConfig] is true (i.e. at least one
/// fixed brand-prefixed API URL was supplied at build/run time). Otherwise
/// [MockFeedRepository] is used so `flutter test` and CI continue to work
/// without any network configuration.
final class HttpFeedRepository implements FeedRepository {
  const HttpFeedRepository({
    required this.service,
    required this.orgId,
    required this.readSharingStatus,
  });

  final FeedApiService service;
  final String orgId;
  final FeedSharingStatusReader readSharingStatus;

  @override
  Future<FeedPageResponse> fetchFeed({
    String? cursor,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) => service.fetchFeed(
    orgId: orgId,
    cursor: cursor,
    types: types,
    query: query,
    actorId: actorId,
  );

  @override
  Future<FeedSharingStatus?> fetchSharingStatus() =>
      readSharingStatus(orgId: orgId);
}
