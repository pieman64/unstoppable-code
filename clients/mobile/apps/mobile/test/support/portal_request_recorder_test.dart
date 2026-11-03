import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_event_stream.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

import 'portal_request_recorder.dart';

const _origin = 'https://budget.test';
const _base = '$_origin$portalBrowserBasePath';

http.StreamedResponse _ok([String body = '{}']) =>
    http.StreamedResponse(Stream.value(utf8.encode(body)), 200);

void main() {
  group('PortalRequestRecorder', () {
    test('records each request by endpoint, state scope and command', () async {
      final recorder = PortalRequestRecorder();
      final start = recorder.mark();
      final client = recorder.client((_) async => _ok());

      await client.get(Uri.parse('$_base/session'));
      await client.get(
        Uri.parse('$_base/sessions/sess-1/state?scope=chat&chatLocalId=c'),
      );
      await client.post(
        Uri.parse('$_base/sessions/sess-1/commands'),
        body: jsonEncode({
          'type': 'portal.state.request',
          'payload': {'scope': 'worktree'},
        }),
      );
      await client.post(
        Uri.parse('$_base/sessions/sess-1/commands'),
        body: jsonEncode({
          'type': 'portal.pr.action',
          'payload': {'action': 'refresh'},
        }),
      );
      await client.get(Uri.parse('$_base/sessions/sess-1/commands/cmd-9'));

      expect(recorder.requests.map((request) => request.key), [
        'GET session',
        'GET state scope=chat',
        'POST commands portal.state.request scope=worktree',
        'POST commands portal.pr.action action=refresh',
        'GET commands/:id',
      ]);
      expect(recorder.countsSince(start), {
        'requests': 5,
        'event streams': 0,
        'GET commands/:id': 1,
        'GET session': 1,
        'GET state': 1,
        'GET state scope=chat': 1,
        'POST commands': 2,
        'POST commands portal.pr.action action=refresh': 1,
        'POST commands portal.state.request scope=worktree': 1,
      });
      expect(recorder.requests.map((request) => request.status), [
        200,
        200,
        200,
        200,
        200,
      ]);
    });

    test('counts requests after a mark only', () async {
      final recorder = PortalRequestRecorder();
      final client = recorder.client((_) async => _ok());
      await client.get(Uri.parse('$_base/session'));
      final mark = recorder.mark();
      await client.get(Uri.parse('$_base/session'));

      expect(recorder.countsSince(mark), {
        'requests': 1,
        'event streams': 0,
        'GET session': 1,
      });
    });

    test('records a failed request and an unrouted one', () async {
      final recorder = PortalRequestRecorder();
      final client = recorder.client((request) async {
        if (request.url.path.endsWith('/session')) {
          throw http.ClientException('offline', request.url);
        }
        return http.StreamedResponse(const Stream.empty(), 404);
      });

      await expectLater(
        client.get(Uri.parse('$_base/session')),
        throwsA(isA<http.ClientException>()),
      );
      await client.get(Uri.parse('$_origin/api/v1/elsewhere'));

      expect(recorder.requests.map((request) => request.key), [
        'GET session',
        'GET /api/v1/elsewhere',
      ]);
      expect(recorder.requests.map((request) => request.status), [null, 404]);
    });

    test('closing a client ends its open responses and later sends', () async {
      final recorder = PortalRequestRecorder();
      final start = recorder.mark();
      final body = StreamController<List<int>>();
      final client = recorder.client(
        (_) async => http.StreamedResponse(body.stream, 200),
      );
      final response = await client.send(
        http.Request('GET', Uri.parse('$_base/sessions/s/events/stream')),
      );
      final ended = response.stream.toList();

      client.close();

      await expectLater(ended, throwsA(isA<http.ClientException>()));
      await expectLater(
        client.get(Uri.parse('$_base/session')),
        throwsA(isA<http.ClientException>()),
      );
      expect(recorder.requests.map((request) => request.key), [
        'GET events/stream',
      ]);
      expect(recorder.countsSince(start)['event streams'], 1);
      await body.close();
    });

    test('records the event stream and its long-poll fallback', () async {
      final recorder = PortalRequestRecorder();
      final start = recorder.mark();
      Future<http.StreamedResponse> handle(http.Request request) async {
        if (request.url.path.endsWith('/events/stream')) {
          return http.StreamedResponse(const Stream.empty(), 404);
        }
        return _ok(jsonEncode({'events': [], 'nextCursor': 4}));
      }

      final stream = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {},
        clientFactory: () => recorder.client(handle),
        wait: (_) async {},
      );

      final batch = await stream.subscribe(sessionId: 'sess-1').first;

      expect(batch.nextCursor, 4);
      // The loop polls again before the cancellation reaches it.
      final [sse, poll, ...] = recorder.requests;
      expect([sse.key, poll.key], ['GET events/stream', 'GET events']);
      expect([sse.status, poll.status], [404, 200]);
      expect(
        recorder.countsSince(start)['event streams'],
        recorder.requests.length,
      );
    });

    test('records requests the real API client sends', () async {
      final recorder = PortalRequestRecorder();
      final service = RemoteControlApiService(
        apiClient: ApiClient(
          baseUrl: _origin,
          tokenProvider: () => 'token',
          httpClient: recorder.client(
            (_) async => _ok(jsonEncode({'commandId': 'cmd-1'})),
          ),
        ),
      );

      await service.submitCommand(
        'sess-1',
        type: 'portal.chat.mark_read',
        payload: const {'scope': 'worktree', 'lastMessageId': 'm-1'},
      );

      expect(
        recorder.requests.single.key,
        'POST commands portal.chat.mark_read '
        'scope=worktree',
      );
    });
  });

  group('requestBudgetViolations', () {
    const budget = {
      'requests': 2,
      'event streams': 1,
      'GET session': 1,
      'GET events/stream': 1,
    };

    test('accepts counts at or below every limit', () {
      expect(
        requestBudgetViolations({
          'requests': 2,
          'event streams': 1,
          'GET session': 1,
          'GET events/stream': 1,
        }, budget),
        isEmpty,
      );
      expect(
        requestBudgetViolations({'requests': 1, 'GET session': 1}, budget),
        isEmpty,
      );
    });

    test('rejects one request above a limit', () {
      expect(
        requestBudgetViolations({
          'requests': 3,
          'event streams': 1,
          'GET session': 2,
          'GET events/stream': 1,
        }, budget),
        ['GET session: 2 > 1', 'requests: 3 > 2'],
      );
    });

    test('rejects an extra event stream connection', () {
      expect(
        requestBudgetViolations({
          'requests': 2,
          'event streams': 2,
          'GET events/stream': 2,
        }, budget),
        ['GET events/stream: 2 > 1', 'event streams: 2 > 1'],
      );
    });

    test('gives an endpoint the budget does not name a limit of zero', () {
      expect(
        requestBudgetViolations({
          'requests': 1,
          'POST commands': 1,
          'POST commands portal.state.request scope=overview': 1,
        }, budget),
        [
          'POST commands: 1 > 0',
          'POST commands portal.state.request scope=overview: 1 > 0',
        ],
      );
    });
  });
}
