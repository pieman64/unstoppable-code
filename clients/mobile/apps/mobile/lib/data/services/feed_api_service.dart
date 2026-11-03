import 'package:flutter/foundation.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/services/api_client.dart';

/// Wraps the Canopy feed REST endpoints.
///
/// Endpoints:
///   GET /api/account/organizations/{orgId}/feed?limit={n}&cursor={cursor}
///   Response: `{ "items": [...], "nextCursor": string | null }`
///   GET /api/account/organizations/{orgId}/data-sharing
///   Response: `{ "viewerUserId": string, "scopes": {...} }`
final class FeedApiService {
  const FeedApiService({required this.apiClient});

  final ApiClient apiClient;

  /// Fetches a single page of feed items for [orgId].
  ///
  /// [cursor] is an opaque keyset cursor returned as `nextCursor` from the
  /// previous page.  Omit (or pass `null`) to fetch the first page.
  /// [limit] caps the number of items per page; defaults to server default
  /// when omitted.
  /// [actorId] filters to activity performed by a single member, identified by
  /// their user externalId (the backend resolves it via the `actorId` param).
  Future<FeedPageResponse> fetchFeed({
    required String orgId,
    String? cursor,
    int? limit,
    List<FeedItemType>? types,
    String? query,
    String? actorId,
  }) async {
    final trimmed = query?.trim();
    final trimmedActorId = actorId?.trim();
    final params = <String, String>{
      if (limit != null) 'limit': '$limit',
      'cursor': ?cursor,
      if (types != null && types.isNotEmpty)
        'types': types.map((t) => t.wire).join(','),
      if (trimmed != null && trimmed.isNotEmpty) 'q': trimmed,
      if (trimmedActorId != null && trimmedActorId.isNotEmpty)
        'actorId': trimmedActorId,
    };

    final json = await apiClient.getJson(
      '/api/account/organizations/$orgId/feed',
      query: params.isEmpty ? null : params,
    );

    final page = FeedPageResponse.fromJson(json);
    // The generated parser skips rows this build cannot decode. Report only
    // the counts: row contents and ids can identify private work.
    final received = (json['items'] as List<dynamic>?)?.length ?? 0;
    final skipped = received - page.items.length;
    if (skipped > 0) {
      debugPrint(
        'Activity skipped $skipped of $received feed items it cannot read.',
      );
    }
    return page;
  }

  /// Reads the viewer's data-sharing evidence for team organization [orgId].
  Future<FeedSharingStatus> fetchSharingStatus({required String orgId}) async {
    final json = await apiClient.getJson(
      '/api/account/organizations/$orgId/data-sharing',
    );
    return FeedSharingStatus.fromJson(json);
  }
}
