import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/feed_sharing_status.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/data/repositories/feed_repository.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/feed_api_service.dart';
import 'package:mobile/ui/features/feed/view_models/feed_sharing_guidance.dart';
import 'package:mobile/ui/features/feed/view_models/feed_view_model.dart';

const _teamOrgId = 'org-team';
const _personalOrgId = 'org-personal';

FeedApiService _service(http.Client client) => FeedApiService(
  apiClient: ApiClient(baseUrl: 'https://api.test', httpClient: client),
);

/// The team Activity repository, composed as the team shell composes it.
FeedRepository _teamRepository(http.Client client) {
  final service = _service(client);
  return HttpFeedRepository(
    service: service,
    orgId: _teamOrgId,
    readSharingStatus: service.fetchSharingStatus,
  );
}

/// The Personal Activity repository, composed as the Personal shell does.
FeedRepository _personalRepository(http.Client client) => HttpFeedRepository(
  service: _service(client),
  orgId: _personalOrgId,
  readSharingStatus: noFeedSharingStatus,
);

Map<String, dynamic> _row(String id, String occurredAt) => {
  'type': 'agent_session',
  'id': id,
  'occurredAt': occurredAt,
  'actor': {'userId': 'user-001', 'displayName': 'Alex Rivera'},
  'worktreeId': 'wt-abc',
  'clientChatId': 'chat-$id',
  'latestModel': 'claude-sonnet-4-5',
  'latestStatus': 'completed',
  'toolUseCount': 1,
  'totalCostUsd': 0.01,
  'turnCount': 1,
};

/// Two pages: the first page links to `c2`, which ends the feed.
http.Response _page(http.Request request) {
  final second = request.url.queryParameters['cursor'] == 'c2';
  return http.Response(
    jsonEncode({
      'items': [
        second
            ? _row('row-2', '2026-06-30T11:00:00.000Z')
            : _row('row-1', '2026-06-30T12:00:00.000Z'),
      ],
      'nextCursor': second ? null : 'c2',
    }),
    200,
  );
}

http.Response _sharing(Map<String, String> scopes) => http.Response(
  jsonEncode({
    'viewerUserId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'scopes': scopes,
  }),
  200,
);

bool _isSharingRead(http.Request request) =>
    request.url.path.endsWith('/data-sharing');

void main() {
  test('asks the injected reader for its own organization', () async {
    final asked = <String>[];
    const evidence = FeedSharingStatus(
      metadata: FeedSharingState.shared,
      plans: FeedSharingState.private,
      summaries: FeedSharingState.unknown,
    );
    final repository = HttpFeedRepository(
      service: _service(MockClient((request) async => _page(request))),
      orgId: _teamOrgId,
      readSharingStatus: ({required orgId}) async {
        asked.add(orgId);
        return evidence;
      },
    );

    expect(await repository.fetchSharingStatus(), same(evidence));
    expect(asked, [_teamOrgId]);
  });

  group('team Activity', () {
    test('reads the team organization sharing evidence (CAN-3715)', () async {
      final requests = <http.Request>[];
      final repository = _teamRepository(
        MockClient((request) async {
          requests.add(request);
          return _sharing({
            'metadata': 'private',
            'plans': 'prohibited',
            'summaries': 'something-new',
          });
        }),
      );

      final status = await repository.fetchSharingStatus();

      expect(requests.map((r) => '${r.method} ${r.url.path}'), [
        'GET /api/account/organizations/$_teamOrgId/data-sharing',
      ]);
      expect(status?.metadata, FeedSharingState.private);
      expect(status?.plans, FeedSharingState.prohibited);
      // An unknown wire value never claims evidence.
      expect(status?.summaries, FeedSharingState.unknown);
    });

    test('passes a failed sharing read to its caller', () async {
      final repository = _teamRepository(
        MockClient((request) async => http.Response('{"error":"no"}', 403)),
      );

      await expectLater(
        repository.fetchSharingStatus(),
        throwsA(
          isA<ApiException>().having((e) => e.statusCode, 'statusCode', 403),
        ),
      );
    });

    test('fetches pages for the team organization only', () async {
      final requests = <http.Request>[];
      final repository = _teamRepository(
        MockClient((request) async {
          requests.add(request);
          return _page(request);
        }),
      );

      final page = await repository.fetchFeed(
        cursor: 'c2',
        types: const [FeedItemType.agentSession],
        query: ' fix ',
        actorId: 'user-001',
      );

      expect(page.items.map((item) => item.id), ['row-2']);
      expect(requests, hasLength(1));
      expect(
        requests.single.url.path,
        '/api/account/organizations/$_teamOrgId/feed',
      );
      expect(requests.single.url.queryParameters, {
        'cursor': 'c2',
        'types': 'agent_session',
        'q': 'fix',
        'actorId': 'user-001',
      });
    });

    test('a pending sharing read does not hold the first page', () async {
      final sharing = Completer<http.Response>();
      final viewModel = FeedViewModel(
        repository: _teamRepository(
          MockClient((request) async {
            if (_isSharingRead(request)) return sharing.future;
            return _page(request);
          }),
        ),
      );
      addTearDown(viewModel.dispose);

      await viewModel.loadFeed();

      expect(viewModel.items.map((item) => item.id), ['row-1']);
      expect(viewModel.sharingGuidance, FeedSharingGuidance.none);

      sharing.complete(
        _sharing({
          'metadata': 'private',
          'plans': 'shared',
          'summaries': 'shared',
        }),
      );
      await pumpEventQueue();

      expect(viewModel.sharingGuidance, isNot(FeedSharingGuidance.none));
    });
  });

  group('Personal Activity', () {
    test('has no sharing evidence and sends no request for it', () async {
      final requests = <http.Request>[];
      final repository = _personalRepository(
        MockClient((request) async {
          requests.add(request);
          return _sharing({'metadata': 'shared'});
        }),
      );

      expect(await repository.fetchSharingStatus(), isNull);
      expect(requests, isEmpty);
    });

    test(
      'loads, appends and reloads without a sharing request (CAN-3715)',
      () async {
        final requests = <http.Request>[];
        final viewModel = FeedViewModel(
          repository: _personalRepository(
            MockClient((request) async {
              requests.add(request);
              return _page(request);
            }),
          ),
        );
        addTearDown(viewModel.dispose);

        await viewModel.loadFeed();
        await viewModel.loadMore();
        await viewModel.loadFeed();
        await pumpEventQueue();

        expect(viewModel.items.map((item) => item.id), ['row-1', 'row-2']);
        expect(viewModel.error, isNull);
        expect(viewModel.sharingGuidance, FeedSharingGuidance.none);
        expect(requests.where(_isSharingRead), isEmpty);
        expect(requests.map((r) => r.url.path).toSet(), {
          '/api/account/organizations/$_personalOrgId/feed',
        });
        expect(requests.map((r) => r.url.queryParameters['cursor']), [
          null,
          'c2',
          null,
          'c2',
        ]);
      },
    );
  });
}
