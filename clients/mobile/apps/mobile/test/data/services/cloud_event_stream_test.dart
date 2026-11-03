import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/services/api_client.dart';
import 'package:mobile/data/services/cloud_event_stream.dart';

ApiClient _apiClient() => ApiClient(
  baseUrl: 'https://example.test',
  tokenProvider: () => 'mobile-session',
);

CloudEventStream _stream(
  http.Client client, {
  DateTime Function()? now,
  double Function()? random,
  Future<void> Function(Duration)? wait,
}) => CloudEventStream(
  apiClient: _apiClient(),
  clientFactory: () => client,
  now: now,
  random: random,
  wait: wait ?? (_) async {},
);

String _frame({
  String event = 'message.delta',
  String data = '{"text":"hello"}',
  String? id,
  required bool hasOwnId,
}) =>
    '${id == null ? '' : 'id: $id\n'}event: $event\ndata: $data\n'
    'data: __canopy_sse_id_present__:${hasOwnId ? '1' : '0'}\n\n';

final class _AbortTrackingClient extends http.BaseClient {
  final started = Completer<void>();
  final aborted = Completer<void>();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (!started.isCompleted) started.complete();
    return aborted.future.then<http.StreamedResponse>(
      (_) => throw http.ClientException('request aborted'),
    );
  }

  @override
  void close() {
    if (!aborted.isCompleted) aborted.complete();
  }
}

void main() {
  test(
    'strips id metadata and advances the cursor only for an id-bearing block',
    () async {
      final requests = <http.BaseRequest>[];
      final reconnected = Completer<void>();
      final client = MockClient.streaming((request, bodyStream) async {
        requests.add(request);
        if (requests.length == 1) {
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                _frame(id: 'turn-1:7', hasOwnId: true) +
                    _frame(
                      event: 'tool.delta',
                      data: '{"chunk":1}',
                      hasOwnId: false,
                    ),
              ),
            ),
            200,
          );
        }
        if (!reconnected.isCompleted) reconnected.complete();
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      });

      final frames = <CloudSseFrame>[];
      final subscription = _stream(client).open('chat/1').listen(frames.add);
      await reconnected.future;
      await subscription.cancel();

      expect(frames, hasLength(2));
      expect(frames.first.id, 'turn-1:7');
      expect(frames.first.data, '{"text":"hello"}');
      expect(frames.last.id, isNull);
      expect(frames.last.data, '{"chunk":1}');
      expect(
        requests.first.url.path,
        '/api/cloud/chats/chat%2F1/events/stream',
      );
      expect(requests.first.headers['Authorization'], 'Bearer mobile-session');
      expect(requests.first.headers['Accept'], 'text/event-stream');
      expect(requests[1].url.queryParameters['after'], 'turn-1:7');
      expect(requests[1].headers['Last-Event-ID'], 'turn-1:7');
    },
  );

  test('reconnects immediately after the 240 second route lifetime', () async {
    var fakeNow = DateTime.utc(2026, 9, 20);
    final requests = <http.BaseRequest>[];
    final waits = <Duration>[];
    final reconnected = Completer<void>();
    final client = MockClient.streaming((request, bodyStream) async {
      requests.add(request);
      if (requests.length == 1) {
        Stream<List<int>> response() async* {
          yield utf8.encode(_frame(id: 'turn-2:9', hasOwnId: true));
          fakeNow = fakeNow.add(const Duration(seconds: 240));
        }

        return http.StreamedResponse(response(), 200);
      }
      if (!reconnected.isCompleted) reconnected.complete();
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    });

    final subscription = _stream(
      client,
      now: () => fakeNow,
      wait: (delay) async => waits.add(delay),
    ).open('chat-1').listen((_) {});
    await reconnected.future;
    await subscription.cancel();

    expect(waits, isEmpty);
    expect(requests[1].url.queryParameters['after'], 'turn-2:9');
    expect(requests[1].headers['Last-Event-ID'], 'turn-2:9');
  });

  test('healthy streams demote the short-stream backoff streak', () async {
    var fakeNow = DateTime.utc(2026, 9, 20);
    var connections = 0;
    final waits = <Duration>[];
    final parked = Completer<void>();
    final client = MockClient.streaming((request, bodyStream) async {
      connections += 1;
      if (connections == 5) {
        if (!parked.isCompleted) parked.complete();
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      }
      Stream<List<int>> response() async* {
        yield utf8.encode(_frame(id: 'turn-3:$connections', hasOwnId: true));
        if (connections == 3) {
          fakeNow = fakeNow.add(const Duration(seconds: 15));
        }
      }

      return http.StreamedResponse(response(), 200);
    });

    final subscription = _stream(
      client,
      now: () => fakeNow,
      random: () => 1,
      wait: (delay) async => waits.add(delay),
    ).open('chat-1').listen((_) {});
    await parked.future;
    await subscription.cancel();

    expect(waits.map((delay) => delay.inMilliseconds), [250, 500, 250]);
  });

  test('short-stream backoff grows to and stays at eight seconds', () async {
    var connections = 0;
    final waits = <Duration>[];
    final parked = Completer<void>();
    final client = MockClient.streaming((request, bodyStream) async {
      connections += 1;
      if (connections == 11) {
        if (!parked.isCompleted) parked.complete();
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      }
      return http.StreamedResponse(
        Stream.value(
          utf8.encode(_frame(id: 'turn-4:$connections', hasOwnId: true)),
        ),
        200,
      );
    });

    final subscription = _stream(
      client,
      random: () => 1,
      wait: (delay) async => waits.add(delay),
    ).open('chat-1').listen((_) {});
    await parked.future;
    await subscription.cancel();

    expect(waits.map((delay) => delay.inMilliseconds), [
      250,
      500,
      1000,
      2000,
      4000,
      8000,
      8000,
      8000,
      8000,
      8000,
    ]);
  });

  test('reconnects after stream-level connectivity loss', () async {
    var connections = 0;
    final waits = <Duration>[];
    final reconnected = Completer<void>();
    final client = MockClient.streaming((request, bodyStream) async {
      connections += 1;
      if (connections == 1) {
        return http.StreamedResponse(
          Stream<List<int>>.error(
            http.ClientException('connection lost', request.url),
          ),
          200,
        );
      }
      if (!reconnected.isCompleted) reconnected.complete();
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    });

    final subscription = _stream(
      client,
      random: () => 1,
      wait: (delay) async => waits.add(delay),
    ).open('chat-1').listen((_) {});
    await reconnected.future;
    await subscription.cancel();

    expect(waits.map((delay) => delay.inMilliseconds), [250]);
  });

  test('drains transient HTTP failures before reconnecting', () async {
    final events = <String>[];
    final parked = Completer<void>();
    var connections = 0;

    Stream<List<int>> errorBody(String status) async* {
      yield utf8.encode(status);
      events.add('drained-$status');
    }

    final client = MockClient.streaming((request, bodyStream) async {
      connections += 1;
      if (connections == 1) {
        events.add('request-429');
        return http.StreamedResponse(errorBody('429'), 429);
      }
      if (connections == 2) {
        events.add('request-503');
        return http.StreamedResponse(errorBody('503'), 503);
      }
      events.add('request-200');
      if (!parked.isCompleted) parked.complete();
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    });

    final subscription = _stream(client).open('chat-1').listen((_) {});
    await parked.future;
    await subscription.cancel();

    expect(events, [
      'request-429',
      'drained-429',
      'request-503',
      'drained-503',
      'request-200',
    ]);
  });

  for (final status in [401, 403]) {
    test('$status surfaces as a terminal authentication failure', () async {
      final client = MockClient.streaming(
        (request, bodyStream) async =>
            http.StreamedResponse(const Stream.empty(), status),
      );

      await expectLater(
        _stream(client).open('chat-1'),
        emitsError(
          isA<CloudEventStreamException>()
              .having(
                (error) => error.kind,
                'kind',
                CloudEventStreamErrorKind.authentication,
              )
              .having((error) => error.statusCode, 'statusCode', status),
        ),
      );
    });
  }

  test('404 surfaces as cloud unavailable', () async {
    final client = MockClient.streaming(
      (request, bodyStream) async =>
          http.StreamedResponse(const Stream.empty(), 404),
    );

    await expectLater(
      _stream(client).open('chat-1'),
      emitsError(
        isA<CloudEventStreamException>()
            .having(
              (error) => error.kind,
              'kind',
              CloudEventStreamErrorKind.cloudUnavailable,
            )
            .having((error) => error.statusCode, 'statusCode', 404),
      ),
    );
  });

  test('event: error is delivered as a raw frame', () async {
    final firstFrame = Completer<CloudSseFrame>();
    final client = MockClient.streaming((request, bodyStream) async {
      final response = StreamController<List<int>>();
      response.add(
        utf8.encode(
          _frame(event: 'error', data: '{"status":503}', hasOwnId: false),
        ),
      );
      return http.StreamedResponse(response.stream, 200);
    });

    final subscription = _stream(client).open('chat-1').listen((frame) {
      if (!firstFrame.isCompleted) firstFrame.complete(frame);
    });
    final frame = await firstFrame.future;
    await subscription.cancel();

    expect(frame.event, 'error');
    expect(frame.data, '{"status":503}');
    expect(frame.id, isNull);
  });

  test('cancelling hard-aborts the dedicated client', () async {
    final client = _AbortTrackingClient();
    final subscription = _stream(client).open('chat-1').listen((_) {});

    await client.started.future;
    await subscription.cancel();

    await expectLater(client.aborted.future, completes);
  });
}
