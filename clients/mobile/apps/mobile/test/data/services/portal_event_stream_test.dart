import 'dart:async';
import 'dart:convert';
import 'dart:isolate';
import 'dart:math' as math;

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_event_decoder.dart';
import 'package:mobile/data/services/portal_event_stream.dart';

import '../../support/portal_event_workloads.dart';

const _base = 'https://example.test/api/v1/desktop-app/portal/browser';

String _batchJson({
  int nextCursor = 1,
  String connectionStatus = 'active',
  List<Map<String, dynamic>> events = const [],
}) => jsonEncode({
  'events': events,
  'nextCursor': nextCursor,
  'connectionStatus': connectionStatus,
});

Map<String, dynamic> _chatEnvelope(String messageId) => {
  'type': 'portal.chat.event',
  'eventId': 'ev-$messageId',
  'occurredAt': '2026-07-16T10:00:00Z',
  'payload': {
    'scope': 'worktree',
    'chatId': 'chat-1',
    'message': {
      'messageId': messageId,
      'chatId': 'chat-1',
      'role': 'assistant',
      'status': 'streaming',
      'text': 'chunk',
      'createdAtMs': 1752600000000,
    },
  },
};

PortalEventStream _stream(http.Client client) => PortalEventStream(
  baseUrl: _base,
  headersProvider: () => const {'Authorization': 'Bearer token-1'},
  clientFactory: () => client,
  retryDelay: Duration.zero,
  // Complete reconnect pauses (including jittered backoff) immediately so
  // transport tests exercise ordering, not wall-clock timing.
  wait: (_) async {},
);

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

/// Holds every offloaded decode until the test releases it, so ordering and
/// cancellation can be asserted while a large frame is still decoding.
final class _GatedRunner {
  final gates = <Completer<void>>[];

  Future<R> run<R>(
    FutureOr<R> Function() computation, {
    String? debugName,
  }) async {
    final gate = Completer<void>();
    gates.add(gate);
    await gate.future;
    return computation();
  }

  Future<void> release(int index) async {
    gates[index].complete();
    await pumpEventQueue();
  }
}

/// Wraps [inner], recording requests and whether the subscription closed it.
final class _TrackingClient extends http.BaseClient {
  _TrackingClient(this.inner);

  final http.Client inner;
  final requests = <Uri>[];
  var closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request.url);
    return inner.send(request);
  }

  @override
  void close() => closed = true;
}

/// Forwards to [inner], counting how often its owner closed it.
final class _CloseCountingClient extends _TrackingClient {
  _CloseCountingClient(super.inner);

  var closes = 0;

  @override
  void close() {
    closes += 1;
    super.close();
  }
}

PortalEventStream _gatedStream(http.Client client, _GatedRunner runner) =>
    PortalEventStream(
      baseUrl: _base,
      headersProvider: () => const {},
      clientFactory: () => client,
      retryDelay: Duration.zero,
      wait: (_) async {},
      decoder: PortalEventDecoder(offloadThreshold: 1024, runner: runner.run),
    );

void main() {
  group('parsePortalSseFrames', () {
    test('parses id/event/data frames and keeps the remainder', () {
      final result = parsePortalSseFrames(
        'id: 5\nevent: batch\ndata: {"a":1}\n\nevent: batch\ndata: par',
      );
      expect(result.frames, hasLength(1));
      expect(result.frames.single.id, '5');
      expect(result.frames.single.event, 'batch');
      expect(result.frames.single.data, '{"a":1}');
      expect(result.remainder, 'event: batch\ndata: par');
    });

    test('normalizes CRLF, skips comments, joins multi-line data', () {
      final result = parsePortalSseFrames(
        ': keepalive\r\nevent: batch\r\ndata: line1\r\ndata: line2\r\n\r\n',
      );
      expect(result.frames, hasLength(1));
      expect(result.frames.single.data, 'line1\nline2');
      expect(result.remainder, isEmpty);
    });

    test('reports comment-only keepalive blocks as activity', () {
      final keepalive = parsePortalSseFrames(': keepalive\n\n');
      expect(keepalive.frames, isEmpty);
      expect(keepalive.sawActivity, isTrue);
      expect(keepalive.remainder, isEmpty);

      final incomplete = parsePortalSseFrames('data: partial\n');
      expect(incomplete.frames, isEmpty);
      expect(incomplete.sawActivity, isFalse);
      expect(incomplete.remainder, 'data: partial\n');
    });

    test('preserves a CRLF pair split across chunks', () {
      final first = parsePortalSseFrames('event: batch\r');
      expect(first.frames, isEmpty);
      expect(first.remainder, 'event: batch\r');

      final second = parsePortalSseFrames(
        '${first.remainder}\ndata: {"ok":true}\r\n\r\n',
      );
      expect(second.frames, hasLength(1));
      expect(second.frames.single.event, 'batch');
      expect(second.frames.single.data, '{"ok":true}');
      expect(second.remainder, isEmpty);
    });
  });

  group('PortalEventStream (SSE)', () {
    test(
      'stalled connection attempts abort and retry SSE without losing cursor',
      () {
        fakeAsync((async) {
          final stalled = <_AbortTrackingClient>[];
          final batches = <RemotePortalEventBatch>[];
          final requests = <Uri>[];
          final stream = PortalEventStream(
            baseUrl: _base,
            headersProvider: () => const {},
            clientFactory: () {
              if (stalled.length < 2) {
                final client = _AbortTrackingClient();
                stalled.add(client);
                return client;
              }
              return MockClient((request) async {
                requests.add(request.url);
                return http.Response(
                  'event: batch\ndata: '
                  '${_batchJson(nextCursor: 8, connectionStatus: 'ended')}\n\n',
                  200,
                );
              });
            },
          );
          final subscription = stream
              .subscribe(sessionId: 'sess-1', initialCursor: 7)
              .listen(batches.add);
          // Two 15-second connect timeouts and their 4 and 8-second steps.
          async.elapse(const Duration(seconds: 45));
          expect(stalled, hasLength(2));
          expect(stalled.every((client) => client.aborted.isCompleted), isTrue);
          expect(requests.first.path, endsWith('/events/stream'));
          expect(requests.first.queryParameters['after'], '7');
          expect(batches.first.nextCursor, 8);
          subscription.cancel();
          async.flushMicrotasks();
          expect(async.pendingTimers, isEmpty);
        });
      },
    );

    test(
      'silent SSE bodies reconnect from the last delivered cursor',
      () async {
        final bodies = <StreamController<List<int>>>[];
        final requests = <Uri>[];
        final reconnected = Completer<void>();
        final client = MockClient.streaming((request, _) async {
          requests.add(request.url);
          final body = StreamController<List<int>>();
          bodies.add(body);
          if (bodies.length == 1) {
            body.add(
              utf8.encode(
                'event: batch\ndata: ${_batchJson(nextCursor: 9)}\n\n',
              ),
            );
          } else {
            reconnected.complete();
          }
          return http.StreamedResponse(body.stream, 200);
        });
        final subscription = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {},
          clientFactory: () => client,
          sseIdleTimeout: const Duration(milliseconds: 20),
          wait: (_) async {},
        ).subscribe(sessionId: 'sess-1').listen((_) {});
        await reconnected.future.timeout(const Duration(seconds: 2));
        expect(requests, hasLength(2));
        expect(requests.last.queryParameters['after'], '9');
        expect(bodies.first.hasListener, isFalse);
        await subscription.cancel();
        for (final body in bodies) {
          await body.close();
        }
      },
    );

    test('keepalive bytes keep an idle SSE connection alive', () {
      fakeAsync((async) {
        final body = StreamController<List<int>>();
        var requests = 0;
        final client = MockClient.streaming((request, _) async {
          requests++;
          return http.StreamedResponse(body.stream, 200);
        });
        final subscription = _stream(
          client,
        ).subscribe(sessionId: 'sess-1').listen((_) {});
        for (var i = 0; i < 6; i++) {
          async.elapse(const Duration(seconds: 10));
          body.add(utf8.encode(': keepalive\n\n'));
          async.flushMicrotasks();
        }
        expect(requests, 1);
        subscription.cancel();
        body.close();
        async.flushMicrotasks();
      });
    });

    test('delivers batches split across chunks and resumes the cursor', () async {
      final sseRequests = <Uri>[];
      final client = MockClient.streaming((request, bodyStream) async {
        expect(request.headers['Accept'], 'text/event-stream');
        expect(request.headers['Authorization'], 'Bearer token-1');
        sseRequests.add(request.url);
        if (sseRequests.length > 1) {
          // Hold the reconnect open with an empty, never-ending stream so the
          // test can cancel deterministically after the first connection.
          return http.StreamedResponse(
            StreamController<List<int>>().stream,
            200,
          );
        }
        final frame1 =
            'event: batch\ndata: ${_batchJson(nextCursor: 7, events: [_chatEnvelope('msg-1')])}\n\n';
        final frame2 = 'event: batch\ndata: ${_batchJson(nextCursor: 9)}\n\n';
        final whole = frame1 + frame2;
        // Split mid-frame to exercise buffer carry-over.
        final chunks = [
          whole.substring(0, 25),
          whole.substring(25, frame1.length + 10),
          whole.substring(frame1.length + 10),
        ];
        return http.StreamedResponse(
          Stream.fromIterable(chunks.map(utf8.encode)),
          200,
        );
      });

      final batches = <RemotePortalEventBatch>[];
      final subscription = _stream(
        client,
      ).subscribe(sessionId: 'sess-1', initialCursor: 3).listen(batches.add);

      await Future<void>.delayed(const Duration(milliseconds: 50));
      await subscription.cancel();

      expect(batches, hasLength(2));
      expect(batches.first.nextCursor, 7);
      expect(batches.first.events.single, isA<RemoteChatMessageEvent>());
      expect(batches.last.nextCursor, 9);
      expect(sseRequests.first.queryParameters['after'], '3');
      // The reconnect resumes from the last delivered cursor.
      expect(sseRequests[1].queryParameters['after'], '9');
    });

    test(
      'closes with a synthetic ended batch on a terminal error frame',
      () async {
        final client = MockClient.streaming((request, bodyStream) async {
          const frame = 'event: error\ndata: {"status":403}\n\n';
          return http.StreamedResponse(Stream.value(utf8.encode(frame)), 200);
        });

        final batches = await _stream(
          client,
        ).subscribe(sessionId: 'sess-1').toList();

        expect(batches, hasLength(1));
        expect(batches.single.events.single, isA<RemoteSessionEndedEvent>());
        expect(
          batches.single.connectionStatus,
          RemotePortalConnectionStatus.ended,
        );
      },
    );

    test('401 on the SSE route is terminal', () async {
      final client = MockClient.streaming(
        (request, bodyStream) async =>
            http.StreamedResponse(const Stream.empty(), 401),
      );

      final batches = await _stream(
        client,
      ).subscribe(sessionId: 'sess-1').toList();

      expect(batches.single.events.single, isA<RemoteSessionEndedEvent>());
    });

    test('retries SSE when the terminal confirmation probe stalls', () async {
      var sseAttempts = 0;
      final retried = Completer<void>();
      final stalledProbe = Completer<bool>();
      final client = MockClient.streaming((request, bodyStream) async {
        sseAttempts += 1;
        if (sseAttempts == 1) {
          return http.StreamedResponse(const Stream.empty(), 401);
        }
        if (!retried.isCompleted) retried.complete();
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      });

      final subscription =
          PortalEventStream(
                baseUrl: _base,
                headersProvider: () => const {
                  'Authorization': 'Bearer token-1',
                },
                clientFactory: () => client,
                retryDelay: Duration.zero,
                confirmationTimeout: const Duration(milliseconds: 10),
                wait: (_) async {},
              )
              .subscribe(
                sessionId: 'sess-1',
                confirmSessionEnded: (_) => stalledProbe.future,
              )
              .listen((_) {});

      await retried.future.timeout(const Duration(seconds: 1));
      await subscription.cancel();

      expect(sseAttempts, 2);
    });

    test('aborts a stalled terminal confirmation probe on timeout', () async {
      var sseAttempts = 0;
      final retried = Completer<void>();
      final confirmationClient = _AbortTrackingClient();
      final eventClient = MockClient.streaming((request, bodyStream) async {
        sseAttempts += 1;
        if (sseAttempts == 1) {
          return http.StreamedResponse(const Stream.empty(), 401);
        }
        if (!retried.isCompleted) retried.complete();
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      });

      final subscription =
          PortalEventStream(
                baseUrl: _base,
                headersProvider: () => const {
                  'Authorization': 'Bearer token-1',
                },
                clientFactory: () => eventClient,
                confirmationClientFactory: () => confirmationClient,
                retryDelay: Duration.zero,
                confirmationTimeout: const Duration(milliseconds: 10),
                wait: (_) async {},
              )
              .subscribe(
                sessionId: 'sess-1',
                confirmSessionEnded: (client) async {
                  await client.get(Uri.parse('$_base/session'));
                  return false;
                },
              )
              .listen((_) {});

      await confirmationClient.started.future.timeout(
        const Duration(seconds: 1),
      );
      await confirmationClient.aborted.future.timeout(
        const Duration(seconds: 1),
      );
      await retried.future.timeout(const Duration(seconds: 1));
      await subscription.cancel();

      expect(sseAttempts, 2);
    });

    test(
      'aborts a stalled terminal confirmation probe on cancellation',
      () async {
        final confirmationClient = _AbortTrackingClient();
        final eventClient = MockClient.streaming(
          (request, bodyStream) async =>
              http.StreamedResponse(const Stream.empty(), 401),
        );

        final subscription =
            PortalEventStream(
                  baseUrl: _base,
                  headersProvider: () => const {
                    'Authorization': 'Bearer token-1',
                  },
                  clientFactory: () => eventClient,
                  confirmationClientFactory: () => confirmationClient,
                  confirmationTimeout: const Duration(seconds: 30),
                )
                .subscribe(
                  sessionId: 'sess-1',
                  confirmSessionEnded: (client) async {
                    await client.get(Uri.parse('$_base/session'));
                    return false;
                  },
                )
                .listen((_) {});

        await confirmationClient.started.future.timeout(
          const Duration(seconds: 1),
        );
        await subscription.cancel();
        await confirmationClient.aborted.future.timeout(
          const Duration(seconds: 1),
        );
      },
    );

    test('an oversized frame on a healthy keepalive stream demotes to '
        'long-poll at once', () async {
      var fakeNow = DateTime.utc(2026, 8, 18);
      var sseAttempts = 0;
      var polls = 0;
      final client = MockClient.streaming((request, bodyStream) async {
        if (request.url.path.endsWith('/events/stream')) {
          sseAttempts += 1;
          // Keepalives flow past the healthy-lifetime threshold, then a
          // frame larger than the accumulation cap arrives. The oversized
          // frame recurs at the same cursor on every reconnect, so the
          // stream demotes even though it otherwise looks healthy.
          Stream<List<int>> body() async* {
            yield utf8.encode(': keepalive\n\n');
            fakeNow = fakeNow.add(const Duration(seconds: 15));
            yield utf8.encode(
              'data: ${List.filled(kMaxPortalSseBufferChars, 'x').join()}',
            );
          }

          return http.StreamedResponse(body(), 200);
        }
        polls += 1;
        if (polls == 1) {
          // Long-poll has no frame cap: the batch the stream could not
          // carry is delivered here.
          return http.StreamedResponse(
            Stream.value(utf8.encode(_batchJson(nextCursor: 21))),
            200,
          );
        }
        return http.StreamedResponse(const Stream.empty(), 403);
      });

      final batches = await PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {'Authorization': 'Bearer token-1'},
        clientFactory: () => client,
        // The SSE re-probe waits its first paced step; the poll is instant.
        now: () => fakeNow,
        wait: (_) async {},
      ).subscribe(sessionId: 'sess-1').toList();

      expect(sseAttempts, 1);
      expect(batches, hasLength(2));
      expect(batches.first.nextCursor, 21);
      expect(batches.last.events.single, isA<RemoteSessionEndedEvent>());
    });

    test('rejects an SSE frame that exceeds the accumulation cap', () async {
      var sseRequests = 0;
      final client = MockClient.streaming((request, bodyStream) async {
        if (request.url.path.endsWith('/events/stream')) {
          sseRequests += 1;
          final oversized =
              'event: batch\ndata: ${List.filled(kMaxPortalSseBufferChars, 'x').join()}';
          return http.StreamedResponse(
            Stream.value(utf8.encode(oversized)),
            200,
          );
        }
        // The long-poll fallback takes over at once.
        return http.StreamedResponse(const Stream.empty(), 404);
      });

      final batches = await _stream(
        client,
      ).subscribe(sessionId: 'sess-1').toList();

      expect(sseRequests, 1);
      expect(batches, hasLength(1));
      expect(batches.single.events.single, isA<RemoteSessionEndedEvent>());
    });
  });

  group('PortalEventStream (large frames, CAN-3372)', () {
    // A chat snapshot carries up to ~600 KiB in one batch. Decoding it inside
    // the chunk callback freezes the UI isolate, so a turn of the event loop
    // queued before the frame arrives must get to run before the decoded
    // batch is delivered. Small frames stay inline and are delivered first.
    final large = chatSnapshotBatchJson(targetChars: snapshot600KiBChars);

    Future<bool> turnRanBeforeDelivery(
      void Function(void Function() queueTurn) deliver,
      Stream<RemotePortalEventBatch> batches,
    ) async {
      var turnRan = false;
      final observed = Completer<bool>();
      final subscription = batches.listen((batch) {
        if (!observed.isCompleted) observed.complete(turnRan);
      });
      deliver(() => Timer.run(() => turnRan = true));
      final result = await observed.future.timeout(const Duration(seconds: 5));
      await subscription.cancel();
      return result;
    }

    test(
      'an SSE batch above the threshold does not block the event loop',
      () async {
        final body = StreamController<List<int>>();
        final connected = Completer<void>();
        final client = MockClient.streaming((request, _) async {
          if (!connected.isCompleted) connected.complete();
          return http.StreamedResponse(body.stream, 200);
        });
        final batches = _stream(client).subscribe(sessionId: 'sess-1');

        final turnFirst = await turnRanBeforeDelivery((queueTurn) async {
          await connected.future;
          await pumpEventQueue();
          queueTurn();
          body.add(utf8.encode(sseFrame(large)));
        }, batches);

        expect(
          turnFirst,
          isTrue,
          reason:
              'the ${large.length}-character batch was decoded inside the '
              'chunk callback, blocking the event loop',
        );
        await body.close();
      },
    );

    test(
      'a long-poll body above the threshold does not block the event loop',
      () async {
        void Function()? queueTurn;
        var polls = 0;
        final client = MockClient.streaming((request, _) async {
          if (request.url.path.endsWith('/events/stream')) {
            return http.StreamedResponse(const Stream.empty(), 404);
          }
          polls += 1;
          if (polls > 1) {
            return http.StreamedResponse(
              StreamController<List<int>>().stream,
              200,
            );
          }
          // Queue the turn as the response arrives.
          queueTurn!();
          return http.StreamedResponse(
            Stream.value(utf8.encode(large)),
            200,
            headers: const {'content-type': 'application/json'},
          );
        });
        final batches = _stream(client).subscribe(sessionId: 'sess-1');

        final turnFirst = await turnRanBeforeDelivery(
          (queue) => queueTurn = queue,
          batches,
        );

        expect(
          turnFirst,
          isTrue,
          reason:
              'the ${large.length}-character poll body was decoded in the '
              'response callback, blocking the event loop',
        );
      },
    );

    test('a small SSE batch stays inline ahead of a queued turn', () async {
      final body = StreamController<List<int>>();
      final connected = Completer<void>();
      final client = MockClient.streaming((request, _) async {
        if (!connected.isCompleted) connected.complete();
        return http.StreamedResponse(body.stream, 200);
      });
      final batches = _stream(client).subscribe(sessionId: 'sess-1');

      final turnFirst = await turnRanBeforeDelivery((queueTurn) async {
        await connected.future;
        await pumpEventQueue();
        queueTurn();
        body.add(
          utf8.encode(sseFrame(streamingMessageBatchJson(nextCursor: 3))),
        );
      }, batches);

      expect(turnFirst, isFalse);
      await body.close();
    });

    test('maps a large snapshot batch to the same models', () async {
      final client = MockClient.streaming(
        (request, _) async => http.StreamedResponse(
          Stream.fromIterable(
            chunkText(sseFrame(large), 16 * 1024).map(utf8.encode),
          ),
          200,
        ),
      );
      final batch = await _stream(client).subscribe(sessionId: 'sess-1').first;

      expect(batch.nextCursor, 100);
      expect(batch.connectionStatus, RemotePortalConnectionStatus.active);
      final snapshot = batch.events.first as RemoteStateSnapshotEvent;
      expect(snapshot.chatMessages, hasLength(300));
      expect(snapshot.chatMessages.first.messageId, 'msg-0');
      expect(
        snapshot.chatMessages.first.attachments.single.filename,
        'log-0.txt',
      );
      expect(snapshot.chatMessages[1].parts.single.toolName, 'Bash');
      expect(snapshot.chatMessages[3].text, contains('café ✓'));
      expect(snapshot.targetChatId, workloadChatId);
      expect(snapshot.chatSummaries.single.chatId, workloadChatId);
      expect(snapshot.prStatuses.keys, [
        '$workloadWorkspaceId:$workloadWorktreeId',
      ]);
      expect(batch.events[1], isA<RemotePipelineRunEvent>());
      expect(batch.events[2], isA<RemoteUnknownPortalEvent>());
    });

    test('mixed large and small batches keep their order and cursor', () async {
      final requests = <Uri>[];
      final secondBody = StreamController<List<int>>();
      final client = MockClient.streaming((request, _) async {
        requests.add(request.url);
        if (requests.length > 1) {
          return http.StreamedResponse(secondBody.stream, 200);
        }
        Stream<List<int>> body() async* {
          // Large, small and large in one chunk, then a small and a large
          // frame in back-to-back chunks.
          yield utf8.encode(
            sseFrame(
                  chatSnapshotBatchJson(
                    messages: 24,
                    targetChars: 100 * 1024,
                    nextCursor: 10,
                  ),
                ) +
                sseFrame(streamingMessageBatchJson(nextCursor: 11)) +
                sseFrame(
                  chatSnapshotBatchJson(
                    messages: 24,
                    targetChars: 300 * 1024,
                    nextCursor: 12,
                  ),
                ),
          );
          yield utf8.encode(
            sseFrame(streamingMessageBatchJson(nextCursor: 13)),
          );
          yield utf8.encode(
            sseFrame(
              chatSnapshotBatchJson(
                messages: 24,
                targetChars: 200 * 1024,
                nextCursor: 14,
              ),
            ),
          );
          yield utf8.encode(
            sseFrame(streamingMessageBatchJson(nextCursor: 15)),
          );
        }

        return http.StreamedResponse(body(), 200);
      });
      final cursors = <int>[];
      final reconnected = Completer<void>();
      final subscription = _stream(client)
          .subscribe(sessionId: 'sess-1', initialCursor: 9)
          .listen((batch) {
            cursors.add(batch.nextCursor);
            if (cursors.length == 6) reconnected.complete();
          });

      await reconnected.future.timeout(const Duration(seconds: 5));
      await pumpEventQueue();
      await subscription.cancel();
      await secondBody.close();

      expect(cursors, [10, 11, 12, 13, 14, 15]);
      expect(requests.first.queryParameters['after'], '9');
      expect(requests.last.queryParameters['after'], '15');
    });

    test('an error frame after a large batch still ends the session', () async {
      final client = MockClient.streaming(
        (request, _) async => http.StreamedResponse(
          Stream.value(
            utf8.encode(
              sseFrame(
                    chatSnapshotBatchJson(
                      messages: 24,
                      targetChars: 200 * 1024,
                      nextCursor: 4,
                    ),
                  ) +
                  sseFrame('{"status":403}', event: 'error'),
            ),
          ),
          200,
        ),
      );

      final batches = await _stream(
        client,
      ).subscribe(sessionId: 'sess-1').toList();

      expect(batches.map((batch) => batch.nextCursor), [4, 4]);
      expect(batches.last.events.single, isA<RemoteSessionEndedEvent>());
    });

    test(
      'a malformed large batch is skipped and the next frame delivers',
      () async {
        final body = StreamController<List<int>>();
        final client = MockClient.streaming(
          (request, _) async => http.StreamedResponse(body.stream, 200),
        );
        final batches = <RemotePortalEventBatch>[];
        final delivered = Completer<void>();
        final subscription = _stream(client)
            .subscribe(sessionId: 'sess-1')
            .listen((batch) {
              batches.add(batch);
              delivered.complete();
            });
        final truncated = large.substring(0, large.length - 1);
        body.add(
          utf8.encode(
            sseFrame(truncated) +
                sseFrame(streamingMessageBatchJson(nextCursor: 7)),
          ),
        );

        await delivered.future.timeout(const Duration(seconds: 5));
        await subscription.cancel();
        await body.close();

        expect(batches.single.nextCursor, 7);
      },
    );

    test('UTF-8 sequences split across network chunks decode intact', () async {
      final frame = utf8.encode(
        '${sseFrame(streamingMessageBatchJson(nextCursor: 2, text: 'é✓🙂\r'))}'
        '\r\n',
      );
      for (var cut = 1; cut < frame.length; cut++) {
        final client = MockClient.streaming(
          (request, _) async => http.StreamedResponse(
            Stream.fromIterable([frame.sublist(0, cut), frame.sublist(cut)]),
            200,
          ),
        );
        final batch = await _stream(
          client,
        ).subscribe(sessionId: 'sess-1').first;
        final event = batch.events.single as RemoteChatMessageEvent;
        expect(event.message.text, 'é✓🙂\r', reason: 'split at byte $cut');
      }
    });

    test(
      'parser cost grows linearly with frame size in 1 KiB chunks',
      () async {
        // Re-scanning the whole buffer per chunk makes 4x the bytes cost ~16x
        // the time; an incremental parser costs ~4x. Inert frames are parsed
        // but never decoded, so this times the parser alone.
        Future<int> parseMicros(int dataChars) async {
          final body = StreamController<List<int>>();
          final client = MockClient.streaming(
            (request, _) async => http.StreamedResponse(body.stream, 200),
          );
          final done = Completer<void>();
          final subscription = _stream(client)
              .subscribe(sessionId: 'sess-1')
              .listen((_) {
                done.complete();
              });
          final text =
              inertSseFrame(dataChars) +
              sseFrame(streamingMessageBatchJson(nextCursor: 1));
          final chunks = chunkText(text, 1024).map(utf8.encode).toList();
          await pumpEventQueue();
          final clock = Stopwatch()..start();
          chunks.forEach(body.add);
          await done.future.timeout(const Duration(seconds: 30));
          final micros = clock.elapsedMicroseconds;
          await subscription.cancel();
          await body.close();
          return micros;
        }

        Future<int> fastest(int dataChars) async {
          var best = 1 << 62;
          for (var i = 0; i < 3; i++) {
            final micros = await parseMicros(dataChars);
            if (micros < best) best = micros;
          }
          return best;
        }

        await fastest(64 * 1024); // Warm up.
        final small = await fastest(128 * 1024);
        final big = await fastest(512 * 1024);
        final ratio = big / small;

        expect(
          ratio,
          lessThan(8),
          reason:
              '4x the bytes took ${ratio.toStringAsFixed(1)}x the time '
              '(${small}us -> ${big}us)',
        );
      },
    );
  });

  group('PortalEventStream (decode coordination)', () {
    String largeFrame(int cursor) => sseFrame(
      chatSnapshotBatchJson(messages: 2, targetChars: 4096, nextCursor: cursor),
    );
    String smallFrame(int cursor) =>
        sseFrame(streamingMessageBatchJson(nextCursor: cursor));

    test('a pending large decode holds back every later frame', () async {
      final runner = _GatedRunner();
      final body = StreamController<List<int>>();
      final client = MockClient.streaming(
        (request, _) async => http.StreamedResponse(body.stream, 200),
      );
      final cursors = <int>[];
      final subscription = _gatedStream(client, runner)
          .subscribe(sessionId: 'sess-1')
          .listen((batch) => cursors.add(batch.nextCursor));

      body.add(utf8.encode(largeFrame(10) + smallFrame(11) + largeFrame(12)));
      await pumpEventQueue();
      body.add(utf8.encode(smallFrame(13)));
      await pumpEventQueue();
      // Only the first decode has started; nothing overtook it.
      expect(runner.gates, hasLength(1));
      expect(cursors, isEmpty);

      await runner.release(0);
      expect(cursors, [10, 11]);
      expect(runner.gates, hasLength(2));

      await runner.release(1);
      expect(cursors, [10, 11, 12, 13]);
      await subscription.cancel();
      await body.close();
    });

    test('cancelling during a large SSE decode drops its result', () async {
      final runner = _GatedRunner();
      final body = StreamController<List<int>>();
      final client = _TrackingClient(
        MockClient.streaming(
          (request, _) async => http.StreamedResponse(body.stream, 200),
        ),
      );
      final batches = <RemotePortalEventBatch>[];
      final live = <bool>[];
      final subscription = _gatedStream(client, runner)
          .subscribe(sessionId: 'sess-1', onLiveChanged: live.add)
          .listen(batches.add);
      body.add(utf8.encode(largeFrame(10)));
      await pumpEventQueue();
      expect(runner.gates, hasLength(1));

      await subscription.cancel();
      // The socket closes now, without waiting for the decode.
      expect(client.closed, isTrue);
      body.add(utf8.encode(smallFrame(11)));
      await runner.release(0);

      expect(batches, isEmpty);
      expect(live, [true]);
      expect(client.requests, hasLength(1));
      await body.close();
    });

    test(
      'cancelling during a large long-poll decode drops its result',
      () async {
        final runner = _GatedRunner();
        final client = _TrackingClient(
          MockClient.streaming((request, _) async {
            if (request.url.path.endsWith('/events/stream')) {
              return http.StreamedResponse(const Stream.empty(), 404);
            }
            return http.StreamedResponse(
              Stream.value(
                utf8.encode(
                  chatSnapshotBatchJson(
                    messages: 2,
                    targetChars: 4096,
                    nextCursor: 10,
                  ),
                ),
              ),
              200,
            );
          }),
        );
        final batches = <RemotePortalEventBatch>[];
        final subscription = _gatedStream(
          client,
          runner,
        ).subscribe(sessionId: 'sess-1').listen(batches.add);
        await pumpEventQueue();
        expect(runner.gates, hasLength(1));

        await subscription.cancel();
        await runner.release(0);

        expect(batches, isEmpty);
        // SSE probe plus the one poll: no retry after cancellation.
        expect(client.requests, hasLength(2));
      },
    );

    test(
      'a decode that fails to run is retried from the same cursor',
      () async {
        // Isolate.run throws when the worker cannot start or its result cannot
        // be sent back. The frame is not skipped: the connection is treated
        // as dropped and the next one resumes from the last delivered cursor.
        var runs = 0;
        Future<R> failFirst<R>(
          FutureOr<R> Function() computation, {
          String? debugName,
        }) async {
          if (runs++ == 0) throw IsolateSpawnException('no isolate');
          return computation();
        }

        final requests = <Uri>[];
        // The second connection stays open, so the stream does not cycle.
        final open = StreamController<List<int>>();
        final client = MockClient.streaming((request, _) async {
          requests.add(request.url);
          final frames = utf8.encode(largeFrame(10) + smallFrame(11));
          if (requests.length == 1) {
            return http.StreamedResponse(Stream.value(frames), 200);
          }
          open.add(frames);
          return http.StreamedResponse(open.stream, 200);
        });
        final cursors = <int>[];
        final subscription =
            PortalEventStream(
                  baseUrl: _base,
                  headersProvider: () => const {},
                  clientFactory: () => client,
                  retryDelay: Duration.zero,
                  wait: (_) async {},
                  decoder: PortalEventDecoder(
                    offloadThreshold: 1024,
                    runner: failFirst,
                  ),
                )
                .subscribe(sessionId: 'sess-1', initialCursor: 7)
                .listen((batch) => cursors.add(batch.nextCursor));
        await pumpEventQueue();

        // The failed decode also held back the small frame behind it.
        expect(cursors, [10, 11]);
        expect(requests.first.queryParameters['after'], '7');
        expect(requests, hasLength(2));
        expect(requests[1].queryParameters['after'], '7');
        await subscription.cancel();
        await open.close();
      },
    );

    test(
      'a decode that outlives its stream resumes from its own cursor',
      () async {
        final runner = _GatedRunner();
        final requests = <Uri>[];
        final held = StreamController<List<int>>();
        final client = MockClient.streaming((request, _) async {
          requests.add(request.url);
          if (requests.length > 1) {
            return http.StreamedResponse(held.stream, 200);
          }
          // The server closes right after a large frame.
          return http.StreamedResponse(
            Stream.value(utf8.encode(smallFrame(5) + largeFrame(10))),
            200,
          );
        });
        final cursors = <int>[];
        final subscription = _gatedStream(client, runner)
            .subscribe(sessionId: 'sess-1')
            .listen((batch) => cursors.add(batch.nextCursor));
        await pumpEventQueue();
        expect(cursors, [5]);
        expect(requests, hasLength(1));

        await runner.release(0);

        expect(cursors, [5, 10]);
        expect(requests.last.queryParameters['after'], '10');
        await subscription.cancel();
        await held.close();
      },
    );
  });

  group('PortalEventStream (reconnect backoff)', () {
    test(
      'backs off exponentially when delivered streams keep dying young',
      () async {
        const shortStreams = 8;
        var connections = 0;
        final waits = <Duration>[];
        final parked = Completer<void>();
        final client = MockClient.streaming((request, bodyStream) async {
          connections += 1;
          if (connections > shortStreams) {
            if (!parked.isCompleted) parked.complete();
            return http.StreamedResponse(
              StreamController<List<int>>().stream,
              200,
            );
          }
          // Delivers one batch, then dies immediately — the CAN-2358 churn
          // signature (an intermediary cutting streams per batch).
          final frame =
              'event: batch\ndata: ${_batchJson(nextCursor: connections)}\n\n';
          return http.StreamedResponse(Stream.value(utf8.encode(frame)), 200);
        });

        final subscription = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {'Authorization': 'Bearer token-1'},
          clientFactory: () => client,
          retryDelay: Duration.zero,
          // Pin jitter to the top of the 50-100% window so the recorded
          // delays equal the raw exponential values.
          random: () => 1.0,
          wait: (delay) async {
            waits.add(delay);
          },
        ).subscribe(sessionId: 'sess-1').listen((_) {});

        await parked.future;
        await subscription.cancel();

        expect(waits.map((w) => w.inMilliseconds).toList(), [
          250,
          500,
          1000,
          2000,
          4000,
          8000,
          8000,
          8000,
        ]);
      },
    );

    test('jitter scales the backoff down to 50% of the exponential', () async {
      var connections = 0;
      final waits = <Duration>[];
      final parked = Completer<void>();
      final client = MockClient.streaming((request, bodyStream) async {
        connections += 1;
        if (connections > 2) {
          if (!parked.isCompleted) parked.complete();
          return http.StreamedResponse(
            StreamController<List<int>>().stream,
            200,
          );
        }
        final frame =
            'event: batch\ndata: ${_batchJson(nextCursor: connections)}\n\n';
        return http.StreamedResponse(Stream.value(utf8.encode(frame)), 200);
      });

      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {'Authorization': 'Bearer token-1'},
        clientFactory: () => client,
        retryDelay: Duration.zero,
        random: () => 0.0,
        wait: (delay) async {
          waits.add(delay);
        },
      ).subscribe(sessionId: 'sess-1').listen((_) {});

      await parked.future;
      await subscription.cancel();

      expect(waits.map((w) => w.inMilliseconds).toList(), [125, 250]);
    });

    test('a healthy long-lived stream resets the backoff streak', () async {
      var fakeNow = DateTime.utc(2026, 8, 18);
      var connections = 0;
      final waits = <Duration>[];
      final parked = Completer<void>();
      final client = MockClient.streaming((request, bodyStream) async {
        connections += 1;
        if (connections >= 4) {
          if (!parked.isCompleted) parked.complete();
          return http.StreamedResponse(
            StreamController<List<int>>().stream,
            200,
          );
        }
        final frame =
            'event: batch\ndata: ${_batchJson(nextCursor: connections)}\n\n';
        if (connections == 2) {
          // Delivers, then survives well past the healthy-lifetime threshold
          // before closing.
          Stream<List<int>> body() async* {
            yield utf8.encode(frame);
            fakeNow = fakeNow.add(const Duration(seconds: 15));
          }

          return http.StreamedResponse(body(), 200);
        }
        return http.StreamedResponse(Stream.value(utf8.encode(frame)), 200);
      });

      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {'Authorization': 'Bearer token-1'},
        clientFactory: () => client,
        retryDelay: Duration.zero,
        now: () => fakeNow,
        random: () => 1.0,
        wait: (delay) async {
          waits.add(delay);
        },
      ).subscribe(sessionId: 'sess-1').listen((_) {});

      await parked.future;
      await subscription.cancel();

      // Connection 1 (short) backs off at streak 1; connection 2 (healthy)
      // reconnects immediately and resets the streak; connection 3 (short)
      // starts over at streak 1 instead of escalating.
      expect(waits.map((w) => w.inMilliseconds).toList(), [250, 250]);
    });

    test(
      'keepalive-only streams stay on SSE instead of demoting to long-poll',
      () async {
        var fakeNow = DateTime.utc(2026, 8, 18);
        var connections = 0;
        final parked = Completer<void>();
        final batchController = StreamController<List<int>>();
        final client = MockClient.streaming((request, bodyStream) async {
          if (!request.url.path.endsWith('/events/stream')) {
            fail('long-poll must not be used while SSE keepalives flow');
          }
          connections += 1;
          if (connections <= 3) {
            // A healthy idle desktop: server keepalive comments flow but no
            // batch is ever delivered before the stream is cut.
            Stream<List<int>> body() async* {
              yield utf8.encode(': keepalive\n\n');
              fakeNow = fakeNow.add(const Duration(seconds: 15));
            }

            return http.StreamedResponse(body(), 200);
          }
          // The fourth connection finally carries data — still over SSE.
          batchController.add(
            utf8.encode(
              'event: batch\ndata: ${_batchJson(nextCursor: 12)}\n\n',
            ),
          );
          if (!parked.isCompleted) parked.complete();
          return http.StreamedResponse(batchController.stream, 200);
        });

        final batches = <RemotePortalEventBatch>[];
        final subscription = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {'Authorization': 'Bearer token-1'},
          clientFactory: () => client,
          retryDelay: Duration.zero,
          now: () => fakeNow,
          wait: (_) async {},
        ).subscribe(sessionId: 'sess-1').listen(batches.add);

        await parked.future;
        await Future<void>.delayed(const Duration(milliseconds: 20));
        await subscription.cancel();

        expect(connections, greaterThan(3));
        expect(batches, hasLength(1));
        expect(batches.single.nextCursor, 12);
      },
    );
  });

  group('PortalEventStream (long-poll fallback)', () {
    test('stalled long polls abort and retry from the same cursor', () {
      fakeAsync((async) {
        final stalled = _AbortTrackingClient();
        var clients = 0;
        final batches = <RemotePortalEventBatch>[];
        final stream = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {},
          clientFactory: () {
            clients++;
            if (clients == 1) {
              return MockClient((_) async => http.Response('', 404));
            }
            if (clients == 2) return stalled;
            return MockClient((request) async {
              expect(request.url.queryParameters['after'], '7');
              return http.Response(
                _batchJson(nextCursor: 8, connectionStatus: 'ended'),
                200,
              );
            });
          },
        );
        final subscription = stream
            .subscribe(sessionId: 'sess-1', initialCursor: 7)
            .listen(batches.add);
        // The 35-second poll bound, then the first 4-second outage step.
        async.elapse(const Duration(seconds: 45));
        expect(stalled.aborted.isCompleted, isTrue);
        expect(batches.single.nextCursor, 8);
        subscription.cancel();
        async.flushMicrotasks();
      });
    });

    test('falls back to long-poll when the SSE route 404s', () async {
      var polls = 0;
      final client = MockClient.streaming((request, bodyStream) async {
        if (request.url.path.endsWith('/events/stream')) {
          return http.StreamedResponse(const Stream.empty(), 404);
        }
        expect(request.url.path.endsWith('/events'), isTrue);
        polls += 1;
        if (polls == 1) {
          expect(request.url.queryParameters['after'], '0');
          expect(request.url.queryParameters['timeoutMs'], '25000');
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                _batchJson(nextCursor: 5, events: [_chatEnvelope('msg-2')]),
              ),
            ),
            200,
          );
        }
        expect(request.url.queryParameters['after'], '5');
        // Second poll reports the session gone.
        return http.StreamedResponse(const Stream.empty(), 404);
      });

      final batches = await _stream(
        client,
      ).subscribe(sessionId: 'sess-1').toList();

      expect(batches, hasLength(2));
      expect(batches.first.nextCursor, 5);
      expect(batches.first.events.single, isA<RemoteChatMessageEvent>());
      expect(batches.last.events.single, isA<RemoteSessionEndedEvent>());
    });

    test(
      'backs off after a successful poll reports the desktop inactive',
      () async {
        var polls = 0;
        final client = MockClient.streaming((request, bodyStream) async {
          if (request.url.path.endsWith('/events/stream')) {
            // Force the long-poll fallback.
            return http.StreamedResponse(const Stream.empty(), 404);
          }
          polls += 1;
          // Yield to the timer queue each poll so an unfixed tight loop cannot
          // starve the cancel timer below — it fails cleanly with polls > 1
          // instead of busy-spinning forever.
          await Future<void>.delayed(const Duration(milliseconds: 1));
          // An inactive session returns from the server immediately (it does
          // not hold the long-poll open), so re-polling with no gap would
          // tight-loop.
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                _batchJson(nextCursor: 0, connectionStatus: 'inactive'),
              ),
            ),
            200,
          );
        });

        final batches = <RemotePortalEventBatch>[];
        final subscription = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {'Authorization': 'Bearer token-1'},
          clientFactory: () => client,
          // A long retry delay: with the backoff the loop parks here after the
          // first inactive poll; a tight loop would ignore it.
          retryDelay: const Duration(seconds: 30),
        ).subscribe(sessionId: 'sess-1').listen(batches.add);

        await Future<void>.delayed(const Duration(milliseconds: 50));
        await subscription.cancel();

        expect(polls, 1);
        expect(
          batches.last.connectionStatus,
          RemotePortalConnectionStatus.inactive,
        );
      },
    );

    test(
      'repeated zero-delivery SSE drops never demote to long-poll',
      () async {
        var sseAttempts = 0;
        var polls = 0;
        final client = MockClient.streaming((request, bodyStream) async {
          if (!request.url.path.endsWith('/events/stream')) {
            polls += 1;
            return http.StreamedResponse(const Stream.empty(), 403);
          }
          sseAttempts += 1;
          // Connects fine but dies without ever delivering a batch, as during
          // a network change; the fourth attempt reports the session gone.
          return http.StreamedResponse(
            const Stream.empty(),
            sseAttempts > 3 ? 403 : 200,
          );
        });

        final batches = await _stream(
          client,
        ).subscribe(sessionId: 'sess-1').toList();

        expect(sseAttempts, 4);
        expect(polls, 0);
        expect(batches.single.events.single, isA<RemoteSessionEndedEvent>());
      },
    );
  });

  group('PortalEventStream (wake and teardown, CAN-4873)', () {
    test('an active batch resets the outage backoff even when the same '
        'stream later reports the desktop inactive', () async {
      final waits = <Duration>[];
      final parked = Completer<void>();
      var connections = 0;
      String frame(int cursor, String status) =>
          'event: batch\ndata: '
          '${_batchJson(nextCursor: cursor, connectionStatus: status)}\n\n';
      final client = MockClient.streaming((request, _) async {
        connections += 1;
        switch (connections) {
          case 1 || 2:
            return http.StreamedResponse(const Stream.empty(), 503);
          case 3:
            // The desktop answers, then sleeps again before the stream ends.
            return http.StreamedResponse(
              Stream.value(
                utf8.encode(
                  frame(1, 'active') +
                      frame(2, 'active') +
                      frame(2, 'inactive'),
                ),
              ),
              200,
            );
          case 4:
            return http.StreamedResponse(
              Stream.value(utf8.encode(frame(2, 'inactive'))),
              200,
            );
          default:
            if (!parked.isCompleted) parked.complete();
            return http.StreamedResponse(
              StreamController<List<int>>().stream,
              200,
            );
        }
      });
      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {},
        clientFactory: () => client,
        random: () => 1.0,
        wait: (delay) async => waits.add(delay),
      ).subscribe(sessionId: 'sess-1').listen((_) {});

      await parked.future;
      await subscription.cancel();

      // Two failures, then the inactive streak starts over at the first step
      // and still grows while the desktop stays asleep.
      expect(waits, const [
        Duration(seconds: 4),
        Duration(seconds: 8),
        Duration(seconds: 4),
        Duration(seconds: 8),
      ]);
    });

    test('a wake ends an outage wait and restarts the backoff', () async {
      final waits = <Duration>[];
      final pending = <Completer<void>>[];
      var attempts = 0;
      final client = MockClient.streaming((request, _) async {
        attempts += 1;
        return http.StreamedResponse(const Stream.empty(), 503);
      });
      final wake = StreamController<void>.broadcast(sync: true);
      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {},
        clientFactory: () => client,
        random: () => 1.0,
        wait: (delay) {
          waits.add(delay);
          final wait = Completer<void>();
          pending.add(wait);
          return wait.future;
        },
      ).subscribe(sessionId: 'sess-1', wake: wake.stream).listen((_) {});

      await pumpEventQueue();
      pending.last.complete();
      await pumpEventQueue();
      expect(attempts, 2);
      expect(waits, const [Duration(seconds: 4), Duration(seconds: 8)]);

      wake.add(null);
      await pumpEventQueue();

      // The 8-second wait ended at once; the next failure starts over.
      expect(attempts, 3);
      expect(waits.last, const Duration(seconds: 4));
      await subscription.cancel();
      await wake.close();
    });

    test('a wake does not cut the short-stream churn backoff', () async {
      final waits = <Duration>[];
      var attempts = 0;
      final client = MockClient.streaming((request, _) async {
        attempts += 1;
        return http.StreamedResponse(
          Stream.value(
            utf8.encode('event: batch\ndata: ${_batchJson(nextCursor: 3)}\n\n'),
          ),
          200,
        );
      });
      final wake = StreamController<void>.broadcast(sync: true);
      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {},
        clientFactory: () => client,
        random: () => 1.0,
        wait: (delay) {
          waits.add(delay);
          return Completer<void>().future;
        },
      ).subscribe(sessionId: 'sess-1', wake: wake.stream).listen((_) {});

      await pumpEventQueue();
      wake.add(null);
      await pumpEventQueue();

      expect(attempts, 1);
      expect(waits, const [Duration(milliseconds: 250)]);
      await subscription.cancel();
      await wake.close();
    });

    test('cancelling during a reconnect wait leaves no timer', () {
      fakeAsync((async) {
        var attempts = 0;
        final client = MockClient((request) async {
          attempts += 1;
          throw http.ClientException('offline');
        });
        final subscription = PortalEventStream(
          baseUrl: _base,
          headersProvider: () => const {},
          clientFactory: () => client,
        ).subscribe(sessionId: 'sess-1').listen((_) {});
        async.elapse(const Duration(seconds: 1));
        expect(attempts, 1);
        expect(async.pendingTimers, hasLength(1));

        subscription.cancel();
        async.flushMicrotasks();

        expect(async.pendingTimers, isEmpty);
        async.elapse(const Duration(minutes: 2));
        expect(attempts, 1);
      });
    });

    test('a cancelled long-poll closes its shared client once', () async {
      final created = <_CloseCountingClient>[];
      final held = Completer<http.StreamedResponse>();
      final inner = MockClient.streaming((request, _) async {
        if (request.url.path.endsWith('/events/stream')) {
          return http.StreamedResponse(const Stream.empty(), 404);
        }
        return held.future;
      });
      final subscription = PortalEventStream(
        baseUrl: _base,
        headersProvider: () => const {},
        clientFactory: () {
          final client = _CloseCountingClient(inner);
          created.add(client);
          return client;
        },
        wait: (_) async {},
      ).subscribe(sessionId: 'sess-1').listen((_) {});
      await pumpEventQueue();
      expect(created, hasLength(2));

      await subscription.cancel();
      held.complete(http.StreamedResponse(const Stream.empty(), 503));
      await pumpEventQueue();

      expect(created.map((client) => client.closes), [1, 1]);
    });
  });

  group('PortalEventStream (seeded reconnect sequences, CAN-4873)', () {
    // Random server scripts across delivery, a sleeping desktop, transient
    // failures, incompatibility fallback and wake signals. Invariants:
    //  * every request resumes from the last delivered cursor;
    //  * delivered cursors never go back;
    //  * long-poll runs only after a 404 or an oversized frame, and SSE is
    //    probed again after at most the probe streak's capped step;
    //  * a transient failure is always followed by another SSE attempt;
    //  * every wait stays within the 60-second cap;
    //  * the first outage wait after an active batch or a wake restarts at
    //    the first step, even when the same stream then reports inactive;
    //  * nothing is requested or delivered after cancellation.
    const steps = 40;
    for (var seed = 0; seed < 60; seed++) {
      test('seed $seed', () async {
        final random = math.Random(seed);
        var fakeNow = DateTime.utc(2026, 10, 24);
        var serverCursor = 10;
        var delivered = 10;
        var step = 0;
        var cancelled = false;
        var lastSse = '';
        DateTime? demotedSince;
        var sent = 10;
        var lastKind = '';
        // No outage wait since the streak last started over.
        var outageRestarted = true;
        final violations = <String>[];
        final wake = StreamController<void>.broadcast(sync: true);
        final done = Completer<void>();

        String batch(String status) {
          if (status == 'active') {
            serverCursor += 1;
            outageRestarted = true;
          }
          sent = serverCursor;
          return _batchJson(nextCursor: serverCursor, connectionStatus: status);
        }

        final client = MockClient.streaming((request, _) async {
          if (cancelled) violations.add('request after cancel');
          final after = int.parse(request.url.queryParameters['after']!);
          if (after != sent) {
            violations.add('resumed from $after, last sent $sent');
          }
          final sse = request.url.path.endsWith('/events/stream');
          if (!sse && lastSse != 'incompatible') {
            violations.add('long-poll after $lastSse');
          }
          // SSE is probed again within one capped step of the demotion.
          if (!sse &&
              fakeNow.difference(demotedSince!) >=
                  PortalEventStream.maxRetryDelay) {
            violations.add('stayed on long-poll');
          }
          step += 1;
          if (step > steps) {
            if (!done.isCompleted) done.complete();
            return http.StreamedResponse(
              StreamController<List<int>>().stream,
              200,
            );
          }
          if (random.nextInt(6) == 0) {
            outageRestarted = true;
            wake.add(null);
          }
          if (!sse) {
            lastKind = 'poll';
            fakeNow = fakeNow.add(Duration(seconds: random.nextInt(30)));
            return http.StreamedResponse(
              Stream.value(utf8.encode(batch('active'))),
              200,
            );
          }
          final kind = random.nextInt(8);
          lastKind = switch (kind) {
            0 || 1 || 2 => 'transient',
            3 || 4 => 'incompatible',
            5 => 'inactive',
            6 => 'mixed',
            _ => 'delivered',
          };
          switch (kind) {
            case 0:
              lastSse = 'transient';
              throw http.ClientException('reset');
            case 1:
              lastSse = 'transient';
              return http.StreamedResponse(const Stream.empty(), 503);
            case 2:
              lastSse = 'transient';
              return http.StreamedResponse(const Stream.empty(), 200);
            case 3:
              lastSse = 'incompatible';
              demotedSince = fakeNow;
              return http.StreamedResponse(const Stream.empty(), 404);
            case 4:
              lastSse = 'incompatible';
              demotedSince = fakeNow;
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode(
                    'data: ${List.filled(kMaxPortalSseBufferChars, 'x').join()}',
                  ),
                ),
                200,
              );
            case 5:
              lastSse = 'inactive';
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode('event: batch\ndata: ${batch('inactive')}\n\n'),
                ),
                200,
              );
            case 6:
              // The desktop answers, then sleeps again on the same stream.
              lastSse = 'inactive';
              final active = 'event: batch\ndata: ${batch('active')}\n\n';
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode(
                    '${active}event: batch\ndata: ${batch('inactive')}\n\n',
                  ),
                ),
                200,
              );
            default:
              lastSse = 'delivered';
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode('event: batch\ndata: ${batch('active')}\n\n'),
                ),
                200,
              );
          }
        });

        final batches = <RemotePortalEventBatch>[];
        final subscription =
            PortalEventStream(
                  baseUrl: _base,
                  headersProvider: () => const {},
                  clientFactory: () => client,
                  now: () => fakeNow,
                  random: random.nextDouble,
                  wait: (delay) async {
                    if (delay > PortalEventStream.maxRetryDelay) {
                      violations.add('waited $delay');
                    }
                    if (const {
                      'transient',
                      'inactive',
                      'mixed',
                    }.contains(lastKind)) {
                      if (outageRestarted &&
                          delay > const Duration(seconds: 4)) {
                        violations.add('outage kept its streak: $delay');
                      }
                      outageRestarted = false;
                    }
                    fakeNow = fakeNow.add(delay);
                  },
                )
                .subscribe(
                  sessionId: 'sess-1',
                  initialCursor: 10,
                  wake: wake.stream,
                )
                .listen((batch) {
                  if (cancelled) violations.add('delivered after cancel');
                  if (batch.nextCursor < delivered) {
                    violations.add('cursor went back to ${batch.nextCursor}');
                  }
                  delivered = batch.nextCursor;
                  batches.add(batch);
                });

        await done.future.timeout(const Duration(seconds: 5));
        await pumpEventQueue();
        // Every batch the server sent reached the subscriber.
        if (delivered != sent) violations.add('delivered $delivered of $sent');
        cancelled = true;
        await subscription.cancel();
        await wake.close();
        await pumpEventQueue();

        expect(violations, isEmpty, reason: 'seed $seed');
        expect(batches, isNotEmpty);
      });
    }
  });

  group('PortalEventStream (live reporting)', () {
    // CAN-3557: the app shows a reconnecting state from this signal, so it
    // must turn on as soon as the server answers and off only while the
    // subscription is waiting to retry a connection that failed.

    test('reports live once the server primes the SSE stream', () async {
      final body = StreamController<List<int>>();
      final client = MockClient.streaming(
        (request, _) async => http.StreamedResponse(body.stream, 200),
      );
      final live = <bool>[];
      final subscription = _stream(
        client,
      ).subscribe(sessionId: 'sess-1', onLiveChanged: live.add).listen((_) {});
      await pumpEventQueue();
      expect(live, isEmpty);

      body.add(utf8.encode('retry: 1000\n: connected\n\n'));
      await pumpEventQueue();

      expect(live, [true]);
      await subscription.cancel();
      await body.close();
    });

    test('reports not live while a failed connection waits to retry', () async {
      var attempts = 0;
      final held = StreamController<List<int>>()
        ..add(utf8.encode(': connected\n\n'));
      final client = MockClient.streaming((request, _) async {
        attempts += 1;
        return switch (attempts) {
          // Delivered, then dropped: the next attempt decides.
          1 => http.StreamedResponse(
            Stream.value(
              utf8.encode(
                'event: batch\ndata: ${_batchJson(nextCursor: 4)}\n\n',
              ),
            ),
            200,
          ),
          2 => http.StreamedResponse(const Stream.empty(), 503),
          _ => http.StreamedResponse(held.stream, 200),
        };
      });
      final live = <bool>[];
      final subscription = _stream(
        client,
      ).subscribe(sessionId: 'sess-1', onLiveChanged: live.add).listen((_) {});

      await pumpEventQueue();

      expect(attempts, 3);
      expect(live, [true, false, true]);
      await subscription.cancel();
      await held.close();
    });

    test('long-poll reports live per delivered poll', () async {
      var polls = 0;
      final client = MockClient.streaming((request, _) async {
        if (request.url.path.endsWith('/events/stream')) {
          return http.StreamedResponse(const Stream.empty(), 404);
        }
        polls += 1;
        if (polls == 2) return http.StreamedResponse(const Stream.empty(), 503);
        if (polls > 3) {
          return http.StreamedResponse(const Stream.empty(), 404);
        }
        return http.StreamedResponse(
          Stream.value(utf8.encode(_batchJson(nextCursor: polls))),
          200,
        );
      });
      final live = <bool>[];

      await _stream(
        client,
      ).subscribe(sessionId: 'sess-1', onLiveChanged: live.add).toList();

      expect(live, [true, false, true, false]);
    });
  });
}
