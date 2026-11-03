// Host benchmark for the Portal event transport (CAN-3372).
//
// Drives the real `PortalEventStream` through a synthetic streaming HTTP
// client and reports, per workload, the delivery time and the longest
// synchronous task the calling isolate ran (measured as the largest gap in
// an event-loop heartbeat). It also times the decode pieces in isolation
// (UTF-8 conversion, `jsonDecode`, model mapping, `Isolate.run` handoff) to
// locate the inline/off-isolate crossover. It uses only APIs that exist both
// before and after the CAN-3372 change, so the same source measures both
// trees. Run from apps/mobile:
//
//   dart run tool/portal_event_benchmark.dart --stage=after \
//     --output=/absolute/path/metrics.json [--samples=20] [--warmups=5]
//
// Or compile ahead-of-time for numbers closer to a release build:
//
//   dart compile exe tool/portal_event_benchmark.dart -o /tmp/portal_bench
//
// Host numbers are not device numbers; they compare trees on one machine.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mobile/data/models/remote_portal_event.dart';
import 'package:mobile/data/services/portal_event_stream.dart';

import '../test/support/portal_event_workloads.dart';

const _kib = 1024;

/// JSON payload of the largest batch frame the SSE cap still accepts, with
/// headroom for the `event:`/`data:` framing.
const _nearCapJsonChars = kMaxPortalSseBufferChars - 128;

/// Payload characters of the largest inert frame under the cap.
const _nearCapInertChars = kMaxPortalSseBufferChars - 64;

const _threshold = 64 * _kib;

Future<void> main(List<String> arguments) async {
  final options = _parseOptions(arguments);
  final stage = options['stage'];
  final output = options['output'];
  if (stage == null || output == null || !File(output).isAbsolute) {
    stderr.writeln(
      'Usage: portal_event_benchmark.dart --stage=<before|after> '
      '--output=<absolute path> [--samples=N] [--warmups=N]',
    );
    exitCode = 64;
    return;
  }
  final samples = int.parse(options['samples'] ?? '20');
  final warmups = int.parse(options['warmups'] ?? '5');

  final cases = <Map<String, Object?>>[];
  Future<void> add(String name, Future<_Sample> Function() run) async {
    stdout.writeln('case $name');
    for (var i = 0; i < warmups; i++) {
      await run();
    }
    final runs = <_Sample>[];
    final rssBefore = ProcessInfo.currentRss;
    for (var i = 0; i < samples; i++) {
      runs.add(await run());
    }
    cases.add({
      'name': name,
      ...runs.first.parameters,
      'samples': runs.length,
      'warmups': warmups,
      'rssDeltaBytes': ProcessInfo.currentRss - rssBefore,
      for (final metric in runs.first.metrics.keys)
        metric: _stats([for (final run in runs) run.metrics[metric]!]),
    });
  }

  // Parser linearity: inert frames (parsed, never decoded) in fixed 1 KiB
  // network chunks, then the near-cap frame at 16 KiB and coalesced.
  for (final chars in [256 * _kib, 512 * _kib, _nearCapInertChars]) {
    await add(
      'sse-inert-${chars ~/ _kib}KiB-chunk1KiB',
      () => _sseSample(inertSseFrame(chars), chunkBytes: _kib),
    );
  }
  await add(
    'sse-inert-nearcap-chunk16KiB',
    () => _sseSample(inertSseFrame(_nearCapInertChars), chunkBytes: 16 * _kib),
  );
  await add(
    'sse-inert-nearcap-coalesced',
    () => _sseSample(inertSseFrame(_nearCapInertChars), chunkBytes: null),
  );
  // Many completed frames in one input: 512 small batches in one chunk.
  await add('sse-512-small-frames-coalesced', () {
    final frames = StringBuffer();
    for (var i = 1; i <= 512; i++) {
      frames.write(sseFrame(streamingMessageBatchJson(nextCursor: i)));
    }
    return _sseSample(frames.toString(), chunkBytes: null, cursor: 512);
  });

  // Batch decode around the threshold and at the ticket's sizes.
  final snapshot600 = chatSnapshotBatchJson(targetChars: snapshot600KiBChars);
  final nearCap = chatSnapshotBatchJson(targetChars: _nearCapJsonChars);
  final thresholdCases = {
    'threshold-minus1': chatSnapshotBatchJson(
      messages: 24,
      targetChars: _threshold - 1,
    ),
    'threshold': chatSnapshotBatchJson(messages: 24, targetChars: _threshold),
    'threshold-plus1': chatSnapshotBatchJson(
      messages: 24,
      targetChars: _threshold + 1,
    ),
  };
  for (final entry in thresholdCases.entries) {
    await add(
      'sse-batch-${entry.key}-coalesced',
      () => _sseSample(sseFrame(entry.value), chunkBytes: null, cursor: 100),
    );
  }
  for (final entry in {'600KiB': snapshot600, 'nearcap': nearCap}.entries) {
    for (final chunk in [_kib, 16 * _kib, null]) {
      final label = chunk == null ? 'coalesced' : 'chunk${chunk ~/ _kib}KiB';
      await add(
        'sse-batch-${entry.key}-$label',
        () => _sseSample(sseFrame(entry.value), chunkBytes: chunk, cursor: 100),
      );
    }
  }

  // Long-poll bodies of the same sizes.
  for (final entry in {
    ...thresholdCases,
    '600KiB': snapshot600,
    'nearcap': nearCap,
  }.entries) {
    await add('longpoll-${entry.key}', () => _pollSample(entry.value));
  }

  // Decode pieces, independent of the transport.
  for (final entry in {
    ...thresholdCases,
    '600KiB': snapshot600,
    'nearcap': nearCap,
  }.entries) {
    await add('decode-${entry.key}', () => _decodeSample(entry.value));
  }

  final report = {
    'ticket': 'CAN-3372',
    'stage': stage,
    'dartVersion': Platform.version,
    'os': Platform.operatingSystem,
    'osVersion': Platform.operatingSystemVersion,
    'processors': Platform.numberOfProcessors,
    'compilation': const bool.fromEnvironment('dart.vm.product')
        ? 'aot-product'
        : 'jit',
    'sseCapChars': kMaxPortalSseBufferChars,
    'thresholdChars': _threshold,
    'samples': samples,
    'warmups': warmups,
    'cases': cases,
  };
  final file = File(output);
  await file.parent.create(recursive: true);
  await file.writeAsString(const JsonEncoder.withIndent('  ').convert(report));
  stdout.writeln('wrote $output');
  // Idle sockets/isolates must not keep the benchmark alive.
  exit(0);
}

Map<String, String> _parseOptions(List<String> arguments) => {
  for (final argument in arguments)
    if (argument.startsWith('--') && argument.contains('='))
      argument.substring(2, argument.indexOf('=')): argument.substring(
        argument.indexOf('=') + 1,
      ),
};

final class _Sample {
  _Sample(this.parameters, this.metrics);

  final Map<String, Object?> parameters;
  final Map<String, double> metrics;
}

/// Records the gaps between event-loop turns. The largest gap bounds the
/// longest synchronous task (plus timer overhead) run on this isolate.
final class _Heartbeat {
  final _gaps = <int>[];
  final _clock = Stopwatch();
  var _running = false;

  void start() {
    _running = true;
    _clock.start();
    unawaited(_beat());
  }

  var _last = 0;

  Future<void> _beat() async {
    _last = _clock.elapsedMicroseconds;
    while (_running) {
      await Future<void>.delayed(Duration.zero);
      if (!_running) return;
      final now = _clock.elapsedMicroseconds;
      _gaps.add(now - _last);
      _last = now;
    }
  }

  /// Stops after recording the in-flight gap: delivery is observed in a
  /// microtask of the task that did the work, before the next beat runs.
  Map<String, double> stop() {
    _running = false;
    _gaps.add(_clock.elapsedMicroseconds - _last);
    final max = _gaps.isEmpty ? 0 : _gaps.reduce((a, b) => a > b ? a : b);
    return {
      'maxTaskMs': max / 1000,
      'tasksOver16Ms': _gaps.where((gap) => gap > 16000).length.toDouble(),
      'tasksOver8Ms': _gaps.where((gap) => gap > 8000).length.toDouble(),
    };
  }
}

PortalEventStream _stream(http.Client client) => PortalEventStream(
  baseUrl: 'https://bench.test/api/v1/desktop-app/portal/browser',
  headersProvider: () => const {},
  clientFactory: () => client,
  retryDelay: Duration.zero,
  wait: (_) async {},
);

/// Delivers [text] over one SSE response in [chunkBytes]-byte network
/// chunks (`null` = one chunk) with an event-loop turn between chunks. A
/// small sentinel batch follows inert frames to mark completion.
Future<_Sample> _sseSample(
  String text, {
  required int? chunkBytes,
  int? cursor,
}) async {
  const sentinelCursor = 9999;
  final payload = cursor == null
      ? text + sseFrame(streamingMessageBatchJson(nextCursor: sentinelCursor))
      : text;
  final expectedCursor = cursor ?? sentinelCursor;
  final bytes = utf8.encode(payload);
  final chunks = <List<int>>[
    if (chunkBytes == null)
      bytes
    else
      for (var start = 0; start < bytes.length; start += chunkBytes)
        bytes.sublist(
          start,
          start + chunkBytes > bytes.length ? bytes.length : start + chunkBytes,
        ),
  ];

  final body = StreamController<List<int>>();
  final connected = Completer<void>();
  final client = MockClient.streaming((request, _) async {
    if (!request.url.path.endsWith('/events/stream')) {
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    }
    if (connected.isCompleted) {
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    }
    connected.complete();
    return http.StreamedResponse(body.stream, 200);
  });
  final delivered = Completer<void>();
  final subscription = _stream(client).subscribe(sessionId: 'bench').listen((
    batch,
  ) {
    if (batch.nextCursor == expectedCursor && !delivered.isCompleted) {
      delivered.complete();
    }
  });
  await connected.future;
  await Future<void>.delayed(Duration.zero);

  final heartbeat = _Heartbeat()..start();
  final clock = Stopwatch()..start();
  for (final chunk in chunks) {
    body.add(chunk);
    await Future<void>.delayed(Duration.zero);
  }
  await delivered.future;
  final deliveryMs = clock.elapsedMicroseconds / 1000;
  final blocking = heartbeat.stop();
  await subscription.cancel();
  await body.close();
  return _Sample(
    {
      'transport': 'sse',
      'frameChars': payload.length,
      'frameUtf8Bytes': bytes.length,
      'chunkBytes': chunkBytes,
      'chunks': chunks.length,
    },
    {'deliveryMs': deliveryMs, ...blocking},
  );
}

/// Forces the long-poll fallback (SSE 404) and returns [json] as one body.
Future<_Sample> _pollSample(String json) async {
  final bytes = utf8.encode(json);
  final clock = Stopwatch();
  var polls = 0;
  final heartbeat = _Heartbeat();
  final client = MockClient.streaming((request, _) async {
    if (request.url.path.endsWith('/events/stream')) {
      return http.StreamedResponse(const Stream.empty(), 404);
    }
    polls += 1;
    if (polls > 1) {
      return http.StreamedResponse(StreamController<List<int>>().stream, 200);
    }
    heartbeat.start();
    clock.start();
    return http.StreamedResponse(
      Stream.value(bytes),
      200,
      headers: const {'content-type': 'application/json'},
    );
  });
  final delivered = Completer<void>();
  final subscription = _stream(client).subscribe(sessionId: 'bench').listen((
    batch,
  ) {
    if (!delivered.isCompleted) delivered.complete();
  });
  await delivered.future;
  final deliveryMs = clock.elapsedMicroseconds / 1000;
  final blocking = heartbeat.stop();
  await subscription.cancel();
  return _Sample(
    {
      'transport': 'longpoll',
      'bodyChars': json.length,
      'bodyUtf8Bytes': bytes.length,
    },
    {'deliveryMs': deliveryMs, ...blocking},
  );
}

RemotePortalEventBatch _decodeAndMap(String json) =>
    RemotePortalEventBatch.fromJson(jsonDecode(json) as Map<String, dynamic>);

Future<RemotePortalEventBatch> _offIsolateModels(String json) =>
    Isolate.run(() => _decodeAndMap(json));

Future<Object?> _offIsolateMaps(String json) =>
    Isolate.run(() => jsonDecode(json));

Future<int> _offIsolateNoop() => Isolate.run(() => 0);

Future<_Sample> _decodeSample(String json) async {
  final bytes = utf8.encode(json);
  final clock = Stopwatch()..start();
  utf8.decode(bytes);
  final utf8Ms = clock.elapsedMicroseconds / 1000;

  clock.reset();
  final decoded = jsonDecode(json) as Map<String, dynamic>;
  final jsonDecodeMs = clock.elapsedMicroseconds / 1000;

  clock.reset();
  RemotePortalEventBatch.fromJson(decoded);
  final mapMs = clock.elapsedMicroseconds / 1000;

  clock.reset();
  await _offIsolateNoop();
  final isolateSpawnMs = clock.elapsedMicroseconds / 1000;

  clock.reset();
  await _offIsolateMaps(json);
  final isolateMapsMs = clock.elapsedMicroseconds / 1000;

  clock.reset();
  await _offIsolateModels(json);
  final isolateModelsMs = clock.elapsedMicroseconds / 1000;

  return _Sample(
    {'payloadChars': json.length, 'payloadUtf8Bytes': bytes.length},
    {
      'utf8DecodeMs': utf8Ms,
      'jsonDecodeMs': jsonDecodeMs,
      'modelMapMs': mapMs,
      'inlineTotalMs': jsonDecodeMs + mapMs,
      'isolateNoopRoundTripMs': isolateSpawnMs,
      'isolateDecodeToMapsRoundTripMs': isolateMapsMs,
      'isolateDecodeAndMapRoundTripMs': isolateModelsMs,
    },
  );
}

Map<String, double> _stats(List<double> values) {
  final sorted = [...values]..sort();
  double at(double fraction) =>
      sorted[((sorted.length - 1) * fraction).round()];
  return {
    'min': sorted.first,
    'p50': at(0.5),
    'p90': at(0.9),
    'max': sorted.last,
    'mean': sorted.reduce((a, b) => a + b) / sorted.length,
  };
}
