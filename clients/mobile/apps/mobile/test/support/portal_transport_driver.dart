// Device-harness transport for CAN-3372. Serves synthetic Portal event
// bytes to the real `PortalEventStream` (SSE, or long-poll behind a forced
// SSE 404) and forwards every batch it emits into a
// `FakeRemoteControlRepository`, so the real view model and chat screen
// receive what production parsing and decoding produced, in the app process.
// Uses only the transport's public API, so it runs on trees before and after
// the CAN-3372 change.
import 'dart:async';
import 'dart:convert';
import 'dart:developer';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_event_stream.dart';

import 'fake_remote_control_repository.dart';
import 'portal_event_workloads.dart';

/// Records the gaps between event-loop turns on the calling (UI) isolate.
/// The largest gap bounds the longest synchronous task that ran.
/// [longestGapStart] and [longestGapEnd] place that gap on the timeline
/// clock ([Timeline.now]), so it can be matched against trace events.
final class EventLoopHeartbeat {
  final _gaps = <int>[];
  final _clock = Stopwatch();
  var _running = false;
  var _last = 0;
  var _lastStamp = 0;
  var _longest = -1;

  /// Timeline-clock microseconds at which the longest gap began and ended.
  int longestGapStart = 0;
  int longestGapEnd = 0;

  void start() {
    _running = true;
    _clock.start();
    unawaited(_beat());
  }

  Future<void> _beat() async {
    _last = _clock.elapsedMicroseconds;
    _lastStamp = Timeline.now;
    while (_running) {
      await Future<void>.delayed(Duration.zero);
      if (!_running) return;
      _record();
    }
  }

  void _record() {
    final now = _clock.elapsedMicroseconds;
    final stamp = Timeline.now;
    final gap = now - _last;
    _gaps.add(gap);
    if (gap > _longest) {
      _longest = gap;
      longestGapStart = _lastStamp;
      longestGapEnd = stamp;
    }
    _last = now;
    _lastStamp = stamp;
  }

  /// Stops, counting the gap still in flight.
  List<int> stop() {
    _running = false;
    _record();
    return List.unmodifiable(_gaps);
  }
}

/// One subscription's outcome.
final class PortalDelivery {
  const PortalDelivery({required this.elapsed, required this.batches});

  /// First byte offered to the transport until the awaited batch arrived.
  final Duration elapsed;
  final List<RemotePortalEventBatch> batches;
}

/// The server side of one event-stream response: bytes and frames added
/// here reach the client's SSE parser, in order. [onCancel] runs when the
/// client stops reading, for example when it closes its client.
final class PortalSseResponse {
  PortalSseResponse({void Function()? onCancel}) {
    _body.onCancel = () {
      _closed = true;
      onCancel?.call();
    };
  }

  final _body = StreamController<List<int>>();
  var _closed = false;

  /// The 200 `text/event-stream` response to hand the client.
  http.StreamedResponse get response => http.StreamedResponse(
    _body.stream,
    200,
    headers: const {'content-type': 'text/event-stream'},
  );

  bool get isOpen => !_closed;

  void add(List<int> bytes) {
    if (!_closed) _body.add(bytes);
  }

  void write(String text) => add(utf8.encode(text));

  /// Ends the response, as the server does after an inactive batch.
  Future<void> close() {
    _closed = true;
    return _body.close();
  }
}

final class PortalTransportDriver {
  PortalTransportDriver(this.repository);

  final FakeRemoteControlRepository repository;

  static const _base = 'https://device.test/api/v1/desktop-app/portal/browser';

  PortalEventStream _stream(http.Client client) => PortalEventStream(
    baseUrl: _base,
    headersProvider: () => const {},
    clientFactory: () => client,
    retryDelay: Duration.zero,
    wait: (_) async {},
  );

  /// Streams [text] over one SSE connection in [chunkBytes]-byte network
  /// chunks (`null` = one chunk), [pace] apart, and waits for the batch
  /// carrying [untilCursor]. Every emitted batch reaches the repository.
  Future<PortalDelivery> sse(
    String text, {
    required int untilCursor,
    int? chunkBytes,
    Duration pace = Duration.zero,
  }) async {
    final bytes = utf8.encode(text);
    final body = PortalSseResponse();
    final connected = Completer<void>();
    final client = MockClient.streaming((request, _) async {
      if (connected.isCompleted) {
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      }
      connected.complete();
      return body.response;
    });
    final batches = <RemotePortalEventBatch>[];
    final arrived = Completer<void>();
    final subscription = _stream(client).subscribe(sessionId: 'device').listen((
      batch,
    ) {
      batches.add(batch);
      repository.eventsController.add(batch);
      if (batch.nextCursor == untilCursor && !arrived.isCompleted) {
        arrived.complete();
      }
    });
    await connected.future;
    await Future<void>.delayed(Duration.zero);
    final clock = Stopwatch()..start();
    final size = chunkBytes ?? bytes.length;
    for (var start = 0; start < bytes.length; start += size) {
      final end = start + size > bytes.length ? bytes.length : start + size;
      body.add(bytes.sublist(start, end));
      await Future<void>.delayed(pace);
    }
    await arrived.future.timeout(const Duration(minutes: 2));
    final elapsed = clock.elapsed;
    await subscription.cancel();
    await body.close();
    return PortalDelivery(elapsed: elapsed, batches: batches);
  }

  /// Answers the SSE route with 404 and the first long-poll with [body].
  Future<PortalDelivery> longPoll(String body) async {
    final bytes = utf8.encode(body);
    final clock = Stopwatch();
    var polls = 0;
    final client = MockClient.streaming((request, _) async {
      if (request.url.path.endsWith('/events/stream')) {
        return http.StreamedResponse(const Stream.empty(), 404);
      }
      polls += 1;
      if (polls > 1) {
        return http.StreamedResponse(StreamController<List<int>>().stream, 200);
      }
      clock.start();
      return http.StreamedResponse(
        Stream.value(bytes),
        200,
        headers: const {'content-type': 'application/json'},
      );
    });
    final batches = <RemotePortalEventBatch>[];
    final arrived = Completer<void>();
    final subscription = _stream(client).subscribe(sessionId: 'device').listen((
      batch,
    ) {
      batches.add(batch);
      repository.eventsController.add(batch);
      if (!arrived.isCompleted) arrived.complete();
    });
    await arrived.future.timeout(const Duration(minutes: 2));
    final elapsed = clock.elapsed;
    await subscription.cancel();
    return PortalDelivery(elapsed: elapsed, batches: batches);
  }

  /// Opens SSE, offers a large [frame], lets one event-loop turn pass and
  /// cancels. Returns the batches observed after the cancellation, which must
  /// stay empty however long the decode takes.
  Future<List<RemotePortalEventBatch>> cancelDuringDecode(
    String frame, {
    Duration settle = const Duration(seconds: 2),
  }) async {
    final body = PortalSseResponse();
    final client = MockClient.streaming((request, _) async => body.response);
    final late = <RemotePortalEventBatch>[];
    var cancelled = false;
    final subscription = _stream(client).subscribe(sessionId: 'device').listen((
      batch,
    ) {
      if (cancelled) late.add(batch);
      repository.eventsController.add(batch);
    });
    await Future<void>.delayed(const Duration(milliseconds: 50));
    body.write(frame);
    await Future<void>.delayed(Duration.zero);
    cancelled = true;
    await subscription.cancel();
    await Future<void>.delayed(settle);
    await body.close();
    return late;
  }
}

/// The ticket's chat snapshot workloads by evidence name. Each delivery
/// uses its own [cursor] so the store applies every sample afresh.
String portalDeviceSnapshot(String workload, int cursor) => switch (workload) {
  'snapshot600KiB' => chatSnapshotBatchJson(
    targetChars: snapshot600KiBChars,
    nextCursor: cursor,
  ),
  'snapshotNearCap' => chatSnapshotBatchJson(
    targetChars: kMaxPortalSseBufferChars - 128,
    nextCursor: cursor,
    spreadPadding: true,
  ),
  _ => throw ArgumentError.value(workload, 'workload'),
};
