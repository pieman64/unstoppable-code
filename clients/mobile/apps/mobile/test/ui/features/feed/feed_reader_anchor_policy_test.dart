import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/data/protocol/generated/feed.dart';
import 'package:mobile/ui/features/feed/views/feed_reader_anchor_policy.dart';

FeedItem _row(String id, {String occurredAt = '2026-08-01T10:00:00.000Z'}) =>
    WorktreeUpdatedFeedItem(
      actor: FeedActor(displayName: 'Brady Example', userId: 'user-1'),
      id: id,
      occurredAt: occurredAt,
      branchName: 'feature/$id',
    );

void main() {
  final a = _row('a');
  final b = _row('b');
  final c = _row('c');

  /// The anchor for rows measured at [reveals], 100 pixels down a list whose
  /// content starts below a 50-pixel app bar.
  FeedReaderAnchor? anchor({
    List<FeedItem>? shown,
    List<FeedItem>? current,
    String? start,
    double pixels = 100,
    double minScrollExtent = 0,
    double top = 50,
    Map<String, double> reveals = const {'a': 120, 'b': 180, 'c': 240},
    List<String>? measured,
  }) => feedReaderAnchor(
    shown: shown ?? [a, b, c],
    current: current ?? [a, b, c],
    start: start,
    pixels: pixels,
    minScrollExtent: minScrollExtent,
    top: top,
    revealOffsetOf: (id) {
      measured?.add(id);
      return reveals[id];
    },
  );

  group('feedReaderAnchor', () {
    test('starts at the first shown row the reader sees in full', () {
      // a is 20 pixels down the viewport, under the 50-pixel app bar.
      expect(anchor(), (start: 'b', correction: -180));
    });

    test('counts a row whose top meets the app bar as seen in full', () {
      expect(anchor(reveals: {'a': 150, 'b': 180}), (
        start: 'a',
        correction: -150,
      ));
    });

    test('keeps the start when the reader is still on it', () {
      expect(anchor(start: 'b'), isNull);
    });

    test('moves from an earlier start to the reader\'s row', () {
      expect(anchor(start: 'a'), (start: 'b', correction: -180));
    });

    test('follows the shown order, not the current order', () {
      expect(
        anchor(shown: [c, b, a], reveals: {'c': 160, 'b': 220, 'a': 280}),
        (start: 'c', correction: -160),
      );
    });

    test('skips a row whose occurredAt changed', () {
      final movedB = _row('b', occurredAt: '2026-10-01T10:00:00.000Z');
      expect(anchor(current: [movedB, a, c]), (start: 'c', correction: -240));
    });

    test('skips a row the view model no longer holds', () {
      expect(anchor(current: [a, c]), (start: 'c', correction: -240));
    });

    test('ignores new rows the list has not shown yet', () {
      final fresh = _row('fresh');
      expect(
        anchor(current: [fresh, a, b, c], reveals: {'fresh': 160, 'b': 180}),
        (start: 'b', correction: -180),
      );
    });

    test('skips rows without a measurement', () {
      expect(anchor(reveals: {'c': 240}), (start: 'c', correction: -240));
    });

    test('measures only unchanged rows, up to the reader\'s row', () {
      final d = _row('d');
      final measured = <String>[];
      expect(
        anchor(
          shown: [a, b, c, d],
          current: [a, c, d],
          reveals: {'a': 120, 'b': 180, 'c': 240, 'd': 300},
          measured: measured,
        ),
        (start: 'c', correction: -240),
      );
      expect(measured, ['a', 'c']);
    });

    group('at the top', () {
      test('starts at the header again', () {
        expect(anchor(start: 'b', pixels: 0), (start: null, correction: 0));
      });

      test('undoes the extent above the start', () {
        // Rows above the start lay out upward, so the minimum is negative.
        expect(anchor(start: 'b', pixels: -400, minScrollExtent: -400), (
          start: null,
          correction: 400,
        ));
      });

      test('leaves a header start alone', () {
        expect(anchor(pixels: 0), isNull);
      });
    });

    group('when no row qualifies', () {
      const offscreen = <String, double>{'a': 20, 'b': 60, 'c': 140};

      test('starts at the header when the start is gone', () {
        expect(
          anchor(
            current: [b, c],
            start: 'a',
            minScrollExtent: -300,
            reveals: offscreen,
          ),
          (start: null, correction: 300),
        );
      });

      test('keeps a start the view model still holds', () {
        expect(anchor(start: 'a', reveals: offscreen), isNull);
      });

      test('keeps the header start', () {
        expect(anchor(reveals: offscreen), isNull);
      });
    });
  });
}
