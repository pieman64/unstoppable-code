import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/turn_feedback.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/turn_feedback_api_service.dart';

void main() {
  test('rate posts the correlation keys and context', () async {
    late http.Request captured;
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'feedbackId': 'fb-1',
              'clientUserMessageId': 'msg-3-1757000000000',
              'rating': 'down',
              'hasComment': false,
              'createdAt': '2026-09-01T00:00:00.000Z',
              'updatedAt': '2026-09-01T00:00:00.000Z',
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    final summary = await service.rate(
      clientUserMessageId: 'msg-3-1757000000000',
      clientChatId: 'chat-abc',
      rating: TurnFeedbackRating.down,
      provider: 'claude',
      model: 'claude-opus-5',
      chatMode: 'canopy',
      appVersion: '1.2.3+45',
      eventType: 'worktree_chat',
    );

    expect(captured.url.path, '/api/v1/feedback/turns');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body['clientUserMessageId'], 'msg-3-1757000000000');
    expect(body['clientChatId'], 'chat-abc');
    expect(body['rating'], 'down');
    expect(body['provider'], 'claude');
    // eventType must be forwarded verbatim -- it is one of the server's
    // closed TELEMETRY_EVENT_TYPES values (the same ones desktop sends for a
    // worktree vs. standalone/cowork chat), never a mobile-invented one.
    expect(body['eventType'], 'worktree_chat');
    expect(summary.feedbackId, 'fb-1');
  });

  test('rate omits absent context keys rather than sending nulls', () async {
    late http.Request captured;
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'feedbackId': 'fb-2',
              'clientUserMessageId': 'm',
              'rating': 'up',
              'hasComment': false,
              'createdAt': '2026-09-01T00:00:00.000Z',
              'updatedAt': '2026-09-01T00:00:00.000Z',
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    await service.rate(
      clientUserMessageId: 'm',
      clientChatId: 'chat-abc',
      rating: TurnFeedbackRating.up,
    );

    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body.containsKey('provider'), isFalse);
    expect(body.containsKey('model'), isFalse);
    // The server treats an unrecognized eventType as absent anyway, but a
    // literal null would still occupy the column -- omitting it end to end
    // when the caller supplies nothing is the whole point of Finding 1's fix.
    expect(body.containsKey('eventType'), isFalse);
  });

  test('listForChat sends clientChatId and parses the array', () async {
    late http.Request captured;
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'feedback': <dynamic>[
                <String, dynamic>{
                  'feedbackId': 'fb-1',
                  'clientUserMessageId': 'msg-3-1757000000000',
                  'rating': 'up',
                  'hasComment': false,
                  'createdAt': '2026-09-01T00:00:00.000Z',
                  'updatedAt': '2026-09-01T00:00:00.000Z',
                },
              ],
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    final rows = await service.listForChat('chat-abc');

    expect(captured.url.queryParameters['clientChatId'], 'chat-abc');
    expect(rows, hasLength(1));
    expect(rows.first.rating, TurnFeedbackRating.up);
  });

  test('attachDetail patches only the fields supplied', () async {
    late http.Request captured;
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode(<String, dynamic>{'ok': true}),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    await service.attachDetail(
      feedbackId: 'fb-1',
      reason: TurnFeedbackReason.gotStuck,
    );

    expect(captured.method, 'PATCH');
    expect(captured.url.path, '/api/v1/feedback/turns/fb-1');
    final body = jsonDecode(captured.body) as Map<String, dynamic>;
    expect(body['reason'], 'got-stuck');
    expect(body.containsKey('comment'), isFalse);
  });

  test('listForChat skips a corrupt row instead of discarding the whole '
      "chat's ratings", () async {
    // One unrecognized `rating` makes `TurnFeedbackSummary.fromJson` throw.
    // Decoding the array in one `map` let that single row take every other
    // rating in the chat down with it.
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'feedback': <dynamic>[
                <String, dynamic>{
                  'feedbackId': 'fb-bad',
                  'clientUserMessageId': 'msg-1',
                  'rating': 'sideways',
                  'hasComment': false,
                },
                <String, dynamic>{
                  'feedbackId': 'fb-good',
                  'clientUserMessageId': 'msg-2',
                  'rating': 'up',
                  'hasComment': false,
                },
              ],
            }),
            200,
            headers: <String, String>{'content-type': 'application/json'},
          );
        }),
      ),
    );

    final rows = await service.listForChat('chat-abc');

    expect(rows, hasLength(1));
    expect(rows.single.feedbackId, 'fb-good');
  });

  test('feedbackId is percent-encoded into the request path', () async {
    late http.Request captured;
    final service = TurnFeedbackApiService(
      apiClient: ApiClient(
        baseUrl: 'https://example.test',
        httpClient: MockClient((request) async {
          captured = request;
          return http.Response('', 204);
        }),
      ),
    );

    // A server-issued id should never contain these, but interpolating an
    // untrusted value straight into a path is how a stray `../` or `?`
    // becomes a different request than the one intended.
    await service.clear('fb/../1?x=y');

    expect(captured.url.path, '/api/v1/feedback/turns/fb%2F..%2F1%3Fx%3Dy');
    expect(captured.url.queryParameters, isEmpty);
  });
}
