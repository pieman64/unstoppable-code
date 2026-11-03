import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

/// The scroll position one frame painted, read before the feed's own
/// post-frame work can move it.
typedef PaintedScrollFrame = ({
  double pixels,
  double maxScrollExtent,
  bool scrolling,
});

/// Every frame painted after a change, and the scroll activities that
/// started meanwhile.
typedef PaintedScrollRecording = ({
  List<PaintedScrollFrame> frames,
  int scrollStarts,
});

/// Applies [change], then records the position every frame paints for
/// [frames] frames. The sampler re-registers itself ahead of the feed's own
/// post-frame callbacks, so a position the feed corrects only after painting
/// still shows.
Future<PaintedScrollRecording> recordPaintedScrollFrames(
  WidgetTester tester,
  ScrollPosition position,
  Future<void> Function() change, {
  int frames = 60,
}) async {
  final painted = <PaintedScrollFrame>[];
  var scrollStarts = 0;
  void countStart() {
    if (position.isScrollingNotifier.value) scrollStarts += 1;
  }

  var recording = true;
  void sample(Duration _) {
    if (!recording) return;
    painted.add((
      pixels: position.pixels,
      maxScrollExtent: position.maxScrollExtent,
      scrolling: position.isScrollingNotifier.value,
    ));
    tester.binding.addPostFrameCallback(sample);
  }

  position.isScrollingNotifier.addListener(countStart);
  tester.binding.addPostFrameCallback(sample);
  try {
    await change();
    for (var frame = 0; frame < frames; frame++) {
      // Paint every interval, not only those something scheduled, so a
      // position left stranded between frames still shows up.
      tester.binding.scheduleFrame();
      await tester.pump(const Duration(milliseconds: 16));
    }
  } finally {
    recording = false;
    position.isScrollingNotifier.removeListener(countStart);
  }
  return (frames: painted, scrollStarts: scrollStarts);
}

/// Expects at least 60 painted frames, each within 1px of the newest
/// content, with no scroll activity running or started.
void expectEveryFrameOnNewest(PaintedScrollRecording recorded) {
  expect(recorded.frames, hasLength(greaterThanOrEqualTo(60)));
  for (final (index, frame) in recorded.frames.indexed) {
    expect(
      frame.maxScrollExtent - frame.pixels,
      moreOrLessEquals(0, epsilon: 1),
      reason:
          'frame $index painted ${frame.pixels} of '
          '${frame.maxScrollExtent}, off the newest content',
    );
    expect(
      frame.scrolling,
      isFalse,
      reason: 'frame $index ran a corrective scroll activity',
    );
  }
  expect(recorded.scrollStarts, 0, reason: 'a scroll activity started');
}
