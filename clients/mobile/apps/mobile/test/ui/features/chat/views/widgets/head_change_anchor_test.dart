import 'package:flutter_test/flutter_test.dart';
import 'package:mobile/ui/core/chat/widgets/head_change_anchor.dart';
import 'package:mobile/ui/core/chat/widgets/head_change_anchor_policy.dart';

void main() {
  const scroll = (
    pixels: 1000.0,
    maxScrollExtent: 2000.0,
    viewportExtent: 600.0,
  );

  void capture(
    HeadChangeAnchor anchor, {
    required List<String> current,
    required List<String> previous,
    required Map<String, AnchorRowLayout> layouts,
    ({double pixels, double maxScrollExtent, double viewportExtent})? at =
        scroll,
  }) => anchor.captureAcrossChange(
    scroll: at,
    currentIds: current,
    previousIds: previous,
    layoutOf: (messageId) => layouts[messageId],
  );

  group('HeadChangeAnchor', () {
    test('captures the reader row and the scroll position', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['older', 'a'],
        previous: ['a'],
        layouts: {'a': (top: 30, height: 100)},
      );
      expect(anchor.messageId, 'a');
      expect(anchor.viewportOffset, 30);
      expect(anchor.pixels, 1000);
      expect(anchor.maxScrollExtent, 2000);
      expect(anchor.version, 1);
      expect(anchor.restoreScheduled, isFalse);
    });

    test('a change during a restore keeps its surviving row and target', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['a', 'b'],
        previous: ['a', 'b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      anchor.restoreScheduled = true;
      // The viewport has not reached the target yet: b sits 50px lower.
      capture(
        anchor,
        current: ['older', 'a', 'b'],
        previous: ['a', 'b'],
        layouts: {'a': (top: -20, height: 60), 'b': (top: 80, height: 100)},
      );
      expect(anchor.messageId, 'b');
      expect(anchor.viewportOffset, 30);
      expect(anchor.pixels, 1050);
      expect(anchor.version, 2);
      expect(anchor.restoreScheduled, isFalse);
    });

    test('a change during a restore keeps its target when unlaid', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      anchor.restoreScheduled = true;
      capture(
        anchor,
        current: ['a', 'b'],
        previous: ['b'],
        layouts: {'a': (top: 0, height: 60)},
      );
      expect(anchor.messageId, 'b');
      expect(anchor.viewportOffset, 30);
      expect(anchor.pixels, 1000);
    });

    test('a change during a restore re-anchors when its row is gone', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      anchor.restoreScheduled = true;
      capture(
        anchor,
        current: ['c'],
        previous: ['b', 'c'],
        layouts: {'c': (top: 200, height: 100)},
      );
      expect(anchor.messageId, 'c');
      expect(anchor.viewportOffset, 200);
      expect(anchor.pixels, 1000);
    });

    test('a finished restore is not resumed', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      capture(
        anchor,
        current: ['a', 'b'],
        previous: ['b'],
        layouts: {'a': (top: 0, height: 60), 'b': (top: 80, height: 100)},
      );
      expect(anchor.messageId, 'a');
      expect(anchor.viewportOffset, 0);
    });

    test('without a scroll position, keeps the last measured offsets', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      capture(
        anchor,
        current: ['a', 'b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
        at: null,
      );
      expect(anchor.messageId, isNull);
      expect(anchor.pixels, 1000);
      expect(anchor.maxScrollExtent, 2000);
    });

    test('clear drops the anchor and stops a restore in flight', () {
      final anchor = HeadChangeAnchor();
      capture(
        anchor,
        current: ['b'],
        previous: ['b'],
        layouts: {'b': (top: 30, height: 100)},
      );
      anchor.restoreScheduled = true;
      anchor.clear();
      expect(anchor.messageId, isNull);
      expect(anchor.viewportOffset, isNull);
      expect(anchor.pixels, isNull);
      expect(anchor.maxScrollExtent, isNull);
      expect(anchor.restoreScheduled, isFalse);
      expect(anchor.version, 2);
    });
  });
}
