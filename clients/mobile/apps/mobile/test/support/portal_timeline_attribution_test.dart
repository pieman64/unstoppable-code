import 'package:flutter_test/flutter_test.dart';

import 'portal_timeline_attribution.dart';

const _ui = 1;
const _worker = 2;

Map<String, Object> _thread(int tid, String name) => {
  'ph': 'M',
  'name': 'thread_name',
  'tid': tid,
  'args': {'name': '$name ($tid)'},
};

List<Map<String, Object>> _span(
  String name,
  String category,
  int tid,
  int startMs,
  int endMs,
) => [
  {'name': name, 'cat': category, 'ph': 'B', 'tid': tid, 'ts': startMs * 1000},
  {'name': name, 'cat': category, 'ph': 'E', 'tid': tid, 'ts': endMs * 1000},
];

Map<String, Object> _timeline(List<Object> events) => {
  'traceEvents': [
    _thread(9, 'DartWorker'),
    _thread(_ui, '1.ui'),
    _thread(_worker, 'DartWorker'),
    ...events,
  ],
};

Map<String, Object> _attribute(
  PortalTimeline timeline,
  int startMs,
  int endMs,
) => timeline.attribute(startMs * 1000, endMs * 1000);

void main() {
  test('pairs begin/end GC events per thread and keeps the UI separate', () {
    final timeline = PortalTimeline.parse(
      _timeline([
        ..._span('CollectOldGeneration', 'GC', _ui, 0, 20),
        // Nested phase of the same collection, not a pause of its own.
        ..._span('ParallelMark', 'GC', _ui, 2, 18),
        ..._span('CollectNewGeneration', 'GC', _worker, 30, 34),
        ..._span('CollectOldGeneration', 'GC', _worker, 40, 115),
        // Concurrent marking runs beside the mutators and is not a pause.
        ..._span('ConcurrentMark', 'GC', _worker, 120, 160),
      ]),
    );

    expect(timeline.uiThread, '$_ui');
    final durations = timeline.durations();
    expect(durations['gcPauseUi'], [20000]);
    expect(durations['gcPauseOtherIsolate'], [4000, 75000]);
  });

  test('a collection the decode worker starts mid-decode is portal work', () {
    final timeline = PortalTimeline.parse(
      _timeline([
        ..._span(sampleSpan, 'Dart', _ui, 0, 500),
        ..._span(workerDecodeSpan, 'Dart', _worker, 100, 190),
        ..._span('CollectOldGeneration', 'GC', _worker, 105, 180),
      ]),
    );

    final sample = _attribute(timeline, 102, 185);

    expect(sample['cause'], 'portalDecode');
    expect(sample['gcStartedByDecodeWorkerMs'], 75);
    expect(sample['insideSampleSpan'], isTrue);
    expect(timeline.durations()[workerDecodeSpan], [90000]);
  });

  test('UI GC work that waits on the decoding worker is portal work', () {
    final timeline = PortalTimeline.parse(
      _timeline([
        ..._span(workerDecodeSpan, 'Dart', _worker, 100, 160),
        ..._span('IncrementalMarkWithSizeBudget', 'GC', _worker, 105, 150),
        ..._span('NotifyIdle', 'GC', _ui, 104, 151),
        // The same UI GC work with no decode in flight is the UI's own.
        ..._span('IncrementalMarkWithSizeBudget', 'GC', _worker, 300, 345),
        ..._span('NotifyIdle', 'GC', _ui, 300, 345),
      ]),
    );

    final coupled = _attribute(timeline, 103, 152);
    expect(coupled['cause'], 'portalDecode');
    expect(coupled['uiGcWhileDecodeWorkerGcMs'], 45);
    expect(_attribute(timeline, 299, 346)['cause'], 'uiGc');
  });

  test('UI-started GC, frame work and UI portal spans are told apart', () {
    final timeline = PortalTimeline.parse(
      _timeline([
        ..._span('PAINT (root)', 'Dart', _ui, 0, 80),
        ..._span('CollectOldGeneration', 'GC', _ui, 10, 70),
        ..._span('BUILD', 'Dart', _ui, 200, 260),
        ..._span('PortalEventStream.parseChunk', 'Dart', _ui, 300, 330),
        ..._span('CollectOldGeneration', 'GC', _worker, 400, 450),
      ]),
    );

    final gcInsidePaint = _attribute(timeline, 0, 80);
    expect(gcInsidePaint['cause'], 'uiGc');
    expect(gcInsidePaint['uiGcActivityMs'], 60);
    expect(gcInsidePaint['frameOutsideGcMs'], 20);

    expect(_attribute(timeline, 200, 260)['cause'], 'frame');
    expect(_attribute(timeline, 300, 330)['cause'], 'portalDecode');
    // No decode span was open, so the worker GC is not the decoder's.
    expect(_attribute(timeline, 400, 450)['cause'], 'otherIsolateGc');
    expect(_attribute(timeline, 500, 540)['cause'], 'unattributed');
    expect(_attribute(timeline, 500, 510)['cause'], 'none');
  });
}
