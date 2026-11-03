import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feed_api_service.dart';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const _baseUrl = 'https://canopy.example.com';
const _orgId = 'org-abc123';
const _sessionCookie = 'better-auth.session_token=test-token';

/// Builds a [FeedApiService] backed by the given [MockClient].
FeedApiService _buildService(MockClient mockClient) {
  final apiClient = ApiClient(
    baseUrl: _baseUrl,
    defaultHeaders: {'Cookie': _sessionCookie},
    httpClient: mockClient,
  );
  return FeedApiService(apiClient: apiClient);
}

/// Minimal feed JSON with one [AgentSessionFeedItem].
Map<String, dynamic> _feedJson({String? nextCursor}) => {
  'items': [
    {
      'type': 'agent_session',
      'id': 'feed-001',
      'occurredAt': '2026-06-30T12:00:00.000Z',
      'actor': {'userId': 'user-001', 'displayName': 'Alex Rivera'},
      'worktreeId': 'wt-abc',
      'clientChatId': 'chat-001',
      'latestModel': 'claude-sonnet-4-5',
      'latestStatus': 'completed',
      'toolUseCount': 12,
      'totalCostUsd': 0.042,
      'turnCount': 6,
    },
  ],
  'nextCursor': nextCursor,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('FeedApiService', () {
    test('fetchFeed hits the correct path and parses the response', () async {
      Uri? capturedUri;

      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        return http.Response(jsonEncode(_feedJson()), 200);
      });

      final service = _buildService(mockClient);
      final result = await service.fetchFeed(orgId: _orgId);

      // Verify the URI path is correct.
      expect(capturedUri?.path, '/api/account/organizations/$_orgId/feed');

      // Verify the response parsed correctly.
      expect(result, isA<FeedPageResponse>());
      expect(result.items, hasLength(1));
      expect(result.nextCursor, isNull);

      final item = result.items.first;
      expect(item, isA<AgentSessionFeedItem>());
      expect(item.id, 'feed-001');
      expect((item as AgentSessionFeedItem).latestStatus, 'completed');
    });

    test('fetchFeed appends cursor and limit as query parameters', () async {
      Uri? capturedUri;

      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        return http.Response(
          jsonEncode(_feedJson(nextCursor: 'cursor-xyz')),
          200,
        );
      });

      final service = _buildService(mockClient);
      final result = await service.fetchFeed(
        orgId: _orgId,
        cursor: 'cursor-abc',
        limit: 20,
      );

      expect(capturedUri?.queryParameters['cursor'], 'cursor-abc');
      expect(capturedUri?.queryParameters['limit'], '20');
      expect(result.nextCursor, 'cursor-xyz');
    });

    test('fetchFeed encodes type and search filters as query params', () async {
      Uri? capturedUri;
      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        return http.Response(jsonEncode(_feedJson()), 200);
      });

      final service = _buildService(mockClient);
      await service.fetchFeed(
        orgId: _orgId,
        types: [FeedItemType.prMerged, FeedItemType.runFailed],
        query: '  auth gate  ',
      );

      expect(capturedUri?.queryParameters['types'], 'pr_merged,run_failed');
      expect(capturedUri?.queryParameters['q'], 'auth gate'); // trimmed
    });

    test('fetchFeed encodes actorId (trimmed) as a query param', () async {
      Uri? capturedUri;
      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        return http.Response(jsonEncode(_feedJson()), 200);
      });

      final service = _buildService(mockClient);
      await service.fetchFeed(orgId: _orgId, actorId: '  actor-uuid-1  ');

      expect(capturedUri?.queryParameters['actorId'], 'actor-uuid-1');
    });

    test('fetchFeed omits empty filters', () async {
      Uri? capturedUri;
      final mockClient = MockClient((request) async {
        capturedUri = request.url;
        return http.Response(jsonEncode(_feedJson()), 200);
      });

      final service = _buildService(mockClient);
      await service.fetchFeed(
        orgId: _orgId,
        types: const [],
        query: '   ',
        actorId: '   ',
      );

      expect(capturedUri?.queryParameters.containsKey('types'), isFalse);
      expect(capturedUri?.queryParameters.containsKey('q'), isFalse);
      expect(capturedUri?.queryParameters.containsKey('actorId'), isFalse);
    });

    test('fetchFeed throws ApiException on non-2xx response', () async {
      final mockClient = MockClient((_) async {
        return http.Response('{"error":"Unauthorized"}', 401);
      });

      final service = _buildService(mockClient);

      expect(
        () => service.fetchFeed(orgId: _orgId),
        throwsA(
          isA<ApiException>()
              .having((e) => e.statusCode, 'statusCode', 401)
              .having((e) => e.body, 'body', contains('Unauthorized')),
        ),
      );
    });
  });

  test('reports skipped rows by count only (CAN-3715)', () async {
    final messages = <String>[];
    final previous = debugPrint;
    debugPrint = (message, {wrapWidth}) => messages.add(message ?? '');
    addTearDown(() => debugPrint = previous);
    final json = _feedJson();
    json['items'] = [
      ...json['items'] as List<Object?>,
      {'type': 'future_kind', 'id': 'secret-id-1'},
      {'type': 'agent_session', 'id': 'secret-id-2'},
    ];
    final service = _buildService(
      MockClient((request) async => http.Response(jsonEncode(json), 200)),
    );

    final page = await service.fetchFeed(orgId: _orgId);

    expect(page.items.map((i) => i.id), ['feed-001']);
    expect(messages, ['Activity skipped 2 of 3 feed items it cannot read.']);
    expect(messages.single, isNot(contains('secret-id')));
  });

  test('fetchSharingStatus reads the viewer evidence (CAN-3715)', () async {
    Uri? captured;
    final service = _buildService(
      MockClient((request) async {
        captured = request.url;
        return http.Response(
          jsonEncode({
            'viewerUserId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'scopes': {
              'metadata': 'private',
              'plans': 'prohibited',
              'summaries': 'something-new',
              'transcripts': 'shared',
            },
          }),
          200,
        );
      }),
    );

    final status = await service.fetchSharingStatus(orgId: _orgId);

    expect(captured?.path, '/api/account/organizations/$_orgId/data-sharing');
    expect(status.metadata, FeedSharingState.private);
    expect(status.plans, FeedSharingState.prohibited);
    // An unknown wire value never claims evidence.
    expect(status.summaries, FeedSharingState.unknown);
  });
}
