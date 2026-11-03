import 'dart:async';
import 'dart:convert';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/portal_state_decoder.dart';
import 'package:mobile/data/services/remote_control_api_service.dart';

void main() {
  for (final large in [false, true]) {
    test(
      'state read maps ${large ? "large" : "small"} payloads on the expected isolate',
      () async {
        final text = large ? List.filled(40000, 'ż🙂').join() : 'Cached answer';
        var offloaded = 0;
        final names = <String?>[];
        Future<R> run<R>(
          FutureOr<R> Function() computation, {
          String? debugName,
        }) {
          offloaded++;
          names.add(debugName);
          return Isolate.run(computation, debugName: debugName);
        }

        final service = RemoteControlApiService(
          stateDecoder: PortalStateDecoder(runner: run),
          apiClient: ApiClient(
            baseUrl: 'https://example.test',
            tokenProvider: () => 'token',
            httpClient: MockClient((request) async {
              expect(request.headers['Authorization'], 'Bearer token');
              expect(request.url.queryParameters['scope'], 'chat');
              return http.Response.bytes(
                utf8.encode(
                  jsonEncode({
                    'state': {
                      'chatMessages': [
                        {
                          'localMessageId': 'latest',
                          'localChatId': 'chat',
                          'scope': 'worktree',
                          'role': 'assistant',
                          'status': 'complete',
                          'content': text,
                          'continuesTurn': true,
                        },
                      ],
                    },
                    'eventCursor': 42,
                    'connectionStatus': 'active',
                    'refreshing': false,
                    'projectionPending': true,
                  }),
                ),
                200,
                headers: {'content-type': 'application/json; charset=utf-8'},
              );
            }),
          ),
        );
        final result = await service.fetchState('session', scope: 'chat');
        expect(result.snapshot.chatMessages.single.text, text);
        expect(result.snapshot.chatMessages.single.continuesTurn, isTrue);
        expect(result.eventCursor, 42);
        expect(result.projectionPending, isTrue);
        expect(offloaded, large ? 1 : 0);
        expect(names, large ? ['PortalStateDecoder'] : isEmpty);
      },
    );
  }

  test(
    'HTTP errors bypass the state decoder and retain their status',
    () async {
      final service = RemoteControlApiService(
        apiClient: ApiClient(
          baseUrl: 'https://example.test',
          tokenProvider: () => 'token',
          httpClient: MockClient((_) async => http.Response('Forbidden', 403)),
        ),
      );
      await expectLater(
        service.fetchState('session', scope: 'chat'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.statusCode,
            'status',
            403,
          ),
        ),
      );
    },
  );
}
