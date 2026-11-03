// Attribution of long UI-isolate gaps in a recorded VM timeline (CAN-3372).
// The profile harness records Dart and GC streams while a large snapshot
// arrives; this pairs begin/end events per thread and explains a gap by the
// work that overlapped it: portal parsing and decoding, stop-the-world GC
// (on the UI thread, or started by another isolate such as the decode
// worker, which stops every mutator of the isolate group), or frame work.
// Pure Dart, so the attribution itself is unit tested on the host.

/// Stop-the-world collections. Every mutator in the isolate group, the UI
/// isolate included, is parked while one runs, whichever thread started it.
const stopTheWorldGcEvents = {'CollectNewGeneration', 'CollectOldGeneration'};

/// Portal work the UI isolate runs itself.
const uiPortalSpans = {
  'PortalEventStream.parseChunk',
  'PortalEventDecoder.inline',
};

/// Decode work in the worker isolate.
const workerDecodeSpan = 'PortalEventDecoder.isolate';

/// Marks one profile sample on the UI thread.
const sampleSpan = 'CAN3372.sample';

/// Top-level phases of a frame on the UI thread.
const framePhases = {
  'BUILD',
  'LAYOUT (root)',
  'UPDATING COMPOSITING BITS (root)',
  'PAINT (root)',
  'COMPOSITING',
  'SEMANTICS (root)',
  'FINALIZE TREE',
  'POST_FRAME',
};

const _longTaskMicros = 16000;

final class TimelineInterval {
  const TimelineInterval(
    this.name,
    this.category,
    this.tid,
    this.start,
    this.end,
  );

  final String name;
  final String category;
  final String tid;
  final int start;
  final int end;

  int get duration => end - start;
}

typedef _Range = (int, int);

final class PortalTimeline {
  PortalTimeline._(this.uiThread, this.intervals);

  /// Pairs `B`/`E` events by name and thread (nesting allowed) and keeps
  /// complete `X` events. The UI thread is the one the engine names `*.ui`,
  /// or else the one with the most Dart events.
  factory PortalTimeline.parse(Object? timeline) {
    final intervals = <TimelineInterval>[];
    final open = <String, List<int>>{};
    final threadNames = <String, String>{};
    final dartEvents = <String, int>{};
    if (timeline case {'traceEvents': final List<Object?> events}) {
      for (final event in events) {
        if (event is! Map) continue;
        final tid = '${event['tid']}';
        final name = event['name'];
        final phase = event['ph'];
        if (phase == 'M' && name == 'thread_name') {
          if (event['args'] case {'name': final String threadName}) {
            threadNames[tid] = threadName;
          }
          continue;
        }
        final ts = event['ts'];
        if (name is! String || ts is! int) continue;
        final category = '${event['cat']}';
        if (category == 'Dart') dartEvents[tid] = (dartEvents[tid] ?? 0) + 1;
        switch (phase) {
          case 'X':
            if (event['dur'] case final int duration) {
              intervals.add(
                TimelineInterval(name, category, tid, ts, ts + duration),
              );
            }
          case 'B':
            (open['$category/$name/$tid'] ??= []).add(ts);
          case 'E':
            final begins = open['$category/$name/$tid'];
            if (begins != null && begins.isNotEmpty) {
              intervals.add(
                TimelineInterval(name, category, tid, begins.removeLast(), ts),
              );
            }
        }
      }
    }
    String? ui;
    for (final MapEntry(key: tid, value: threadName) in threadNames.entries) {
      if (RegExp(r'(^|\.)ui( |$)').hasMatch(threadName)) ui = tid;
    }
    if (ui == null && dartEvents.isNotEmpty) {
      ui =
          (dartEvents.entries.toList()
                ..sort((a, b) => b.value.compareTo(a.value)))
              .first
              .key;
    }
    intervals.sort((a, b) => a.start.compareTo(b.start));
    return PortalTimeline._(ui, intervals);
  }

  final String? uiThread;
  final List<TimelineInterval> intervals;

  bool _onUi(TimelineInterval interval) => interval.tid == uiThread;

  Iterable<TimelineInterval> get _stopTheWorld => intervals.where(
    (interval) =>
        interval.category == 'GC' &&
        stopTheWorldGcEvents.contains(interval.name),
  );

  /// Durations of the portal spans and of stop-the-world GC pauses, split
  /// by whether the UI thread or another isolate started the collection.
  Map<String, List<int>> durations() => {
    for (final name in [...uiPortalSpans, workerDecodeSpan])
      name: [
        for (final interval in intervals)
          if (interval.name == name && interval.category == 'Dart')
            interval.duration,
      ],
    'gcPauseUi': [
      for (final interval in _stopTheWorld)
        if (_onUi(interval)) interval.duration,
    ],
    'gcPauseOtherIsolate': [
      for (final interval in _stopTheWorld)
        if (!_onUi(interval)) interval.duration,
    ],
  };

  /// Explains the UI-isolate gap from [start] to [end] (timeline clock).
  ///
  /// `cause` is `portalDecode` when portal work covers more than 16 ms or
  /// half the gap: UI-thread portal spans, collections the decode worker
  /// started while decoding, and UI-thread GC work that overlaps GC work of
  /// the decoding worker. Otherwise it is the largest of UI-thread GC work,
  /// GC started by another isolate, or frame work outside GC when that
  /// covers half the gap; else `unattributed`. Gaps up to 16 ms are `none`.
  Map<String, Object> attribute(int start, int end) {
    final window = [(start, end)];
    int covered(Iterable<TimelineInterval> source) =>
        _length(_intersect(_union(source), window));

    final decodes = [
      for (final interval in intervals)
        if (interval.name == workerDecodeSpan && !_onUi(interval)) interval,
    ];
    bool duringDecode(TimelineInterval gc) => decodes.any(
      (decode) =>
          decode.tid == gc.tid &&
          decode.start < gc.end &&
          gc.start < decode.end,
    );
    // Any GC work on the UI thread (a pause, or VM GC work inside NotifyIdle)
    // keeps the event loop from turning.
    final uiGc = intervals
        .where((interval) => interval.category == 'GC' && _onUi(interval))
        .toList();
    final workerGc = _stopTheWorld.where((gc) => !_onUi(gc)).toList();
    final decodeGc = workerGc.where(duringDecode).toList();
    // GC work the decode worker does while decoding (marking assists,
    // phases of a collection it started) that UI-thread GC work overlaps:
    // the UI waited on the worker's allocation, so it counts as decode cost.
    final decodeGcWork = intervals.where(
      (interval) =>
          interval.category == 'GC' &&
          !_onUi(interval) &&
          duringDecode(interval),
    );
    final coupled = _intersect(_union(uiGc), _union(decodeGcWork));
    final allGc = _union(_stopTheWorld);
    final frames = intervals.where(
      (interval) => _onUi(interval) && framePhases.contains(interval.name),
    );
    final uiPortal = intervals.where(
      (interval) => _onUi(interval) && uiPortalSpans.contains(interval.name),
    );

    final gap = end - start;
    final uiPortalMicros = covered(uiPortal);
    final decodeGcMicros = covered(decodeGc);
    final uiGcMicros = covered(uiGc);
    final otherGcMicros = covered(workerGc) - decodeGcMicros;
    final frameMicros = _length(
      _subtract(_intersect(_union(frames), window), allGc),
    );
    final coupledMicros = _length(_intersect(coupled, window));
    final decodeMicros = _length(
      _intersect(
        _merge([..._union(uiPortal), ..._union(decodeGc), ...coupled]),
        window,
      ),
    );

    String cause;
    if (gap <= _longTaskMicros) {
      cause = 'none';
    } else if (decodeMicros > _longTaskMicros || decodeMicros * 2 >= gap) {
      cause = 'portalDecode';
    } else {
      final candidates = {
        'uiGc': uiGcMicros,
        'otherIsolateGc': otherGcMicros,
        'frame': frameMicros,
      }.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
      cause = candidates.first.value * 2 >= gap
          ? candidates.first.key
          : 'unattributed';
    }

    final overlaps = <String, int>{};
    for (final interval in intervals) {
      final overlap = _length(
        _intersect([(interval.start, interval.end)], window),
      );
      if (overlap < 1000 || interval.name == sampleSpan) continue;
      final key = '${interval.name} (${_onUi(interval) ? 'ui' : 'other'})';
      if (overlap > (overlaps[key] ?? 0)) overlaps[key] = overlap;
    }
    final top = overlaps.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));

    return {
      'gapMs': _ms(gap),
      'cause': cause,
      'uiPortalMs': _ms(uiPortalMicros),
      'gcStartedByDecodeWorkerMs': _ms(decodeGcMicros),
      'uiGcWhileDecodeWorkerGcMs': _ms(coupledMicros),
      'portalDecodeMs': _ms(decodeMicros),
      'uiGcActivityMs': _ms(uiGcMicros),
      'gcStartedByOtherIsolateMs': _ms(otherGcMicros),
      'frameOutsideGcMs': _ms(frameMicros),
      'insideSampleSpan': intervals.any(
        (interval) =>
            interval.name == sampleSpan &&
            _onUi(interval) &&
            interval.start <= start &&
            end <= interval.end,
      ),
      'topOverlapsMs': {
        for (final entry in top.take(8)) entry.key: _ms(entry.value),
      },
    };
  }
}

double _ms(int micros) => micros / 1000;

List<_Range> _union(Iterable<TimelineInterval> source) =>
    _merge([for (final interval in source) (interval.start, interval.end)]);

List<_Range> _merge(List<_Range> source) {
  final ranges = [...source]..sort((a, b) => a.$1.compareTo(b.$1));
  final merged = <_Range>[];
  for (final range in ranges) {
    if (merged.isNotEmpty && range.$1 <= merged.last.$2) {
      final last = merged.removeLast();
      merged.add((last.$1, range.$2 > last.$2 ? range.$2 : last.$2));
    } else {
      merged.add(range);
    }
  }
  return merged;
}

List<_Range> _intersect(List<_Range> a, List<_Range> b) => [
  for (final x in a)
    for (final y in b)
      if ((x.$1 > y.$1 ? x.$1 : y.$1) < (x.$2 < y.$2 ? x.$2 : y.$2))
        (x.$1 > y.$1 ? x.$1 : y.$1, x.$2 < y.$2 ? x.$2 : y.$2),
];

List<_Range> _subtract(List<_Range> a, List<_Range> b) {
  var result = a;
  for (final cut in b) {
    result = [
      for (final range in result) ...[
        if (cut.$2 <= range.$1 || range.$2 <= cut.$1)
          range
        else ...[
          if (range.$1 < cut.$1) (range.$1, cut.$1),
          if (cut.$2 < range.$2) (cut.$2, range.$2),
        ],
      ],
    ];
  }
  return result;
}

int _length(List<_Range> ranges) =>
    ranges.fold(0, (sum, range) => sum + range.$2 - range.$1);
